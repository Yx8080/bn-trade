import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import worker from '../worker/index.js'
import { createLocalOrderDb } from '../worker/local-orders.js'
import { createPlatformSettlement } from './platform-settlement.js'
import { ledgerIdentity } from './platform-store.js'

const epoch = 1_800_000_000_000
const user = { id: 'trader', name: 'test', token: 'test-token', apiKey: 'f-key', apiSecret: 'f-secret',
  spotApiKey: 's-key', spotApiSecret: 's-secret' }
const request = (market, input, query = '') => new Request('http://localhost/api/' + market + '/orders' + query, {
  headers: { 'Authorization': 'Bearer test-token', 'Content-Type': 'application/json' },
  method: input ? 'POST' : 'GET', body: input ? JSON.stringify({ environment: 'testnet', symbol: 'BTCUSDT', ...input }) : undefined,
})

async function setup(t, fetchBinance) {
  t.mock.timers.enable({ apis: ['Date'], now: epoch })
  const directory = await mkdtemp(join(tmpdir(), 'bn-platform-'))
  const filename = join(directory, 'orders.sqlite')
  let db
  let service
  const env = { BINANCE_FUTURES_USERS: JSON.stringify([user]), fetchBinance }
  const start = () => {
    db = createLocalOrderDb(filename)
    env.orderStore = db
    service = createPlatformSettlement(env)
  }
  start()
  t.after(async () => { await service.close(); db.close(); await rm(directory, { force: true, recursive: true }) })
  return {
    env, async restart() { await service.close(); db.close(); start() },
    async tick(ms = 16_000) { t.mock.timers.tick(ms); await service.poll() },
    report: () => db.platform.report('testnet', user.id, 1),
  }
}

test('platform futures journal recovers an unknown order, records each partial once and excludes unrelated order lookups', async t => {
  let phase = 1
  let submissions = 0
  const venueId = '9223372036854775801'
  const order = { symbol: 'BTCUSDT', orderId: venueId, side: 'SELL', type: 'LIMIT', clientOrderId: 'intent',
    avgPrice: '100', time: epoch + 20, positionSide: 'BOTH' }
  const fills = [
    { id: '9007199254740995', quantity: '1', realized: '5', fee: '0.1', asset: 'USDT' },
    { id: '9007199254740996', quantity: '2', realized: '3', fee: '0.001', asset: 'BNB' },
  ]
  const h = await setup(t, (url, init) => {
    assert.equal(init.headers.get('X-MBX-APIKEY'), user.apiKey)
    if (init.method === 'POST') { submissions++; throw Error('timeout after acceptance') }
    assert.ok(url.searchParams.has('signature'))
    const clientId = url.searchParams.get('origClientOrderId')
    if (url.pathname === '/fapi/v1/order') {
      if (clientId === 'external') return Response.json({ ...order, clientOrderId: 'external', orderId: '999', status: 'FILLED', executedQty: '1' })
      return Response.json({ ...order, status: phase === 1 ? 'PARTIALLY_FILLED' : 'FILLED', executedQty: phase === 1 ? '1' : '3' })
    }
    assert.equal(url.pathname, '/fapi/v1/userTrades')
    assert.equal(url.searchParams.get('orderId'), venueId)
    const fromId = BigInt(url.searchParams.get('fromId'))
    return Response.json(fills.slice(0, phase).filter(fill => BigInt(fill.id) >= fromId).map(fill => ({
      symbol: 'BTCUSDT', orderId: venueId, side: order.side, positionSide: 'BOTH', id: fill.id, time: epoch + 30,
      price: '100', qty: fill.quantity, quoteQty: String(Number(fill.quantity) * 100), realizedPnl: fill.realized,
      marginAsset: 'USDT', commission: fill.fee, commissionAsset: fill.asset,
    })))
  })
  const input = { clientOrderId: 'intent', side: 'SELL', type: 'LIMIT', quantity: '3', price: '100', positionSide: 'BOTH' }
  assert.equal((await worker.fetch(request('futures', input), h.env)).status, 502)
  assert.equal((await worker.fetch(request('futures', input), h.env)).status, 409)
  assert.equal(submissions, 1)
  await h.restart()
  await h.tick()
  assert.equal(h.report().pendingCount, 1)
  assert.equal(h.report().rows[0].quantity, 1)
  assert.equal(h.report().rows[0].settled, false)
  assert.equal(h.report().totals[0].net, 4.9)
  assert.equal((await worker.fetch(request('futures', null, '?symbol=BTCUSDT&clientOrderId=external'), h.env)).status, 200)
  await h.tick()
  assert.equal(h.report().total, 1)
  phase = 2
  await h.tick()
  await h.restart()
  await h.tick()
  const report = h.report()
  assert.equal(submissions, 1)
  assert.equal(report.total, 1)
  assert.equal(report.pendingCount, 0)
  assert.deepEqual(report.rows.map(r => [r.status,r.quantity,r.quote,r.settled]), [['FILLED',3,300,true]])
  assert.deepEqual(report.totals.map(r => [r.asset,r.realized,r.fees]), [['BNB',0,0.001],['USDT',8,0.1]])
  const store = h.env.orderStore.platform
  assert.equal(store.futuresFills('testnet', user.id).length, 2)
  assert.equal(store.report('live', user.id).total, 0)
  assert.equal(store.report('testnet', user.id, 1, { futures: 'different' }).total, 0)
  assert.deepEqual([...store.orderIds('testnet', user.id, ledgerIdentity(user.id, user.apiKey), 'futures', 'BTCUSDT', [venueId,'999'])], [venueId])
})

