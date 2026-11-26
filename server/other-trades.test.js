import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createLocalOrderDb } from '../worker/local-orders.js'
import { createCopyService } from './copy-service.js'
import { classifyFuturesFills } from './other-trades.js'

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
  let additionalFills = []
  let orderLookupAvailable = true
  const fill = (order, spot) => ({ id: JSON.rawJSON(order), orderId: JSON.rawJSON(order), symbol: 'BTCUSDT',
    side: 'BUY', isBuyer: true, positionSide: 'BOTH', realizedPnl: '3', marginAsset: 'USDT', price: '100',
    commission: '0.1', commissionAsset: 'BNB', qty: '1', time: spot ? 123321 : 123456 })
  const env = { orderStore: db, BINANCE_FUTURES_USERS: JSON.stringify([user]), fetchBinance: (url, init) => {
    assert.equal(init.method, 'GET')
    const spot = url.origin === 'https://api.binance.com'
    assert.equal(init.headers.get('X-MBX-APIKEY'), spot ? user.spotApiKey : user.apiKey)
    signed.push(url.pathname)
    if (url.pathname.endsWith('/account')) return Response.json({ balances: [{ asset: 'BTC', free: '1', locked: '2' }] })
    if (url.pathname.endsWith('/positionRisk')) {
      assert.equal(url.searchParams.has('symbol'), false)
      return Response.json([{ symbol: 'ETHUSDT', positionSide: 'SHORT', positionAmt: '-2', entryPrice: '7',
        markPrice: '6', updateTime: 123, unRealizedProfit: '2', marginAsset: 'USDT' }])
    }
    assert.equal(url.searchParams.get('symbol'), 'BTCUSDT')
    if (url.pathname.endsWith('/allOrders')) return orderLookupAvailable ? Response.json([
      { symbol: 'BTCUSDT', orderId: direct, clientOrderId: 'reused-by-exchange', side: 'BUY', type: 'MARKET',
        positionSide: 'BOTH', time: Date.now() + 86_400_000 },
      { symbol: 'BTCUSDT', orderId: legacy, clientOrderId: 'old-local' },
      { symbol: 'BTCUSDT', orderId: '81', clientOrderId: 'in-flight', side: 'SELL', type: 'MARKET', positionSide: 'LONG', time: Date.now() },
    ]) : new Response('', { status: 503 })
    assert.equal(Number(url.searchParams.get('limit')), 100)
    return Response.json((spot ? [tracked, manual] : [tracked, direct, legacy, unknown, manual]).map(value => fill(value, spot))
      .concat(spot ? [] : additionalFills))
  } }
  const service = createCopyService(env)
  t.after(async () => { await service.close(); sql.close(); db.close(); unlinkSync(path) })
  const copy = sql.prepare(`INSERT INTO copy_executions
    (environment,user_id,client_id,order_id,portfolio_id,key_identity,symbol,direction,kind,time,quantity,price)
    VALUES ('live','viewer',?,?, '123',?,?,'LONG','open',1,1,100)`)
  copy.run('from-copy', tracked, hash(user.apiKey), 'BTCUSDT')
  copy.run('different-key', direct, hash('retired'), 'BTCUSDT')
  copy.run('different-symbol', direct, hash(user.apiKey), 'ETHUSDT')
  const platform = sql.prepare(`INSERT INTO platform_orders
    (environment,user_id,market,client_id,key_identity,symbol,side,type,order_id,time)
    VALUES ('live','viewer',?,?,?,'BTCUSDT','BUY','MARKET',?,1)`)
  for (const [market, key] of [['spot', user.spotApiKey], ['futures', user.apiKey]]) {
    platform.run(market, 'manual-' + market, hash(key), manual)
  }
  db.reserve('live', 'futures', user.id, 'old-local')
  db.reserve('live', 'futures', user.id, 'reused-by-exchange',
    { apiKey: user.apiKey, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', positionSide: 'BOTH' })
  const get = (market, token = 'mock', symbol = 'BTCUSDT', scope = 'other') => service.fetch(new Request(
    'http://fixture/api/futures/other-trades?' + new URLSearchParams({ market, symbol, scope }),
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

  db.reserve('live', 'futures', user.id, 'in-flight',
    { apiKey: user.apiKey, symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', positionSide: 'LONG' })
  const secondFill = { ...fill(tracked, false), id: '77' }
  additionalFills = [{ ...fill('81', false), side: 'SELL', positionSide: 'LONG' }, secondFill, secondFill]
  const all = () => get('futures', 'mock', 'BTCUSDT', 'all')
  const result = await (await all()).json()
  assert.deepEqual(signed.slice(5), ['/fapi/v1/userTrades', '/fapi/v1/allOrders'])
  assert.deepEqual([result.limit, result.windowDays, result.atLimit], [100, 7, false])
  assert.deepEqual(result.trades.map(row => [row.id, row.source, row.portfolioId]), [
    [manual, 'manual', null], [unknown, 'unverified', null], [legacy, 'unverified', null], [direct, 'untracked', null],
    [tracked, 'copy', '123'], ['81', 'manual', null], ['77', 'copy', '123'],
  ])
  assert.equal(result.trades.at(-1).orderId, tracked)
  assert.equal((await get('spot', 'mock', 'BTCUSDT', 'all')).status, 400)
  assert.equal((await get('futures', 'invalid', 'BTCUSDT', 'all')).status, 401)
  orderLookupAvailable = false
  additionalFills = Array.from({ length: 95 }, (_, i) => ({ ...fill(tracked, false), id: String(105 + i) }))
  const incomplete = await (await all()).json()
  assert.equal(incomplete.atLimit, true)
  assert.equal(incomplete.trades.length, 100)
  assert.equal(incomplete.trades.find(row => row.id === direct).source, 'unverified')
  assert.equal(incomplete.trades.find(row => row.id === tracked).source, 'copy')
  additionalFills = [{ ...fill('500', false), id: tracked }]
  assert.equal((await all()).status, 502)
  assert.equal(Object.hasOwn(result.trades[0], 'copyKind'), false)

  copy.run('copy-short-close', '90002', hash(user.apiKey), 'BTCUSDT')
  sql.prepare("UPDATE copy_executions SET kind='close',direction='SHORT' WHERE client_id='copy-short-close'").run()
  const evidence = [tracked, '90002', manual, legacy].map(orderId => ({ ...fill(orderId, false), id: orderId, orderId }))
  const positions = await classifyFuturesFills(env, user, 'live', 'BTCUSDT', evidence)
  assert.deepEqual(positions.map(row => [row.orderId, row.source, row.portfolioId, row.copyKind, row.copyDirection]), [
    [manual, 'manual', null, null, null], [legacy, 'unverified', null, null, null],
    [tracked, 'copy', '123', 'open', 'LONG'], ['90002', 'copy', '123', 'close', 'SHORT'],
  ])
})
