import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { handleFutures } from './futures.js'
import { createLocalOrderDb } from './local-orders.js'

const users = ['alice', 'bob'].map(name => ({
  id: name, name, token: name + '-test-token', apiKey: name + '-test-key', apiSecret: name + '-test-secret',
}))
const config = { BINANCE_FUTURES_USERS: JSON.stringify(users) }
const order = {
  environment: 'live', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH',
  type: 'LIMIT', quantity: '0.002', price: '60001.50', clientOrderId: 'intent-1',
}

function send(path, user, body, env = config) {
  const headers = {}
  if (user) headers.Authorization = 'Bearer ' + user.token
  if (body) headers['Content-Type'] = 'application/json'
  return handleFutures(new Request('https://local.test/api/futures/' + path, {
    method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
  }), env)
}

function verifySignature(url, init, user) {
  const params = new URLSearchParams(init.body ?? url.search)
  const signature = params.get('signature')
  params.delete('signature')
  assert.equal(createHmac('sha256', user.apiSecret).update(params.toString()).digest('hex'), signature)
  assert.equal(init.headers.get('X-MBX-APIKEY'), user.apiKey)
  assert.equal(init.headers.has('Authorization'), false)
  return params
}

test('authentication selects one configured account without returning its credentials', async t => {
  const upstream = t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected upstream request'))
  assert.equal((await send('session', null)).status, 401)
  assert.equal((await send('session', { token: 'unknown' })).status, 401)
  const session = await send('session?id=alice', users[1])
  assert.deepEqual(await session.json(), { id: 'bob', name: 'bob', environment: 'live' })
  const duplicates = { ...config, BINANCE_FUTURES_USERS: JSON.stringify([users[0], { ...users[1], apiKey: users[0].apiKey }]) }
  assert.equal((await send('session', users[1], undefined, duplicates)).status, 503)
  const rotated = { ...config, BINANCE_FUTURES_USERS: JSON.stringify([{ ...users[1], token: 'new-bob-token' }]) }
  assert.equal((await send('session', users[1], undefined, rotated)).status, 401)
  assert.equal((await send('session', { token: 'new-bob-token' }, undefined, rotated)).status, 200)
  assert.equal(upstream.mock.callCount(), 0)
})

test('public quote pairs a futures ticker with its mark and source timestamps', async t => {
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(init.headers.has('X-MBX-APIKEY'), false)
    assert.equal(url.origin, 'https://fapi.binance.com')
    assert.equal(url.searchParams.get('symbol'), 'BTCUSDT')
    return Response.json(url.pathname === '/fapi/v2/ticker/price'
      ? { symbol: 'BTCUSDT', price: '90000.1', time: 123 }
      : { symbol: 'BTCUSDT', markPrice: '90001.2', time: 456 })
  })
  const response = await send('quote?symbol=BTCUSDT&environment=live', null)
  assert.deepEqual(await response.json(), {
    symbol: 'BTCUSDT', lastPrice: '90000.1', lastTime: 123, markPrice: '90001.2', time: 456, environment: 'live',
  })
  assert.equal((await send('quote?symbol=BTCUSDT&environment=other', null)).status, 409)
})

test('guest leverage lookup uses the selected market and rejects default brackets for unknown symbols', async () => {
  const env = { ...config, fetchBinance: async (url, init) => {
    const headers = new Headers(init.headers)
    assert.equal(headers.has('Authorization'), false)
    assert.equal(headers.has('X-MBX-APIKEY'), false)
    if (url.pathname === '/fapi/v1/exchangeInfo') {
      assert.equal(url.host, 'fapi.binance.com')
      return Response.json({ symbols: [{ symbol: 'NVDAUSDT', status: 'TRADING', quoteAsset: 'USDT' }] })
    }
    assert.equal(url.pathname, '/bapi/futures/v1/public/future/common/brackets')
    assert.equal(init.method, 'POST')
    const { symbol } = JSON.parse(init.body)
    assert.equal(url.host, 'www.binance.com')
    const maxOpenPosLeverage = 50
    return Response.json({ code: '000000', data: { brackets: [{ symbol, riskBrackets: [
      { bracketNotionalFloor: 50_000, maxOpenPosLeverage: 5 }, { bracketNotionalFloor: 0, maxOpenPosLeverage },
    ] }] } })
  } }
  const limit = await send('leverage-limit?symbol=NVDAUSDT', null, undefined, env)
  assert.equal(limit.status, 200)
  assert.deepEqual(await limit.json(), { symbol: 'NVDAUSDT', environment: 'live', symbolMaxLeverage: 50 })
  const unknown = await send('leverage-limit?symbol=UNKNOWNUSDT', null, undefined, env)
  assert.equal(unknown.status, 404)
})