test('spot records only platform buy cost, net inventory and per-asset fees; definite rejections never become trades', async t => {
  const order = { symbol: 'BTCUSDT', orderId: '467', clientOrderId: 'buy', side: 'BUY', type: 'MARKET',
    status: 'FILLED', executedQty: '2', cummulativeQuoteQty: '200' }
  const h = await setup(t, (url, init) => {
    assert.equal(init.headers.get('X-MBX-APIKEY'), user.spotApiKey)
    if (init.method === 'POST') return new URLSearchParams(init.body).get('newClientOrderId') === 'bad'
      ? Response.json({ code: -2010, msg: 'Insufficient balance' }, { status: 400 }) : Response.json(order)
    assert.equal(url.pathname, '/api/v3/myTrades')
    return Response.json(['BTC','USDT'].map((asset, index) => ({ symbol: 'BTCUSDT', orderId: '467',
      id: index + 1, time: epoch + 30, isBuyer: true, price: '100', qty: '1', quoteQty: '100',
      commission: index ? '0.1' : '0.001', commissionAsset: asset })))
  })
  assert.equal((await worker.fetch(request('spot', { clientOrderId: 'buy', quoteOrderQty: '200' }), h.env)).status, 201)
  assert.equal((await worker.fetch(request('spot', { clientOrderId: 'bad', quoteOrderQty: '200' }), h.env)).status, 400)
  await h.tick()
  const report = h.report()
  assert.equal(report.total, 1)
  assert.equal(report.pendingCount, 0)
  assert.equal(report.spot[0].quantity, 1.999)
  assert.equal(report.spot[0].cost, 200.1)
  assert.equal(report.rows[0].quote, 200)
  assert.deepEqual(report.totals.map(r => [r.asset,r.realized,r.fees]), [['BTC',0,0.001],['USDT',0,0.1]])
})

test('unconfirmed intents reject reused client IDs and mismatched legs; a corrected terminal cumulative reopens settlement', async t => {
  const h = await setup(t, () => { throw Error('unexpected request') })
  const local = h.env.orderStore
  const db = local.platform
  local.reserve('testnet', 'futures', user.id, 'intent', {
    apiKey: user.apiKey, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', type: 'LIMIT',
  })
  const receipt = { symbol: 'BTCUSDT', clientOrderId: 'intent', orderId: '400', side: 'BUY', type: 'LIMIT',
    executedQty: '1', status: 'FILLED' }
  const observe = (venueTime, leg) => db.acknowledge('testnet', user.id, 'futures', user.apiKey, receipt, venueTime, true, leg)
  assert.equal(observe(epoch + 3_600_000, 'LONG'), false)
  assert.equal(observe(epoch - 3_600_000, 'LONG'), false)
  assert.equal(observe(epoch + 1, 'SHORT'), false)
  assert.equal(observe(epoch + 1, 'LONG'), true)
  const [row] = db.due('testnet', epoch)
  db.saveFills(row, [{ id: '7', time: epoch, quantity: 1, quote: 100, price: 100, realized: 0, realizedAsset: 'USDT',
    fee: 0, feeAsset: 'USDT' }], epoch)
  assert.equal(h.report().pendingCount, 0)
  receipt.executedQty = '2'
  assert.equal(observe(epoch + 1, 'LONG'), true)
  assert.equal(h.report().pendingCount, 1)
  assert.equal(db.due('testnet', epoch)[0].executedQty, '2')
})

test('a short inconsistent trade page is rescanned so a late lower trade ID is settled without double counting', async t => {
  let complete = false
  const h = await setup(t, (url, init) => {
    if (init.method === 'POST') return Response.json({ symbol: 'BTCUSDT', orderId: '14', clientOrderId: 'buy',
      side: 'BUY', type: 'MARKET', status: 'FILLED', executedQty: '2', cummulativeQuoteQty: '200' })
    assert.equal(url.searchParams.get('fromId'), '0')
    return Response.json((complete ? ['101', '102'] : ['102']).map(id => ({ symbol: 'BTCUSDT', orderId: '14',
      id, time: epoch + 20, isBuyer: true, price: '100', qty: '1', quoteQty: '100', commission: '0.1', commissionAsset: 'USDT' })))
  })
  await worker.fetch(request('spot', { clientOrderId: 'buy', quoteOrderQty: '200' }), h.env)
  await h.tick()
  assert.equal(h.report().rows[0].quantity, 1)
  assert.equal(h.report().pendingCount, 1)
  await h.restart()
  complete = true
  await h.tick()
  assert.equal(h.report().rows[0].quantity, 2)
  assert.equal(h.report().totals[0].fees, 0.2)
  assert.equal(h.report().pendingCount, 0)
})
