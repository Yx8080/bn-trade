import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createLocalOrderDb } from '../worker/local-orders.js'
import { createCopyService } from './copy-service.js'

const user = { id: 'viewer', name: 'viewer', token: 'mock', apiKey: 'derivative', apiSecret: 'test',
  spotApiKey: 'cash', spotApiSecret: 'spot-test' }
const hash = key => createHash('sha256').update(key).digest('hex')
const tracked = '90071992547409931'
const direct = '90071992547409932'
const legacy = '90071992547409933'
const unknown = '90071992547409934'
const manual = '90071992547409935'

test('exchange activity matches verified platform IDs, keeps legacy orders out and never imports external fills into SQLite', async t => {
  const path = join(tmpdir(), 'bn-external-' + randomUUID() + '.db')
  const db = createLocalOrderDb(path)
  const sql = new DatabaseSync(path)
  const signed = []
  const fill = (order, spot) => ({ id: JSON.rawJSON(order), orderId: JSON.rawJSON(order), symbol: 'BTCUSDT',
    side: 'BUY', isBuyer: true, positionSide: 'BOTH', realizedPnl: '3', marginAsset: 'USDT', price: '100',
    commission: '0.1', commissionAsset: 'BNB', qty: '1', time: spot ? 123321 : 123456 })
  const env = { orderStore: db, BINANCE_FUTURES_USERS: JSON.stringify([user]), fetchBinance: (url, init) => {
    assert.equal(init.method, 'GET')
    const spot = url.origin === 'https://testnet.binance.vision'
    assert.equal(init.headers.get('X-MBX-APIKEY'), spot ? user.spotApiKey : user.apiKey)
    signed.push(url.pathname)
    if (url.pathname.endsWith('/account')) return Response.json({ balances: [{ asset: 'BTC', free: '1', locked: '2' }] })
    if (url.pathname.endsWith('/positionRisk')) {
      assert.equal(url.searchParams.has('symbol'), false)
      return Response.json([{ symbol: 'ETHUSDT', positionSide: 'SHORT', positionAmt: '-2', entryPrice: '7',
        markPrice: '6', updateTime: 123, unRealizedProfit: '2', marginAsset: 'USDT' }])
    }
    assert.equal(url.searchParams.get('symbol'), 'BTCUSDT')
    if (url.pathname.endsWith('/allOrders')) return Response.json([
      { symbol: 'BTCUSDT', orderId: direct, clientOrderId: 'reused-by-exchange', side: 'BUY', type: 'MARKET',
        positionSide: 'BOTH', time: Date.now() + 86_400_000 },
      { symbol: 'BTCUSDT', orderId: legacy, clientOrderId: 'old-local' },
    ])
    assert.equal(Number(url.searchParams.get('limit')), 100)
    return Response.json((spot ? [tracked, manual] : [tracked, direct, legacy, unknown, manual]).map(value => fill(value, spot)))
  } }
  const service = createCopyService(env)
  t.after(async () => { await service.close(); sql.close(); db.close(); unlinkSync(path) })
  const copy = sql.prepare(`INSERT INTO copy_executions
    (environment,user_id,client_id,order_id,portfolio_id,key_identity,symbol,direction,kind,time,quantity,price)
    VALUES ('testnet','viewer',?,?, '123',?,?,'LONG','open',1,1,100)`)
  copy.run('from-copy', tracked, hash(user.apiKey), 'BTCUSDT')
  copy.run('different-key', direct, hash('retired'), 'BTCUSDT')
  copy.run('different-symbol', direct, hash(user.apiKey), 'ETHUSDT')
  const platform = sql.prepare(`INSERT INTO platform_orders
    (environment,user_id,market,client_id,key_identity,symbol,side,type,order_id,time)
    VALUES ('testnet','viewer',?,?,?,'BTCUSDT','BUY','MARKET',?,1)`)
  for (const [market, key] of [['spot', user.spotApiKey], ['futures', user.apiKey]]) {
    platform.run(market, 'manual-' + market, hash(key), manual)
  }
  db.reserve('testnet', 'futures', user.id, 'old-local')
  db.reserve('testnet', 'futures', user.id, 'reused-by-exchange',
    { apiKey: user.apiKey, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', positionSide: 'BOTH' })
  const get = (market, token = 'mock', symbol = 'BTCUSDT') => service.fetch(new Request(
    'http://fixture/api/futures/other-trades?' + new URLSearchParams({ market, symbol }),
    { headers: { authorization: 'Bearer ' + token } }))
  assert.equal((await get('futures', 'invalid')).status, 401)
  assert.equal((await get('margin')).status, 400)
  assert.equal((await get('spot', 'mock', 'bad/field')).status, 400)
  assert.deepEqual(signed, [])
  const futures = await (await get('futures')).json()
  assert.deepEqual(futures.trades.map(row => [row.id, row.orderId, row.source]),
    [[unknown, unknown, 'unverified'], [direct, direct, 'untracked']])
  assert.deepEqual(futures.positions.map(p => [p.symbol, p.quantity]), [['ETHUSDT', '-2']])
  const spot = await (await get('spot')).json()
  assert.deepEqual(spot.trades.map(row => [row.id, row.realizedPnl, row.source]), [[tracked, null, 'untracked']])
  assert.deepEqual(spot.balances, [{ asset: 'BTC', free: '1', locked: '2' }])
  assert.equal(sql.prepare('SELECT count(*) AS n FROM platform_orders').get().n, 3)
  assert.equal(sql.prepare('SELECT count(*) AS n FROM platform_fills').get().n, 0)
  assert.equal(sql.prepare('SELECT count(*) AS n FROM copy_executions').get().n, 3)
  assert.equal(signed.length, 5)
})