test('account reports wallet, available balance and exchange-valued open positions only for the authenticated identity', async t => {
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(url.origin, 'https://fapi.binance.com')
    verifySignature(url, init, users[1])
    return Response.json(url.pathname === '/fapi/v3/account' ? {
      assets: [{ asset: 'USDT', walletBalance: '14', availableBalance: '8.9' }],
    } : [
      { symbol: 'BTCUSDT', positionSide: 'SHORT', positionAmt: '-0.001', entryPrice: '90000', markPrice: '90800',
        unRealizedProfit: '-0.8', positionInitialMargin: '1.6', openOrderInitialMargin: '10', marginAsset: 'USDT', updateTime: 123 },
      { symbol: 'ETHUSDT', positionAmt: '0' },
      { symbol: 'BTCUSDC', positionSide: 'LONG', positionAmt: '1', entryPrice: '90000', markPrice: '91000',
        unRealizedProfit: '1000', positionInitialMargin: '0', marginAsset: 'USDC', updateTime: 123 },
    ])
  })
  const response = await send('account?userId=alice', users[1])
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await response.json(), {
    name: 'bob', environment: 'live', balances: [{ asset: 'USDT', walletBalance: '14', availableBalance: '8.9' }],
    positions: [{ symbol: 'BTCUSDT', positionSide: 'SHORT', quantity: '-0.001', entryPrice: '90000',
      markPrice: '90800', unrealizedPnl: '-0.8', positionInitialMargin: '1.6', marginAsset: 'USDT', updateTime: 123 },
    { symbol: 'BTCUSDC', positionSide: 'LONG', quantity: '1', entryPrice: '90000',
      markPrice: '91000', unrealizedPnl: '1000', marginAsset: 'USDC', updateTime: 123 }],
  })
})

test('current position mode is a signed read for the selected account and environment, including when it has no positions', async t => {
  const upstream = t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(init.method, 'GET')
    assert.equal(url.pathname, '/fapi/v1/positionSide/dual')
    assert.equal(url.origin, 'https://fapi.binance.com')
    if (init.headers.get('X-MBX-APIKEY') === users[0].apiKey) {
      verifySignature(url, init, users[0])
      return Response.json({ dualSidePosition: true })
    }
    assert.equal(url.origin, 'https://fapi.binance.com')
    verifySignature(url, init, users[1])
    return Response.json({ dualSidePosition: false })
  })
  assert.equal((await send('position-mode', null)).status, 401)
  assert.equal((await send('position-mode', users[0], { dualSidePosition: false })).status, 405)
  assert.equal(upstream.mock.callCount(), 0)
  const hedge = await send('position-mode', users[0])
  assert.equal(hedge.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await hedge.json(), { environment: 'live', mode: 'hedge' })
  const oneWay = await send('position-mode', users[1], undefined, { ...config, BINANCE_FUTURES_ENV: 'live' })
  assert.deepEqual(await oneWay.json(), { environment: 'live', mode: 'oneWay' })
  assert.equal(upstream.mock.callCount(), 2)
})

test('missing or malformed exchange mode never falls back to a trading mode', async () => {
  for (const payload of [{}, { dualSidePosition: 'false' }]) {
    const response = await send('position-mode', users[0], undefined, { ...config, fetchBinance: () => Response.json(payload) })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).code, 'INVALID_UPSTREAM_DATA')
  }
})

