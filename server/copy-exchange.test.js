import assert from 'node:assert/strict'
import test from 'node:test'
import { createCopyExchange } from './copy-exchange.js'
import { runCopyTick } from './copy-engine.js'

const user = { id: 'test', apiKey: 'unit-test', apiSecret: 'unit-test-secret' }
const id = '5075281354358777856'
const exchangeId = '9223372036854775807'
const market = { symbol: 'BTCUSDT', status: 'TRADING', quoteAsset: 'USDT', orderTypes: ['MARKET'], filters: [
  { filterType: 'LOT_SIZE', minQty: '0.002', maxQty: '100', stepSize: '0.002' },
  { filterType: 'MARKET_LOT_SIZE', minQty: '0.005', maxQty: '25', stepSize: '0.005' },
  { filterType: 'MIN_NOTIONAL', notional: '5' },
] }

function exchange(fetchBinance, lease = {}) {
  const reserved = new Set()
  const orderStore = { ...lease, reserve(environment, market, userId, id) {
    const key = [environment, market, userId, id].join('/')
    if (reserved.has(key)) return false
    reserved.add(key)
    return true
  } }
  return createCopyExchange({ fetchBinance, orderStore }, user, 'live')
}

test('positions confirms actual account mode and preserves the signed direction', async () => {
  let hedging = true
  let positionCalls = 0
  const short = { symbol: 'BTCUSDT', positionAmt: '-0.01', entryPrice: '60001.5', markPrice: '60101.5',
    unRealizedProfit: '-1', updateTime: 1800000000000 }
  const client = exchange((url, options) => {
    assert.equal(options.headers.get('X-MBX-APIKEY'), user.apiKey)
    assert.ok(url.searchParams.has('signature'))
    if (url.pathname.endsWith('/dual')) return Response.json({ dualSidePosition: hedging })
    assert.equal(url.pathname, '/fapi/v3/positionRisk')
    positionCalls++
    return Response.json(hedging
      ? [{ ...short, positionSide: 'SHORT' }, { ...short, positionSide: 'LONG', positionAmt: '0.02' }]
      : [{ ...short, positionSide: 'BOTH' }, { symbol: 'ETHUSDT', positionSide: 'BOTH', positionAmt: '0' }])
  })
  const hedged = await client.positions()
  assert.equal(hedged.mode, 'hedge')
  assert.deepEqual(hedged.positions.map(p => [p.positionSide, p.direction, p.quantity]), [['SHORT', 'SHORT', 0.01], ['LONG', 'LONG', 0.02]])
  hedging = false
  assert.deepEqual(await client.positions(), { mode: 'oneWay', positions: [
    { symbol: 'BTCUSDT', direction: 'SHORT', quantity: 0.01, entryPrice: 60001.5, markPrice: 60101.5,
      unrealizedPnl: -1, quantityText: '-0.01', entryPriceText: '60001.5', updateTime: 1800000000000, positionSide: 'BOTH' },
  ] })
  assert.equal(positionCalls, 2)
})

function orderMock(onOrder) {
  return (url, init) => {
    assert.equal(url.origin, 'https://fapi.binance.com')
    if (url.pathname === '/fapi/v1/exchangeInfo') return Response.json({ symbols: [market] })
    if (url.pathname === '/fapi/v2/ticker/price') return Response.json({ symbol: 'BTCUSDT', price: '11' })
    if (url.pathname === '/fapi/v1/premiumIndex') return Response.json({ symbol: 'BTCUSDT', markPrice: '10' })
    if (url.pathname === '/fapi/v3/positionRisk') return Response.json([])
    if (url.pathname === '/fapi/v2/account') return Response.json({ assets: [{ asset: 'USDT', availableBalance: '95.66886394' }] })
    if (url.pathname === '/fapi/v1/leverageBracket') return Response.json({ symbol: 'BTCUSDT',
      brackets: [{ initialLeverage: 150, notionalFloor: 0, notionalCap: 50_000 }] })
    assert.equal(url.pathname, '/fapi/v1/order')
    assert.equal(init.headers.get('X-MBX-APIKEY'), user.apiKey)
    const params = new URLSearchParams(init.body ?? url.search)
    assert.ok(params.has('signature'))
    return onOrder(params, init.method)
  }
}

