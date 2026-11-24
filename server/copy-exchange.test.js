import assert from 'node:assert/strict'
import test from 'node:test'
import timers from 'node:timers/promises'
import { createCopyExchange } from './copy-exchange.js'

const user = { id: 'test', apiKey: 'unit-test', apiSecret: 'unit-test-secret' }
const id = '5075281354358777856'
const exchangeId = '9223372036854775807'
const market = { symbol: 'BTCUSDT', status: 'TRADING', quoteAsset: 'USDT', orderTypes: ['MARKET'], filters: [
  { filterType: 'LOT_SIZE', minQty: '0.002', maxQty: '100', stepSize: '0.002' },
  { filterType: 'MARKET_LOT_SIZE', minQty: '0.005', maxQty: '25', stepSize: '0.005' },
  { filterType: 'MIN_NOTIONAL', notional: '5' },
] }

function exchange(fetchBinance) {
  const reserved = new Set()
  const orderStore = { reserve(environment, market, userId, id) {
    const key = [environment, market, userId, id].join('/')
    if (reserved.has(key)) return false
    reserved.add(key)
    return true
  } }
  return createCopyExchange({ fetchBinance, orderStore }, user, 'testnet')
}

const row = { symbol: 'BTCUSDT', side: 'SELL', positionSide: 'SHORT', type: 'MARKET', orderTime: 999900,
  orderUpdateTime: 1000200, executedQty: 1, avgPrice: 50000, totalPnl: 0 }

test('signals filter the expanded source window, sort actionable fills and keep a stable identity across updates', async () => {
  let trades = [row, { ...row, side: 'BUY', orderUpdateTime: 1000100 }, { ...row, orderUpdateTime: 1000000 },
    { ...row, orderUpdateTime: 1100000 }, { ...row, executedQty: 0 }, { ...row, positionSide: 'BOTH' }]
  const client = exchange((url, options) => {
    assert.equal(url.pathname.endsWith('/lead-portfolio/order-history'), true)
    assert.equal(JSON.parse(options.body).startTime, 700300)
    assert.equal(options.headers.has('X-MBX-APIKEY'), false)
    return Response.json({ code: '000000', data: { total: trades.length, list: trades } })
  })
  const signals = await client.signals(id, 1000000, 1000300)
  assert.deepEqual(signals.map(({ direction, kind, time }) => [direction, kind, time]), [
    ['SHORT', 'close', 1000100], ['SHORT', 'open', 1000200],
  ])
  trades = [{ ...row, executedQty: 2, avgPrice: 49000, orderUpdateTime: 1000250 }]
  assert.equal((await client.signals(id, 1000000, 1000300))[0].id, signals[1].id)
})

test('truncated history defers the whole batch and rate limits preserve the exchange wait', async () => {
  const incomplete = exchange(() => Response.json({ code: '000000', data: { total: 2, list: [row], indexValue: '-1' } }))
  await assert.rejects(incomplete.signals(id, 1000000, 1000300), { code: 'INCOMPLETE_COPY_SIGNALS' })
  const limited = exchange(() => new Response('', { status: 429, headers: { 'Retry-After': '45' } }))
  await assert.rejects(limited.signals(id, 1000000, 1000300), { status: 429, headers: { 'Retry-After': '45' } })
})

test('signal pagination preserves the query bounds and tolerates a repeated cursor boundary fill', async t => {
  const delay = t.mock.method(timers, 'setTimeout', async () => {})
  const newer = { ...row, orderTime: 1000101, orderUpdateTime: 1000103, avgPrice: 1e-7 }
  const older = { ...row, orderTime: 1000001, orderUpdateTime: 1000002 }
  const client = exchange((_url, options) => {
    const body = JSON.parse(options.body)
    assert.equal(body.startTime, 700300)
    assert.equal(body.endTime, 1000300)
    return Response.json({ code: '000000', data: { total: 2, indexValue: '1000103',
      list: body.indexValue === '1000103' ? [newer, older] : [newer] } })
  })
  const signals = await client.signals(id, 1000000, 1000300)
  assert.deepEqual(signals.map(signal => signal.time), [1000002, 1000103])
  assert.equal(delay.mock.callCount(), 1)
})

test('positions confirms actual account mode and preserves the signed direction', async () => {
  let hedging = true
  let positionCalls = 0
  const client = exchange((url, options) => {
    assert.equal(options.headers.get('X-MBX-APIKEY'), user.apiKey)
    assert.ok(url.searchParams.has('signature'))
    if (url.pathname.endsWith('/dual')) return Response.json({ dualSidePosition: hedging })
    assert.equal(url.pathname, '/fapi/v3/positionRisk')
    positionCalls++
    return Response.json([{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '-0.01',
      entryPrice: '60001.5', markPrice: '60101.5', unRealizedProfit: '-1' },
    { symbol: 'ETHUSDT', positionSide: 'BOTH', positionAmt: '0' }])
  })
  await assert.rejects(client.positions(), { code: 'COPY_ONE_WAY_REQUIRED' })
  assert.equal(positionCalls, 0)
  hedging = false
  assert.deepEqual(await client.positions(), [
    { symbol: 'BTCUSDT', direction: 'SHORT', quantity: 0.01, entryPrice: 60001.5, markPrice: 60101.5, unrealizedPnl: -1 },
  ])
})