test('signed limit orders retain exact decimals and 64-bit IDs, including concurrent duplicate submissions', async t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const env = { ...config, orderStore: db }
  const upstream = t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(url.origin, 'https://fapi.binance.com')
    const params = verifySignature(url, init, users[0])
    assert.equal(init.method, 'POST')
    if (url.pathname === '/fapi/v1/leverage') {
      assert.equal(params.get('symbol'), order.symbol)
      assert.equal(params.get('leverage'), '150')
      return Response.json({ symbol: order.symbol, leverage: 150 })
    }
    assert.equal(url.pathname, '/fapi/v1/order')
    assert.equal(params.has('leverage'), false)
    assert.equal(params.get('price'), '60001.50')
    assert.equal(params.get('quantity'), '0.002')
    assert.equal(params.get('timeInForce'), 'GTC')
    assert.equal(params.get('newClientOrderId'), 'intent-1')
    return new Response('{"symbol":"BTCUSDT","clientOrderId":"intent-1","orderId":90071992547409935,"status":"NEW","type":"LIMIT","side":"BUY","executedQty":"0","avgPrice":"0"}')
  })
  const leveraged = { ...order, leverage: 150 }
  const pair = await Promise.all([send('orders', users[0], leveraged, env), send('orders', users[0], leveraged, env)])
  const accepted = pair.find(response => response.status === 201)
  const duplicate = pair.find(response => response.status === 409)
  assert.equal((await accepted.json()).orderId, '90071992547409935')
  assert.equal((await duplicate.json()).code, 'ORDER_UNKNOWN')
  assert.deepEqual(upstream.mock.calls.map(call => call.arguments[0].pathname), ['/fapi/v1/leverage', '/fapi/v1/order'])
})

test('looks up the leverage bracket for the account’s absolute hedge exposure on just the selected symbol', async t => {
  let gross = 600
  let positionAvailable = true
  const upstream = t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(init.method, 'GET')
    assert.equal(verifySignature(url, init, users[1]).get('symbol'), 'ETHUSDT')
    if (url.pathname === '/fapi/v1/symbolConfig') return Response.json(positionAvailable ? [{ symbol: 'ETHUSDT', leverage: 7 }] : [])
    if (url.pathname === '/fapi/v3/positionRisk') {
      if (!positionAvailable) return new Response(null, { status: 503 })
      return Response.json([{ symbol: 'ETHUSDT', notional: String(gross) }, { symbol: 'ETHUSDT', notional: String(-gross) }])
    }
    assert.equal(url.pathname, '/fapi/v1/leverageBracket')
    const account = { symbol: 'ETHUSDT', brackets: [
      { bracket: 1, initialLeverage: 150, notionalFloor: 0, notionalCap: 1000 },
      { bracket: 2, initialLeverage: 50, notionalFloor: 1000, notionalCap: 50_000 },
    ] }
    return Response.json(gross ? [account] : account)
  })
  assert.equal((await send('leverage?symbol=ETHUSDT', null)).status, 401)
  assert.deepEqual(await (await send('leverage?symbol=ETHUSDT', users[1])).json(),
    { symbol: 'ETHUSDT', environment: 'live', leverage: 7, symbolMaxLeverage: 150, maxLeverage: 50,
      exposure: '1200', brackets: [{ cap: '1000', leverage: 150 }, { cap: '50000', leverage: 50 }] })
  gross = 0
  assert.equal((await (await send('leverage?symbol=ETHUSDT', users[1])).json()).maxLeverage, 150)
  positionAvailable = false
  const partial = await (await send('leverage?symbol=ETHUSDT', users[1])).json()
  assert.deepEqual([partial.symbolMaxLeverage, partial.maxLeverage, partial.leverage, partial.exposure], [150, null, null, null])
  assert.equal(upstream.mock.callCount(), 9)
})

test('unconfirmed leverage never sends an order, including when a gateway times out', async t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const responses = [
    Response.json({ symbol: 'ETHUSDT', leverage: 10 }),
    Response.json({ symbol: order.symbol, leverage: 5 }),
    Response.json({ code: -4028, msg: 'Invalid leverage' }, { status: 400 }),
    new Response(null, { status: 504 }),
  ]
  const calls = []
  const env = { ...config, orderStore: db, fetchBinance: url => {
    calls.push(url.pathname)
    return responses.shift()
  } }
  for (let i = 0; i < 4; i++) {
    const rejected = await send('orders', users[0], { ...order, leverage: 10, clientOrderId: 'unconfirmed-' + i }, env)
    assert.equal((await rejected.json()).code, 'LEVERAGE_NOT_CONFIRMED')
  }
  assert.deepEqual(calls, Array(4).fill('/fapi/v1/leverage'))
})

