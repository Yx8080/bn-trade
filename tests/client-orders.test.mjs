import assert from 'node:assert/strict'
import test from 'node:test'
import { buySpot, getFuturesPositionMode, lookupSpotOrder, selectEnvironment, submitOrder } from '../src/futures.ts'
import { estimateOpeningMargin, manualOpeningDirection } from '../src/manual-opening.ts'
import { amountFromBalance, availableUsdt } from '../src/opening-funds.ts'

test('opening presets use spendable USDT and round fractional shares down to eight decimals', () => {
  const available = availableUsdt([
    { asset: 'USDC', walletBalance: '200', availableBalance: '200' },
    { asset: 'USDT', walletBalance: '106.60875902', availableBalance: '95.66886394' },
  ])
  assert.equal(available, 95.66886394)
  assert.deepEqual([10, 25, 50, 100].map(p => amountFromBalance(available, p)), [9.56688639, 23.91721598, 47.83443197, 95.66886394])
  assert.equal(availableUsdt([]), null)
  assert.equal(availableUsdt([{ asset: 'USDT', availableBalance: '' }]), null)
  assert.equal(availableUsdt([{ asset: 'USDT', availableBalance: '0' }]), 0)
  assert.equal(amountFromBalance(-5, 100), 0)
  assert.equal(amountFromBalance(1e-8, 50), 0)
})

test('margin slider accepts every integer percentage and never rounds above the available balance', () => {
  const available = 95.66886394
  for (const [pct, amount] of [[0, 0], [1, 0.95668863], [37, 35.39747965], [75, 71.75164795], [99, 94.7121753]]) {
    assert.equal(amountFromBalance(available, pct), amount)
  }
  for (const invalid of [-1, 12.5, 101, NaN, Infinity]) assert.equal(amountFromBalance(available, invalid), 0)
  assert.equal(amountFromBalance(1.000000009, 100), 1)
  assert.equal(amountFromBalance(1e-8, 100), 1e-8)
})

test('手动开多和开空按账户模式指定方向，均不发送仅减仓参数', () => {
  const cases = [
    ['oneWay', 'LONG',  { side: 'BUY',  positionSide: 'BOTH' }],
    ['oneWay', 'SHORT', { side: 'SELL', positionSide: 'BOTH' }],
    ['hedge',  'LONG',  { side: 'BUY',  positionSide: 'LONG' }],
    ['hedge',  'SHORT', { side: 'SELL', positionSide: 'SHORT' }],
  ]
  for (const [mode, direction, expected] of cases) {
    assert.deepEqual(manualOpeningDirection(mode, direction), expected, [mode, direction].join('/'))
  }
})

test('手动合约只采用当前环境明确返回的持仓模式', async t => {
  selectEnvironment('testnet')
  t.after(() => selectEnvironment('testnet'))
  let reply = { environment: 'testnet', mode: 'hedge' }
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    assert.equal(path, '/api/futures/position-mode')
    assert.equal(init.headers.get('X-Trading-Environment'), 'testnet')
    assert.equal(init.headers.get('Authorization'), 'Bearer test-token')
    return Response.json(reply)
  })
  const read = () => getFuturesPositionMode('test-token', 'testnet')
  assert.equal(await read(), 'hedge')
  reply = { environment: 'testnet', mode: null }
  await assert.rejects(read(), /持仓模式无效/)
  reply = { environment: 'live', mode: 'oneWay' }
  await assert.rejects(read(), { code: 'ENVIRONMENT_CHANGED' })
  reply = { environment: 'testnet', mode: 'oneWay' }
  const beforeSwitch = read()
  selectEnvironment('live')
  await assert.rejects(beforeSwitch, { code: 'ENVIRONMENT_CHANGED' })
})

test('手动开仓以 USDT 保证金衡量固定金额和合约数量', () => {
  const buy = { symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH' }
  assert.equal(estimateOpeningMargin({ margin: 100 }, buy, [], 0, undefined), 100)
  assert.equal(estimateOpeningMargin({ quantity: 0.01 }, buy, [], 50_000, 10), 50)
  assert.equal(estimateOpeningMargin({ quantity: 0.01 }, buy, [], 50_000, undefined), null)
})

test('仅将同一交易对的反向单向持仓抵扣开仓保证金', () => {
  const positions = [{ symbol: 'BTCUSDT', positionSide: 'BOTH', quantity: '0.02' }]
  const sell = { symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH' }
  assert.equal(estimateOpeningMargin({ quantity: 0.01 }, sell, positions, 0, undefined), 0)
  assert.equal(estimateOpeningMargin({ margin: 125 }, sell, positions, 50_000, 10), 25)
  assert.equal(estimateOpeningMargin({ margin: 125 }, { ...sell, positionSide: 'SHORT' }, positions, 50_000, 10), 125)
  assert.equal(estimateOpeningMargin({ margin: 125 }, { ...sell, symbol: 'ETHUSDT' }, positions, 50_000, 10), 125)
  assert.equal(estimateOpeningMargin({ margin: 125 }, { ...sell, side: 'BUY' }, positions, 50_000, 10), 125)
})

test('丢失回执后保留原订单号，只发起查询', async t => {
  const order = { environment: 'testnet', symbol: 'BTCUSDT', quoteOrderQty: '10.00', clientOrderId: 'existing-id' }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push({ path, method: init.method })
    assert.equal(init.headers.get('Authorization'), 'Bearer test-token')
    if (init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), order)
      return new Response('Bad gateway', { status: 502 })
    }
    return Response.json({ ...order, orderId: '990000000000000001', status: 'FILLED',
      side: 'BUY', type: 'MARKET', executedQty: '0.001', avgPrice: '10000' })
  })
  await assert.rejects(buySpot('test-token', order), { code: 'ORDER_UNKNOWN' })
  const result = await lookupSpotOrder('test-token', order.symbol, order.clientOrderId)
  assert.equal(result.orderId, '990000000000000001')
  assert.deepEqual(calls, [
    { path: '/api/spot/orders', method: 'POST' },
    { path: '/api/spot/orders?symbol=BTCUSDT&clientOrderId=existing-id', method: 'GET' },
  ])
})

test('杠杆设置未获确认时保留服务端拒单原因', async t => {
  const order = { environment: 'testnet', symbol: 'BTCUSDT', leverage: 10, side: 'BUY',
    positionSide: 'BOTH', type: 'MARKET', quantity: '0.001', clientOrderId: 'with-leverage' }
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    assert.equal(path, '/api/futures/orders')
    assert.deepEqual(JSON.parse(init.body), order)
    return Response.json({ code: 'LEVERAGE_NOT_CONFIRMED', message: '未能确认杠杆，订单未提交。' }, { status: 502 })
  })
  await assert.rejects(submitOrder('test-token', order), { code: 'LEVERAGE_NOT_CONFIRMED', status: 502 })
})
