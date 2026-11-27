import assert from 'node:assert/strict'
import test from 'node:test'
import { futuresPositionHistory } from './futures-position-history.js'

const day = 86_400_000
const now = 1_800_000_000_000
const token = 'history-token'
const credentials = [{ id: 'fixture', name: 'Fixture', token, apiKey: 'history-key', apiSecret: 'history-secret' }]
const request = new Request('http://localhost/api/futures/position-history', { headers: { Authorization: 'Bearer ' + token } })

function fill(symbol, id, positionSide, side, offset, qty, price, realizedPnl = '0') {
  return { symbol, id: String(id), positionSide, side, time: now + offset, qty, price, realizedPnl }
}

function position(symbol, positionSide, positionAmt) {
  return { symbol, positionSide, positionAmt, entryPrice: '100', markPrice: '101', unRealizedProfit: '0',
    marginAsset: 'USDT', updateTime: now - 1 }
}

function fixture({ fills = [], orders = [], income = [], config = [], risk = () => [] } = {}) {
  const requests = []
  let snapshots = 0
  const env = { BINANCE_FUTURES_USERS: JSON.stringify(credentials), async fetchBinance(url, init) {
    assert.equal(url.origin, 'https://fapi.binance.com')
    assert.equal(init.method, 'GET')
    assert.equal(init.headers.get('X-MBX-APIKEY'), 'history-key')
    assert.ok(url.searchParams.has('signature'))
    const symbol = url.searchParams.get('symbol')
    const start = Number(url.searchParams.get('startTime'))
    const end = Number(url.searchParams.get('endTime'))
    requests.push({ path: url.pathname, symbol, start, end })
    switch (url.pathname) {
      case '/fapi/v3/positionRisk': return Response.json(risk(++snapshots))
      case '/fapi/v1/allOrders': {
        assert.equal(symbol, null)
        return Response.json(orders.filter(row => row.time >= start && row.time <= end).slice(0, 1000))
      }
      case '/fapi/v1/income':
        assert.equal(symbol, null)
        return Response.json(income.filter(row => row.time >= start && row.time <= end).slice(0, 1000))
      case '/fapi/v1/symbolConfig':
        assert.equal(symbol, null)
        return config instanceof Response ? config : Response.json(config)
      case '/fapi/v1/userTrades':
        assert.ok(end - start <= 7 * day)
        return Response.json(fills.filter(row => row.symbol === symbol && row.time >= start && row.time <= end).slice(0, 1000))
      default: assert.fail('Unexpected exchange request ' + url.pathname)
    }
  } }
  return { requests, run: (incoming = request) => futuresPositionHistory(incoming, env) }
}

test('account history finds symbols without input, separates hedge legs, and looks back for a pre-window entry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now })
  const symbol = 'XAGUSDT'
  const other = 'ETHUSDC'
  const market = fixture({
    orders: [{ symbol, executedQty: '2', time: now - 10 }, { symbol: 'BTCUSD_PERP', executedQty: '1', time: now - 10 },
      { symbol: 'NEWORDERUSDT', executedQty: '0', time: now - 10 }],
    income: [{ symbol: other, incomeType: 'REALIZED_PNL', time: now - 20 }],
    risk: () => [position(symbol, 'LONG', '0.1')],
    fills: [
      fill(symbol, 1, 'LONG', 'BUY', -101, '2', '100'),
      fill(symbol, 2, 'SHORT', 'SELL', -100, '1', '110'),
      fill(symbol, 4, 'LONG', 'BUY', -60, '0.5', '105'),
      fill(symbol, 3, 'LONG', 'SELL', -60, '0.5', '110', '5'),
      fill(symbol, 5, 'SHORT', 'BUY', -50, '0.25', '100', '2.5'),
      fill(symbol, 7, 'SHORT', 'BUY', -40, '0.75', '115', '-3.75'),
      fill(symbol, 8, 'LONG', 'SELL', -30, '2', '105', '9'),
      fill(symbol, 9, 'LONG', 'BUY', -10, '0.1', '110'),
      fill(other, 1, 'BOTH', 'BUY', -9 * day, '0.25', '95'),
      fill(other, 2, 'BOTH', 'SELL', -20, '0.25', '100', '1.25'),
    ],
  })
  const response = await market.run()
  assert.equal(response.status, 200)
  const { rows, asOf } = await response.json()
  assert.equal(asOf, now)
  assert.deepEqual(rows.map(row => [row.symbol, row.direction, row.closedQuantity, row.avgEntryPrice, row.avgClosePrice,
    row.realizedPnl, row.asset, row.openedAt, row.closedAt]), [
    [other, 'LONG', '0.25', '95', '100', '1.25', 'USDC', now - 9 * day, now - 20],
    [symbol, 'LONG', '2.5', '101', '106', '14', 'USDT', now - 101, now - 30],
    [symbol, 'SHORT', '1', '110', '111.25', '-1.25', 'USDT', now - 100, now - 40],
  ])
  assert.deepEqual(new Set(market.requests.filter(call => call.symbol).map(call => call.symbol)), new Set([symbol, other]))
})

