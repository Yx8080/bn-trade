import assert from 'node:assert/strict'
import test from 'node:test'
import { getCopyPnl, getCopyStatus, updateCopyStatus } from '../src/futures.ts'

test('跟单盈亏按页和当前账户读取，保留不同结算币种与待结算状态', async t => {
  const page = {
    totals: [{ asset: 'USDT', realized: 2, fees: 0, net: 2 }, { asset: 'BNB', realized: 0, fees: 0.01, net: -0.01 }],
    unrealized: null, openCount: 1, unrealizedAt: null, pendingCount: 1, total: 21, pageSize: 20,
    rows: [{ clientOrderId: 'pending', symbol: 'ETHUSDT', portfolioId: '123', direction: 'SHORT', kind: 'close',
      time: 1, quantity: 1, price: 20, settled: false, amounts: [] }],
  }
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    assert.equal(path, '/api/futures/copy-pnl?page=2')
    assert.equal(init.method, 'GET')
    assert.equal(init.headers.get('authorization'), 'Bearer test-pnl')
    return Response.json(page)
  })
  assert.deepEqual(await getCopyPnl('test-pnl', 2), page)
})

test('跟单状态只读，启动与暂停带上当前环境和账户令牌', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    assert.equal(path, '/api/futures/copy')
    assert.equal(init.headers.get('authorization'), 'Bearer mock-token')
    calls.push([init.method, init.body && JSON.parse(init.body)])
    return Response.json({ enabled: init.method === 'POST' && calls.length === 2,
      config: null, positions: [], events: [], lastCheck: null, error: '', pending: null })
  })
  const config = { portfolioId: '123', repeat: 'fixed', amount: 100, maxEntries: 2, maxPositions: 2, stopLoss: 5 }
  const start = { action: 'start', environment: 'testnet', config }
  const pause = { action: 'pause', environment: 'testnet' }
  await getCopyStatus('mock-token')
  assert.equal((await updateCopyStatus('mock-token', start)).enabled, true)
  assert.equal((await updateCopyStatus('mock-token', pause)).enabled, false)
  assert.deepEqual(calls, [['GET', undefined], ['POST', start], ['POST', pause]])
})

test('跟单回执丢失时提示核对状态，不向服务端重复提交', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => new Response('Bad Gateway', { status: 502 }))
  await assert.rejects(updateCopyStatus('mock-token', { action: 'pause', environment: 'testnet' }), { code: 'COPY_UNKNOWN' })
  assert.equal(fetch.mock.callCount(), 1)
})
