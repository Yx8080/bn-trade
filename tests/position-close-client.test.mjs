import assert from 'node:assert/strict'
import test from 'node:test'
import { closePosition, getClosePositionRules, lookupOrder } from '../src/futures.ts'
import { closePercentQuantity, closeQuantityIssue } from '../src/position-close.ts'

const rules = { stepSize: '0.005', minQty: '0.005', maxQty: '1000' }

test('部分平仓按仓位数量计算比例，并向下对齐非十进制步长', () => {
  assert.equal(closePercentQuantity('0.135', 25, rules.stepSize), '0.03')
  assert.equal(closePercentQuantity('0.135', 40, rules.stepSize), '0.05')
  assert.equal(closePercentQuantity('0.135', 50, rules.stepSize), '0.065')
  assert.equal(closePercentQuantity('0.135', 75, rules.stepSize), '0.1')
  assert.equal(closePercentQuantity('0.135', 100, rules.stepSize), '0.135')
  assert.equal(closePercentQuantity('0.900719925474099303', 50, '0.000000000000000001'), '0.450359962737049651')
  for (const percent of [0, 101, 40.5]) assert.equal(closePercentQuantity('0.135', percent, rules.stepSize), '')
})

test('数量校验使用精确小数，允许整仓数量并拦截超仓、步长及市场数量限制', () => {
  for (const qty of ['0.005', '0.03', '0.135']) assert.equal(closeQuantityIssue(qty, '0.135', rules), '')
  for (const qty of ['', '0', '-0.005', '1e-2', '0.032', '0.140']) assert.ok(closeQuantityIssue(qty, '0.135', rules))
  assert.ok(closeQuantityIssue('0.005', '0.135', { ...rules, minQty: '0.01' }))
  assert.ok(closeQuantityIssue('1.005', '2', { ...rules, maxQty: '1' }))
  const tinyStep = { stepSize: '0.000000000000000001', minQty: '0.000000000000000001', maxQty: '1' }
  assert.ok(closeQuantityIssue('0.900719925474099304', '0.900719925474099303', tinyStep))
  assert.equal(closeQuantityIssue('0.900719925474099303', '0.900719925474099303', tinyStep), '')
})

const order = {
  environment: 'testnet', symbol: 'BTCUSDT', positionSide: 'BOTH', direction: 'SHORT',
  expectedQuantity: '0.135', expectedUpdateTime: 1700000000000, quantity: '0.03', clientOrderId: 'close-short-btc',
}

test('部分平仓传入所选仓位快照，仓位过期时返回服务端拒单结果', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push(init.method)
    const url = new URL(path, 'http://localhost')
    assert.equal(url.pathname, '/api/futures/close-position')
    assert.equal(init.headers.get('Authorization'), 'Bearer test-token')
    assert.equal(init.headers.get('X-Trading-Environment'), 'testnet')
    if (init.method === 'GET') {
      assert.equal(url.searchParams.get('symbol'), 'BTCUSDT')
      return Response.json({ ...rules, environment: 'testnet', symbol: 'BTCUSDT', baseAsset: 'BTC' })
    }
    assert.equal(init.method, 'POST')
    assert.deepEqual(JSON.parse(init.body), order)
    return Response.json({ code: 'POSITION_CHANGED', message: '持仓已变化' }, { status: 409 })
  })
  const limits = await getClosePositionRules('test-token', 'BTCUSDT', 'testnet')
  assert.equal(limits.stepSize, rules.stepSize)
  await assert.rejects(closePosition('test-token', order), { code: 'POSITION_CHANGED', status: 409 })
  assert.deepEqual(calls, ['GET', 'POST'])
})

test('平仓回执中断后按原订单号查询，不再次发送平仓指令', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push(init.method)
    if (init.method === 'POST') throw new TypeError('模拟回执中断')
    const url = new URL(path, 'http://localhost')
    assert.equal(url.pathname, '/api/futures/orders')
    assert.equal(url.searchParams.get('clientOrderId'), order.clientOrderId)
    return Response.json({ symbol: order.symbol, clientOrderId: order.clientOrderId, orderId: '812345678901234567',
      type: 'MARKET', side: 'BUY', status: 'FILLED', executedQty: '0.03', avgPrice: '50000' })
  })
  await assert.rejects(closePosition('test-token', order), { code: 'ORDER_UNKNOWN' })
  const fill = await lookupOrder('test-token', order.symbol, order.clientOrderId)
  assert.equal(fill.executedQty, '0.03')
  assert.deepEqual(calls, ['POST', 'GET'])
})