test('a one-way reversal reuses only the excess for the new position, with partial exits omitted until flat', async t => {
  t.mock.timers.enable({ apis: ['Date'], now })
  const symbol = 'BTCUSDT'
  const market = fixture({
    orders: [{ symbol, executedQty: '0.3', time: now - 10 }],
    risk: () => [position(symbol, 'BOTH', '0.05')],
    fills: [
      fill(symbol, 1, 'BOTH', 'BUY', -200, '0.3', '10'),
      fill(symbol, 2, 'BOTH', 'SELL', -150, '0.5', '12', '0.6'),
      fill(symbol, 3, 'BOTH', 'BUY', -100, '0.2', '10', '0.4'),
      fill(symbol, 4, 'BOTH', 'BUY', -60, '0.1', '10'),
      fill(symbol, 5, 'BOTH', 'SELL', -30, '0.05', '11', '0.05'),
    ],
  })
  const response = await market.run()
  assert.equal(response.status, 200)
  const { rows } = await response.json()
  assert.deepEqual(rows.map(row => [row.direction, row.closedQuantity, row.realizedPnl, row.avgEntryPrice, row.avgClosePrice]), [
    ['SHORT', '0.2', '0.4', '12', '10'], ['LONG', '0.3', '0.6', '10', '12'],
  ])
})

test('trade windows that reach the exchange limit are split without losing a complete close', async t => {
  t.mock.timers.enable({ apis: ['Date'], now })
  const symbol = 'BTCUSDT'
  const pending = Array.from({ length: 1000 }, (_, index) => fill(symbol, index + 1, 'LONG', 'BUY', -6 * day + index, '1', '10'))
  const market = fixture({ orders: [{ symbol, executedQty: '1000', time: now - 20 }],
    fills: [...pending, fill(symbol, 1001, 'LONG', 'SELL', -20, '1000', '11', '1000')] })
  const response = await market.run()
  assert.equal(response.status, 200)
  const { rows } = await response.json()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].closedQuantity, '1000')
  assert.equal(rows[0].realizedPnl, '1000')
  assert.ok(market.requests.filter(call => call.symbol === symbol).length > 2)
})

test('history estimates return from the whole opening notional, keeps hedge sides separate, and tolerates missing leverage', async t => {
  t.mock.timers.enable({ apis: ['Date'], now })
  const symbol = 'BTCUSDT'
  const market = {
    orders: [{ symbol, executedQty: '2', time: now - 20 }],
    fills: [fill(symbol, 1, 'LONG', 'BUY', -60, '1', '95'), fill(symbol, 2, 'SHORT', 'SELL', -55, '1', '100'),
      fill(symbol, 3, 'LONG', 'BUY', -50, '1', '105'), fill(symbol, 4, 'LONG', 'SELL', -45, '2', '105', '10'),
      fill(symbol, 5, 'SHORT', 'BUY', -40, '1', '110', '-10')],
  }
  const response = await fixture({ ...market, config: [{ symbol, leverage: 10 }] }).run()
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).rows.map(row => [row.direction, row.roi, row.roiLeverage]), [
    ['SHORT', -1, 10], ['LONG', 0.5, 10],
  ])

  const unavailable = fixture({ ...market, config: new Response('', { status: 503 }) })
  const withoutLeverage = await unavailable.run()
  assert.equal(withoutLeverage.status, 200)
  assert.deepEqual((await withoutLeverage.json()).rows.map(row => [row.realizedPnl, row.roi, row.roiLeverage]), [
    ['-10', null, null], ['10', null, null],
  ])
})

test('missing older entries stay unverified and a changed account snapshot yields a retryable error', async t => {
  t.mock.timers.enable({ apis: ['Date'], now })
  const symbol = 'BTCUSDT'
  const market = fixture({ orders: [{ symbol, executedQty: '2', time: now - 20 }],
    fills: [fill(symbol, 1, 'LONG', 'SELL', -20, '2', '11', '1')] })
  const response = await market.run()
  assert.equal(response.status, 200)
  const { rows } = await response.json()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].closedAt, now - 20)
  assert.equal(rows[0].openedAt, null)
  assert.equal(rows[0].realizedPnl, null)

  const changed = fixture({ risk: snapshot => snapshot === 1 ? [] : [position(symbol, 'LONG', '1')] })
  const stale = await changed.run()
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).code, 'POSITION_HISTORY_CHANGED')
  const unauthorized = await changed.run(new Request(request.url))
  assert.equal(unauthorized.status, 401)
})