test('concurrent orders on the same symbol cannot replace the first order’s chosen leverage', async t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const calls = []
  const env = { ...config, orderStore: db, fetchBinance: async (url, init) => {
    calls.push(url.pathname)
    const params = new URLSearchParams(init.body)
    if (url.pathname === '/fapi/v1/leverage') {
      entered.resolve()
      await release.promise
      return Response.json({ symbol: order.symbol, leverage: Number(params.get('leverage')) })
    }
    return Response.json({ symbol: order.symbol, clientOrderId: params.get('newClientOrderId'),
      orderId: 7, status: 'NEW', type: 'LIMIT', side: 'BUY', executedQty: '0', avgPrice: '0' })
  } }
  const first = send('orders', users[0], { ...order, leverage: 7 }, env)
  await entered.promise
  try {
    const conflict = await send('orders', users[0], { ...order, clientOrderId: 'other-id', leverage: 3 }, env)
    assert.equal((await conflict.json()).code, 'FUTURES_SYMBOL_BUSY')
    assert.deepEqual(calls, ['/fapi/v1/leverage'])
  } finally {
    release.resolve()
  }
  assert.equal((await first).status, 201)
  assert.deepEqual(calls, ['/fapi/v1/leverage', '/fapi/v1/order'])
})

test('independent service connections honor the symbol lease and only its current owner can release it', async t => {
  const file = join(tmpdir(), 'bn-leverage-' + randomUUID() + '.sqlite')
  const first = createLocalOrderDb(file)
  const second = createLocalOrderDb(file)
  t.after(() => { first.close(); second.close(); unlinkSync(file) })
  const identity = ['live', users[0].id, order.symbol]
  const now = Date.now()
  assert.equal(first.claimFuturesSymbol(...identity, 'owner-1', now + 60_000, now), true)
  const env = { ...config, orderStore: second, fetchBinance: () => assert.fail('unexpected upstream request') }
  const conflict = await send('orders', users[0], { ...order, leverage: 7 }, env)
  assert.equal((await conflict.json()).code, 'FUTURES_SYMBOL_BUSY')
  assert.equal(second.claimFuturesSymbol(...identity, 'owner-2', now + 120_000, now + 60_000), true)
  first.releaseFuturesSymbol(...identity, 'owner-1')
  assert.equal(first.claimFuturesSymbol(...identity, 'owner-3', now + 120_000, now + 61_000), false)
  second.releaseFuturesSymbol(...identity, 'owner-2')
  assert.equal(first.claimFuturesSymbol(...identity, 'owner-3', now + 120_000, now + 61_000), true)
})

test('a process resuming after its symbol lease expires cannot continue from leverage change to order', async t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const calls = []
  const env = { ...config, orderStore: db, fetchBinance: url => {
    calls.push(url.pathname)
    t.mock.timers.tick(61_000)
    return Response.json({ symbol: order.symbol, leverage: 7 })
  } }
  const expired = await send('orders', users[0], { ...order, leverage: 7 }, env)
  assert.equal((await expired.json()).code, 'FUTURES_SYMBOL_BUSY')
  assert.deepEqual(calls, ['/fapi/v1/leverage'])
})

test('uncertain orders can be queried by their original customer ID without another submit', async t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const env = { ...config, orderStore: db }
  const market = { ...order, type: 'MARKET', price: undefined, side: 'SELL', positionSide: 'LONG' }
  const upstream = t.mock.method(globalThis, 'fetch', (url, init) => {
    const params = verifySignature(url, init, users[0])
    if (init.method === 'POST') {
      assert.equal(params.has('price'), false)
      assert.equal(params.has('reduceOnly'), false)
      assert.equal(params.get('positionSide'), 'LONG')
      return new Response('<gateway timeout>', { status: 504 })
    }
    assert.equal(params.get('origClientOrderId'), market.clientOrderId)
    return Response.json({
      symbol: 'BTCUSDT', clientOrderId: market.clientOrderId, orderId: 55, status: 'FILLED', side: 'SELL',
      type: 'MARKET', executedQty: '0.002', avgPrice: '90000',
    })
  })
  assert.equal((await (await send('orders', users[0], market, env)).json()).code, 'ORDER_UNKNOWN')
  assert.equal((await send('orders', users[0], market, env)).status, 409)
  const lookup = await send('orders?symbol=BTCUSDT&clientOrderId=intent-1', users[0], undefined, env)
  assert.equal((await lookup.json()).status, 'FILLED')
  assert.equal(upstream.mock.callCount(), 2)
})