function orderMock(onOrder) {
  return (url, init) => {
    assert.equal(url.origin, 'https://demo-fapi.binance.com')
    if (url.pathname === '/fapi/v1/exchangeInfo') return Response.json({ symbols: [market] })
    if (url.pathname === '/fapi/v2/ticker/price') return Response.json({ symbol: 'BTCUSDT', price: '11' })
    if (url.pathname === '/fapi/v1/premiumIndex') return Response.json({ symbol: 'BTCUSDT', markPrice: '10' })
    assert.equal(url.pathname, '/fapi/v1/order')
    assert.equal(init.headers.get('X-MBX-APIKEY'), user.apiKey)
    const params = new URLSearchParams(init.body ?? url.search)
    assert.ok(params.has('signature'))
    return onOrder(params, init.method)
  }
}

function receipt(params) {
  const data = { symbol: 'BTCUSDT', orderId: 'RAW_INT64', clientOrderId: params.get('newClientOrderId') ?? params.get('origClientOrderId'),
    type: 'MARKET', side: params.get('side') ?? 'BUY', status: 'FILLED', executedQty: params.get('quantity') ?? '1', avgPrice: '11' }
  return new Response(JSON.stringify(data).replace('"RAW_INT64"', exchangeId))
}

test('market orders apply both lot grids, enforce mark minimum on opens and use reduceOnly on closes', async () => {
  const observed = []
  let infoRequests = 0
  const mock = orderMock((params, method) => {
    observed.push([method, params.get('side'), params.get('quantity'), params.get('reduceOnly')])
    if (method === 'POST') assert.equal(params.get('positionSide'), 'BOTH')
    return receipt(params)
  })
  const client = exchange((url, init) => {
    if (url.pathname.endsWith('/exchangeInfo')) infoRequests++
    return mock(url, init)
  })
  await assert.rejects(client.open('BTCUSDT', 'LONG', '5', 'too-small'), { code: 'COPY_MIN_NOTIONAL', definite: true })
  assert.equal((await client.open('BTCUSDT', 'SHORT', '12.345', 'intent')).orderId, exchangeId)
  await assert.rejects(client.open('BTCUSDT', 'SHORT', '12.345', 'intent'), e => e.code === 'ORDER_UNKNOWN' && !e.definite)
  await client.close('BTCUSDT', 'SHORT', '0.038', 'close')
  assert.equal((await client.lookup('BTCUSDT', 'close')).orderId, exchangeId)
  assert.deepEqual(observed, [['POST', 'SELL', '1.12', null], ['POST', 'BUY', '0.03', 'true'], ['GET', null, null, null]])
  assert.equal(infoRequests, 1)
})

test('network failures, duplicate responses and incomplete receipts remain lookup-only', async () => {
  for (const [reply, definite] of [
    [() => Response.json({ code: -1013, msg: 'Invalid quantity' }, { status: 400 }), true],
    [() => Response.json({ code: -4116, msg: 'Duplicate client order ID' }, { status: 400 }), false],
    [() => Response.json({}, { status: 503 }), false],
    [() => Response.json({ orderId: 123 }), false],
    [() => { throw new Error('connection reset') }, false],
  ]) {
    let attempts = 0
    const client = exchange(orderMock(() => { attempts++; return reply() }))
    await assert.rejects(client.open('BTCUSDT', 'LONG', '25', 'intent'), e => Boolean(e.definite) === definite)
    assert.equal(attempts, 1)
  }
})

test('account trade settlement requires complete matching fills with precise order IDs and signed fees', async () => {
  const fill = { symbol: 'BTCUSDT', orderId: 'RAW_INT64', id: 7, qty: '0.01', price: '60000', realizedPnl: '-1.50',
    commission: '-0.002', commissionAsset: 'BNB' }
  let rows = [fill]
  const client = exchange((url, init) => {
    assert.equal(url.pathname, '/fapi/v1/userTrades')
    assert.equal(url.searchParams.get('orderId'), exchangeId)
    assert.equal(url.searchParams.get('symbol'), 'BTCUSDT')
    assert.equal(url.searchParams.get('limit'), '1000')
    assert.equal(init.headers.get('X-MBX-APIKEY'), user.apiKey)
    return new Response(JSON.stringify(rows).replaceAll('"RAW_INT64"', exchangeId))
  })
  assert.deepEqual(await client.fills('BTCUSDT', exchangeId), [
    { quantity: 0.01, price: 60000, realized: -1.5, commission: -0.002, commissionAsset: 'BNB' },
  ])
  rows = [fill, fill]
  await assert.rejects(client.fills('BTCUSDT', exchangeId), { code: 'INVALID_UPSTREAM_DATA' })
  rows = [{ ...fill, orderId: '9999' }]
  await assert.rejects(client.fills('BTCUSDT', exchangeId), { code: 'INVALID_UPSTREAM_DATA' })
  rows = Array(1000).fill(fill)
  await assert.rejects(client.fills('BTCUSDT', exchangeId), { code: 'INCOMPLETE_COPY_FILLS' })
})