function receipt(params) {
  const data = { symbol: 'BTCUSDT', orderId: 'RAW_INT64', clientOrderId: params.get('newClientOrderId') ?? params.get('origClientOrderId'),
    type: 'MARKET', side: params.get('side') ?? 'BUY', positionSide: params.get('positionSide'),
    status: 'FILLED', executedQty: params.get('quantity') ?? '1', avgPrice: '11' }
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

test('shared-position exits recheck the signed position and most recent order under the symbol lease', async () => {
  const actual = { quantityText: '-0.13', entryPriceText: '100', updateTime: 1800000000000 }
  let snapshot = { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: actual.quantityText,
    entryPrice: actual.entryPriceText, updateTime: actual.updateTime }
  let lastFill = { symbol: 'BTCUSDT', positionSide: 'BOTH', orderId: exchangeId }
  let orders = 0
  const mock = orderMock(params => {
    orders++
    assert.equal(params.get('quantity'), '0.03')
    assert.equal(params.get('reduceOnly'), 'true')
    assert.equal(params.get('side'), 'BUY')
    return receipt(params)
  })
  const client = exchange((url, init) => {
    if (url.pathname === '/fapi/v3/positionRisk') return Response.json([snapshot])
    if (url.pathname === '/fapi/v1/userTrades') return Response.json([lastFill])
    return mock(url, init)
  })
  const close = clientId => client.close('BTCUSDT', 'SHORT', 0.03, clientId, { actual, lastOrderId: exchangeId })
  await close('copy-slice')
  lastFill = { ...lastFill, orderId: '99' }
  await assert.rejects(close('replaced'), { code: 'SHARED_POSITION_CHANGED', definite: true })
  lastFill = { ...lastFill, orderId: exchangeId }
  snapshot = { ...snapshot, updateTime: actual.updateTime + 1 }
  await assert.rejects(close('changed'), { code: 'SHARED_POSITION_CHANGED', definite: true })
  assert.equal(orders, 1)
})

test('a first signal skips an intervening manual fill under the symbol lease before any leverage or order change', async () => {
  const now = 1_800_000_001_000
  const state = { enabled: true, config: { portfolioIds: [id], amount: 10, leverage: 2,
    sizingMode: 'margin', repeat: 'first', maxEntries: 1, maxPositions: 1, stopLoss: 5 },
    since: now - 1000, positions: [], events: [], pending: null }
  let claimed = false
  let rechecked = false
  let writes = 0
  const mock = orderMock(params => { writes++; return receipt(params) })
  const client = exchange((url, init) => {
    if (url.pathname.endsWith('/dual')) return Response.json({ dualSidePosition: false })
    if (url.pathname.endsWith('/positionRisk')) {
      if (!url.searchParams.has('symbol')) return Response.json([])
      assert.equal(url.searchParams.get('symbol'), 'BTCUSDT')
      assert.equal(claimed, true)
      rechecked = true
      return Response.json([{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.25', notional: '2.75' }])
    }
    if (url.pathname.endsWith('/leverage')) { writes++; return Response.json({ symbol: 'BTCUSDT', leverage: 2 }) }
    return mock(url, init)
  }, {
    claimFuturesSymbol() { claimed = true; return true },
    releaseFuturesSymbol() { claimed = false },
  })
  client.signals = async () => [{ id: 'first', symbol: 'BTCUSDT', direction: 'LONG', kind: 'open', time: now - 1 }]
  await runCopyTick(state, client, () => {}, now)
  assert.equal(rechecked, true)
  assert.equal(claimed, false)
  assert.equal(writes, 0)
  assert.equal(state.pending, null)
  assert.deepEqual(state.positions, [])
  assert.match(state.error, /已有仓位/)
})

test('first opens require a one-way, verifiably flat response for the exact requested symbol', async () => {
  const flat = { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '-0.000' }
  let mode = false
  let risk = []
  let writes = 0
  const mock = orderMock(params => { writes++; return receipt(params) })
  const client = exchange((url, init) => {
    if (url.pathname.endsWith('/dual')) return Response.json({ dualSidePosition: mode })
    if (url.pathname.endsWith('/positionRisk')) return Response.json(risk)
    return mock(url, init)
  })
  const open = key => client.open('BTCUSDT', 'LONG', 10, key, undefined, 'notional', { flat: true })
  await open('omitted-zero')
  risk = [flat]
  await open('explicit-zero')
  for (const [index, invalid] of [null, [null], [flat, flat], [{ ...flat, symbol: 'ETHUSDT' }],
    [{ ...flat, positionSide: 'SHORT' }], [{ ...flat, positionAmt: null }]].entries()) {
    risk = invalid
    await assert.rejects(open('bad-risk-' + index), { code: 'INVALID_UPSTREAM_DATA', definite: true })
  }
  risk = [{ ...flat, positionAmt: '-0.001' }]
  await assert.rejects(open('now-short'), { code: 'COPY_POSITION_NOT_FLAT', definite: true })
  risk = []
  mode = true
  await assert.rejects(open('changed-mode'), { code: 'COPY_POSITION_MODE_CHANGED', definite: true })
  mode = 'false'
  await assert.rejects(open('unknown-mode'), { code: 'INVALID_UPSTREAM_DATA', definite: true })
  assert.equal(writes, 2)
})

test('hedge mode tracks both sides of one symbol independently, including exits and stop loss', async () => {
  const now = 1_800_000_001_000
  const state = { enabled: true, config: { portfolioIds: [id], amount: 11, repeat: 'first',
    maxEntries: 1, maxPositions: 1, stopLoss: 5 }, since: now - 1000, positions: [], events: [], pending: null }
  const live = new Map()
  const orders = []
  const signals = []
  const mock = orderMock(params => {
    const positionSide = params.get('positionSide')
    const side = params.get('side')
    assert.equal(params.has('reduceOnly'), false)
    orders.push([positionSide, side, params.get('quantity')])
    if ((positionSide === 'LONG') === (side === 'BUY')) {
      live.set(positionSide, { symbol: 'BTCUSDT', positionSide, positionAmt: side === 'BUY' ? '1' : '-1',
        entryPrice: '11', markPrice: '11', unRealizedProfit: '0', updateTime: now + orders.length })
    } else {
      assert.ok(live.delete(positionSide))
    }
    return receipt(params)
  })
  const client = exchange((url, init) => {
    if (url.pathname.endsWith('/dual')) return Response.json({ dualSidePosition: true })
    if (url.pathname.endsWith('/positionRisk')) return Response.json([...live.values()])
    return mock(url, init)
  })
  client.signals = async () => signals
  function signal(id, offset, kind, direction, symbol = 'BTCUSDT') {
    signals.push({ id, symbol, direction, kind, time: now + offset })
  }
  signal('short-close-while-flat', -4, 'close', 'SHORT')
  signal('open-long', -4, 'open', 'LONG')
  signal('open-short', -3, 'open', 'SHORT')
  signal('over-symbol-cap', -2, 'open', 'LONG', 'ETHUSDT')
  await runCopyTick(state, client, () => {}, now)
  assert.deepEqual(state.positions.map(p => [p.positionSide, p.quantity]), [['LONG', 1], ['SHORT', 1]])
  assert.deepEqual(orders, [['LONG', 'BUY', '1'], ['SHORT', 'SELL', '1']])

  signal('lead-closes-long', 10, 'close', 'LONG')
  await runCopyTick(state, client, () => {}, now + 20)
  assert.deepEqual(state.positions.map(p => p.positionSide), ['SHORT'])
  assert.deepEqual([...live.keys()], ['SHORT'])
  assert.deepEqual(orders.at(-1), ['LONG', 'SELL', '1'])

  live.get('SHORT').unRealizedProfit = '-6'
  await runCopyTick(state, client, () => {}, now + 30)
  assert.deepEqual(state.positions, [])
  assert.deepEqual(orders.at(-1), ['SHORT', 'BUY', '1'])
  assert.equal(orders.length, 4)
})

test('hedge-mode shared exits validate the latest fill on that side and reject a wrong-leg receipt', async () => {
  const actual = { quantityText: '-0.13', entryPriceText: '100', updateTime: 1800000000000 }
  const short = { symbol: 'BTCUSDT', positionSide: 'SHORT', positionAmt: actual.quantityText,
    entryPrice: actual.entryPriceText, updateTime: actual.updateTime }
  const long = { ...short, positionSide: 'LONG', positionAmt: '0.2' }
  const fills = [{ symbol: 'BTCUSDT', positionSide: 'LONG', id: '103', orderId: '88' },
    { symbol: 'BTCUSDT', positionSide: 'SHORT', id: '102', orderId: exchangeId }]
  let writes = 0
  const mock = orderMock(params => {
    writes++
    assert.deepEqual([params.get('positionSide'), params.get('side'), params.get('quantity'), params.get('reduceOnly')],
      ['SHORT', 'BUY', '0.03', null])
    if (writes === 2) params.set('positionSide', 'LONG')
    return receipt(params)
  })
  const client = exchange((url, init) => {
    if (url.pathname === '/fapi/v3/positionRisk') return Response.json([short, long])
    if (url.pathname === '/fapi/v1/userTrades') return Response.json(fills)
    return mock(url, init)
  })
  const close = key => client.close('BTCUSDT', 'SHORT', 0.03, key, { positionSide: 'SHORT', actual, lastOrderId: exchangeId })
  assert.equal((await close('different-long-fill')).positionSide, 'SHORT')
  await assert.rejects(close('wrong-leg-receipt'), error => error.code === 'ORDER_UNKNOWN' && !error.definite)
  fills.push({ symbol: 'BTCUSDT', positionSide: 'SHORT', id: '104', orderId: '99' })
  await assert.rejects(close('different-short-fill'), { code: 'SHARED_POSITION_CHANGED', definite: true })
  assert.equal(writes, 2)
})

test('a leveraged entry applies the confirmed symbol leverage before sending its fixed notional and leaves exits reduce-only', async () => {
  const observed = []
  let rejectLeverage = false
  const mock = orderMock(params => {
    observed.push(['order', params.get('quantity'), params.get('reduceOnly')])
    return receipt(params)
  })
  const client = exchange((url, init) => {
    if (url.pathname !== '/fapi/v1/leverage') return mock(url, init)
    const params = new URLSearchParams(init.body)
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.get('X-MBX-APIKEY'), user.apiKey)
    assert.ok(params.has('signature'))
    observed.push(['leverage', params.get('symbol'), params.get('leverage')])
    return Response.json({ symbol: 'BTCUSDT', leverage: rejectLeverage ? 1 : 10, maxNotionalValue: '10000' })
  })
  await client.open('BTCUSDT', 'LONG', '12.345', 'open', 10)
  await client.close('BTCUSDT', 'LONG', '1.12', 'exit')
  rejectLeverage = true
  await assert.rejects(client.open('BTCUSDT', 'LONG', '12.345', 'rejected', 10), { definite: true })
  assert.deepEqual(observed, [
    ['leverage', 'BTCUSDT', '10'], ['order', '1.12', null],
    ['order', '1.12', 'true'], ['leverage', 'BTCUSDT', '10'],
  ])
})

test('fixed margin and current equity percentage size each entry before lot rounding; invalid equity blocks the order', async () => {
  const quantities = []
  let equity = '1000'
  let equityReads = 0
  let leverageChanges = 0
  const mock = orderMock(params => {
    quantities.push(params.get('quantity'))
    return receipt(params)
  })
  const client = exchange((url, init) => {
    if (url.pathname === '/fapi/v2/account') {
      assert.equal(init.headers.get('X-MBX-APIKEY'), user.apiKey)
      assert.ok(url.searchParams.has('signature'))
      equityReads++
      return Response.json({ multiAssetsMargin: false, totalMarginBalance: equity,
        assets: [{ asset: 'USDT', availableBalance: '95.66886394', walletBalance: '800' }] })
    }
    if (url.pathname === '/fapi/v1/leverage') {
      leverageChanges++
      const params = new URLSearchParams(init.body)
      return Response.json({ symbol: 'BTCUSDT', leverage: Number(params.get('leverage')), maxNotionalValue: '10000' })
    }
    return mock(url, init)
  })
  await client.open('BTCUSDT', 'LONG', '10.01', 'fixed', 10, 'margin')
  assert.equal(equityReads, 1)
  await client.open('BTCUSDT', 'LONG', '2.3', 'percent', 5, 'equityPercent')
  equity = '500'
  await client.open('BTCUSDT', 'LONG', '2.3', 'add', 5, 'equityPercent')
  assert.deepEqual(quantities, ['9.1', '10.45', '5.22'])
  for (const [index, balance] of [undefined, '0', '-1'].entries()) {
    equity = balance
    await assert.rejects(client.open('BTCUSDT', 'LONG', '2.3', 'invalid-equity-' + index, 5, 'equityPercent'),
      { code: balance === undefined ? 'INVALID_UPSTREAM_DATA' : 'FUTURES_EQUITY_UNAVAILABLE', definite: true })
  }
  assert.equal(equityReads, 6)
  assert.equal(leverageChanges, 3)
  assert.equal(quantities.length, 3)
})

test('each entry checks the fresh USDT budget before leverage and never gates a reduce-only exit', async () => {
  let funds = '95.66886394'
  let reads = 0
  const actions = []
  const mock = orderMock((params) => { actions.push(params.get('reduceOnly') || 'open'); return receipt(params) })
  const client = exchange((url, init) => {
    if (url.pathname === '/fapi/v2/account') {
      reads++
      return Response.json({ multiAssetsMargin: false, totalMarginBalance: '1000', assets: [
        { asset: 'USDC', availableBalance: '200' }, { asset: 'USDT', walletBalance: '106.60875902', availableBalance: funds },
      ] })
    }
    if (url.pathname === '/fapi/v1/leverage') {
      actions.push('leverage')
      return Response.json({ symbol: 'BTCUSDT', leverage: 2 })
    }
    return mock(url, init)
  })
  for (const [mode, amount] of [['margin', 100], ['equityPercent', 10], ['notional', 200]]) {
    await assert.rejects(client.open('BTCUSDT', 'LONG', amount, 'large-' + mode, 2, mode),
      { code: 'INSUFFICIENT_AVAILABLE_MARGIN', definite: true })
  }
  await client.open('BTCUSDT', 'LONG', 10, 'small', 2, 'margin')
  funds = '1'
  await assert.rejects(client.open('BTCUSDT', 'LONG', 10, 'add', 2, 'margin'),
    { code: 'INSUFFICIENT_AVAILABLE_MARGIN', definite: true })
  await client.close('BTCUSDT', 'LONG', '0.1', 'close')
  assert.equal(reads, 5)
  assert.deepEqual(actions, ['leverage', 'open', 'true'])
})

test('fixed leverage is capped by the actual symbol and projected position before sizing fixed and percent margins', async () => {
  let existing = '0'
  let symbolMaximum = 150
  let available = true
  const sent = []
  const mock = orderMock(params => { sent.push(params.get('quantity')); return receipt(params) })
  const client = exchange((url, init) => {
    if (url.pathname === '/fapi/v1/leverageBracket') {
      assert.equal(url.searchParams.get('symbol'), 'BTCUSDT')
      assert.ok(url.searchParams.get('signature'))
      return available ? Response.json({ symbol: 'BTCUSDT', brackets: [
        { notionalFloor: 0, notionalCap: 100, initialLeverage: symbolMaximum },
        { notionalFloor: 100, notionalCap: 10000, initialLeverage: Math.min(60, symbolMaximum) },
      ] }) : new Response('', { status: 429, headers: { 'Retry-After': '11' } })
    }
    if (url.pathname === '/fapi/v3/positionRisk') return Response.json([{ symbol: 'BTCUSDT', notional: existing }])
    if (url.pathname === '/fapi/v2/account') return Response.json({ multiAssetsMargin: false, totalMarginBalance: '100',
      assets: [{ asset: 'USDT', availableBalance: '50' }] })
    if (url.pathname === '/fapi/v1/leverage') {
      const requested = Number(new URLSearchParams(init.body).get('leverage'))
      sent.push(requested)
      return Response.json({ symbol: 'BTCUSDT', leverage: requested })
    }
    return mock(url, init)
  })
  await client.open('BTCUSDT', 'LONG', 0.1, 'valid', 150, 'margin')
  existing = '90'
  await client.open('BTCUSDT', 'LONG', 0.1, 'smaller-margin', 150, 'margin')
  await client.open('BTCUSDT', 'LONG', 1, 'smaller-equity', 150, 'equityPercent')
  existing = '0'
  symbolMaximum = 5
  await client.open('BTCUSDT', 'LONG', 2, 'five-times', 10, 'margin')
  available = false
  await assert.rejects(client.open('BTCUSDT', 'LONG', 0.1, 'limited', 150, 'margin'),
    { code: 'COPY_LEVERAGE_UNAVAILABLE', status: 429, headers: { 'Retry-After': '11' }, definite: true })
  assert.deepEqual(sent, [150, '1.36', 111, '1', 60, '5.45', 5, '0.9'])
})

test('automatic and custom leverage use the symbol maximum and respect the projected bracket under the symbol lease', async () => {
  let claimed = false
  let existing = '0'
  let symbolMaximum = 150
  let available = '50'
  let accountReads = 0
  const sent = []
  const mock = orderMock(params => { sent.push(params.get('quantity')); return receipt(params) })
  const client = exchange((url, init) => {
    if (url.pathname === '/fapi/v1/leverageBracket') {
      assert.equal(claimed, true)
      assert.equal(url.searchParams.get('symbol'), 'BTCUSDT')
      return Response.json({ symbol: 'BTCUSDT', brackets: [
        { notionalFloor: 0, notionalCap: 100, initialLeverage: symbolMaximum },
        { notionalFloor: 100, notionalCap: 10000, initialLeverage: Math.min(60, symbolMaximum) },
      ] })
    }
    if (url.pathname === '/fapi/v3/positionRisk') return Response.json([{ symbol: 'BTCUSDT', notional: existing }])
    if (url.pathname === '/fapi/v2/account') {
      accountReads++
      return Response.json({ multiAssetsMargin: false, totalMarginBalance: '100',
        assets: [{ asset: 'USDT', availableBalance: available }] })
    }
    if (url.pathname === '/fapi/v1/leverage') {
      assert.equal(claimed, true)
      const leverage = Number(new URLSearchParams(init.body).get('leverage'))
      sent.push(leverage)
      return Response.json({ symbol: 'BTCUSDT', leverage })
    }
    return mock(url, init)
  }, {
    claimFuturesSymbol() { claimed = true; return true },
    releaseFuturesSymbol() { claimed = false },
  })
  await client.open('BTCUSDT', 'LONG', 0.1, 'max-flat', 'max', 'margin')
  const custom = { 150: 50, 100: 20 }
  await client.open('BTCUSDT', 'LONG', 0.22, 'custom-150', custom, 'margin')
  existing = '90'
  await client.open('BTCUSDT', 'LONG', 0.1, 'max-add', 'max', 'equityPercent')
  await client.open('BTCUSDT', 'LONG', 1, 'custom-add', { 150: 75 }, 'equityPercent')
  existing = '10000'
  await assert.rejects(client.open('BTCUSDT', 'LONG', 1, 'max-full', 'max', 'margin'),
    { code: 'COPY_LEVERAGE_LIMIT', definite: true })
  existing = '0'
  symbolMaximum = 100
  await client.open('BTCUSDT', 'LONG', 0.55, 'custom-100', custom, 'margin')
  symbolMaximum = 125
  await client.open('BTCUSDT', 'LONG', 0.1, 'custom-unlisted', custom, 'margin')
  available = '0'
  await assert.rejects(client.open('BTCUSDT', 'LONG', 0.1, 'max-budget', 'max', 'margin'),
    { code: 'INSUFFICIENT_AVAILABLE_MARGIN', definite: true })
  assert.equal(claimed, false)
  assert.equal(accountReads, 8)
  assert.deepEqual(sent, [150, '1.36', 50, '1', 111, '1', 60, '5.45', 20, '1', 125, '1.13'])
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