test('invalid or unconfigured orders do not reach Binance', async t => {
  const upstream = t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected upstream request'))
  assert.equal((await send('orders', users[0], order)).status, 503)
  for (const edits of [{ quantity: '1e3' }, { reduceOnly: true, positionSide: 'SHORT' }, { price: '0' }, { userId: 'bob' },
    { leverage: 0 }, { leverage: 1.5 }, { leverage: '5' }, { leverage: Number.MAX_SAFE_INTEGER + 1 }, { leverage: 5, reduceOnly: true },
    { leverage: 5, side: 'SELL', positionSide: 'LONG' }, { leverage: 5, side: 'BUY', positionSide: 'SHORT' }]) {
    assert.equal((await send('orders', users[0], { ...order, ...edits })).status, 400)
  }
  assert.equal((await send('orders', users[0], { ...order, environment: 'testnet' })).status, 409)
  assert.equal(upstream.mock.callCount(), 0)
})

function closeFixture(t) {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const input = { environment: 'live', symbol: 'BTCUSDC', positionSide: 'BOTH', direction: 'LONG',
    expectedQuantity: '0.01200000', expectedUpdateTime: 731, quantity: '0.006', clientOrderId: 'position-close' }
  const market = { symbol: input.symbol, quoteAsset: 'USDC', baseAsset: 'BTC', status: 'TRADING', orderTypes: ['MARKET'],
    filters: [{ filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '100', stepSize: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', minQty: '0.003', maxQty: '2', stepSize: '0.003' }] }
  const row = { symbol: input.symbol, positionSide: 'BOTH', positionAmt: '0.012', updateTime: input.expectedUpdateTime }
  const fixture = { risk: [row], orders: [], row, input, db }
  fixture.env = { ...config, orderStore: db, fetchBinance: async (url, init) => {
    assert.equal(url.origin, 'https://fapi.binance.com')
    if (url.pathname === '/fapi/v1/exchangeInfo') return Response.json({ symbols: [market] })
    const params = verifySignature(url, init, users[0])
    assert.equal(params.get('symbol'), input.symbol)
    if (url.pathname === '/fapi/v3/positionRisk') {
      assert.equal(init.method, 'GET')
      if (fixture.beforeRisk) await fixture.beforeRisk()
      return Response.json(fixture.risk)
    }
    assert.equal(url.pathname, '/fapi/v1/order')
    if (init.method === 'POST') fixture.orders.push(Object.fromEntries(params))
    if (init.method === 'POST' && fixture.orderError) return fixture.orderError
    const placed = fixture.orders.at(-1)
    return Response.json({ symbol: input.symbol, clientOrderId: placed.newClientOrderId, orderId: 70 + fixture.orders.length, status: 'FILLED',
      side: placed.side, positionSide: placed.positionSide, type: 'MARKET', executedQty: placed.quantity, avgPrice: '50000', time: Date.now() })
  } }
  return fixture
}

test('row closes use exact market lots and can target either leg or the one-way net position', async t => {
  const fixture = closeFixture(t)
  const { env, row, input } = fixture
  const rules = await send('close-position?symbol=BTCUSDC', users[0], undefined, env)
  assert.deepEqual(await rules.json(), { symbol: 'BTCUSDC', environment: 'live', baseAsset: 'BTC', stepSize: '0.003', minQty: '0.003', maxQty: '2' })
  for (const [leg, direction, quantity, side] of [
    ['BOTH', 'LONG', '0.006', 'SELL'], ['BOTH', 'SHORT', '0.012', 'BUY'],
    ['LONG', 'LONG', '0.012', 'SELL'], ['SHORT', 'SHORT', '0.003', 'BUY'],
  ]) {
    fixture.risk = leg === 'BOTH' ? [{ ...row, positionAmt: (direction === 'SHORT' ? '-' : '') + row.positionAmt }]
      : [{ ...row, positionSide: 'LONG' }, { ...row, positionSide: 'SHORT', positionAmt: '-0.012' }]
    const ticket = { ...input, positionSide: leg, direction, quantity, clientOrderId: leg + '-' + direction }
    const response = await send('close-position', users[0], ticket, env)
    const receipt = await response.json()
    assert.equal(response.status, 201, JSON.stringify(receipt))
    assert.equal(receipt.clientOrderId, ticket.clientOrderId)
    const placed = fixture.orders.at(-1)
    assert.equal(placed.type, 'MARKET')
    assert.equal(placed.quantity, quantity)
    assert.equal(placed.side, side)
    assert.equal(placed.positionSide, leg)
    assert.equal(placed.reduceOnly, leg === 'BOTH' ? 'true' : undefined)
    assert.equal(placed.leverage, undefined)
  }
  assert.equal(fixture.orders.length, 4)
})

test('row closes reject changed position snapshots, quantities off the market lot and ambiguous positions before submission', async t => {
  const fixture = closeFixture(t)
  const { env, row, input } = fixture
  let nextId = 0
  const check = async (changes, risk, code) => {
    fixture.risk = risk
    const response = await send('close-position', users[0], { ...input, ...changes, clientOrderId: 'invalid-' + nextId++ }, env)
    assert.equal((await response.json()).code, code)
  }
  for (const risk of [[], [{ ...row, positionAmt: '-0.012' }], [{ ...row, positionAmt: '0.009' }],
    [{ ...row, positionAmt: '0' }], [{ ...row, updateTime: row.updateTime + 1 }], [{ ...row, positionSide: 'LONG' }],
    [{ ...row, symbol: 'ETHUSDC' }]]) await check({}, risk, 'POSITION_CHANGED')
  await check({ quantity: '0.006000000000000001' }, [row], 'INVALID_CLOSE_QUANTITY')
  await check({ quantity: '0.00001' }, [row], 'INVALID_CLOSE_QUANTITY')
  await check({ quantity: '3', expectedQuantity: '3' }, [{ ...row, positionAmt: '3' }], 'INVALID_CLOSE_QUANTITY')
  await check({ quantity: '0.012000000000000001' }, [row], 'INVALID_CLOSE')
  await check({ leverage: 10 }, [row], 'INVALID_CLOSE')
  await check({ positionSide: 'SHORT' }, [row], 'INVALID_CLOSE')
  await check({ environment: 'testnet' }, [row], 'ENVIRONMENT_CHANGED')
  await check({}, [row, row], 'CLOSE_CHECK_UNAVAILABLE')
  await check({}, {}, 'CLOSE_CHECK_UNAVAILABLE')
  assert.equal((await send('close-position', null, input, env)).status, 401)
  assert.deepEqual(fixture.orders, [])
})

test('row close rechecks inside the symbol lease and an uncertain receipt is queried using the original ID', async t => {
  const fixture = closeFixture(t)
  const { env, input } = fixture
  const release = Promise.withResolvers()
  const entered = Promise.withResolvers()
  fixture.beforeRisk = async () => { entered.resolve(); await release.promise }
  fixture.orderError = new Response('', { status: 504 })
  const original = send('close-position', users[0], input, env)
  await entered.promise
  try {
    const concurrent = await send('close-position', users[0], { ...input, clientOrderId: 'close-busy' }, env)
    assert.equal((await concurrent.json()).code, 'FUTURES_SYMBOL_BUSY')
  } finally {
    release.resolve()
  }
  assert.equal((await (await original).json()).code, 'ORDER_UNKNOWN')
  const duplicate = await send('close-position', users[0], input, env)
  assert.equal((await duplicate.json()).code, 'ORDER_UNKNOWN')
  assert.equal(fixture.orders.length, 1)
  const lookup = await send('orders?symbol=BTCUSDC&clientOrderId=' + input.clientOrderId, users[0], undefined, env)
  assert.equal((await lookup.json()).status, 'FILLED')
  assert.equal(env.orderStore.platform.latest({ environment: 'live', userId: users[0].id,
    market: 'futures', clientOrderId: input.clientOrderId }).status, 'FILLED')
})

test('a duplicate client ID response from the exchange keeps the close order available for reconciliation', async t => {
  const fixture = closeFixture(t)
  fixture.orderError = Response.json({ code: -4116, msg: 'Duplicated client order id' }, { status: 400 })
  const response = await send('close-position', users[0], fixture.input, fixture.env)
  assert.equal((await response.json()).code, 'ORDER_UNKNOWN')
  const lookup = await send('orders?symbol=BTCUSDC&clientOrderId=' + fixture.input.clientOrderId, users[0], undefined, fixture.env)
  assert.equal((await lookup.json()).status, 'FILLED')
  assert.equal(fixture.orders.length, 1)
})
