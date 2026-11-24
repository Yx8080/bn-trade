import assert from 'node:assert/strict'
import test from 'node:test'
import { buySpot, lookupSpotOrder } from '../src/futures.ts'

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
