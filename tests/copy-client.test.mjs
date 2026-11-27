import assert from 'node:assert/strict'
import test from 'node:test'
import { getCopyPnl, getCopyStatus, getFuturesPositionHistory, getOtherTrades, getPlatformPnl, getPlatformValuation, getPositionSources, updateCopyStatus } from '../src/futures.ts'

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
  const config = { portfolioIds: ['123', '456'], leverage: 10, sizingMode: 'equityPercent', repeat: 'fixed', manualPositionPolicy: 'add', amount: 2, maxEntries: 2, maxPositions: 2, stopLoss: 5 }
  const start = { action: 'start', environment: 'live', config }
  const pause = { action: 'pause', environment: 'live' }
  await getCopyStatus('mock-token')
  assert.equal((await updateCopyStatus('mock-token', start)).enabled, true)
  assert.equal((await updateCopyStatus('mock-token', pause)).enabled, false)
  assert.deepEqual(calls, [['GET', undefined], ['POST', start], ['POST', pause]])
})

test('跟单回执丢失时提示核对状态，不向服务端重复提交', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => new Response('Bad Gateway', { status: 502 }))
  await assert.rejects(updateCopyStatus('mock-token', { action: 'pause', environment: 'live' }), { code: 'COPY_UNKNOWN' })
  assert.equal(fetch.mock.callCount(), 1)
})

test('平台手动账本、估值和交易所查询可独立读取，切换市场和交易对使用对应账号凭证', async t => {
  const urls = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    urls.push(url)
    assert.equal(init.method, 'GET')
    assert.equal(init.headers.get('authorization'), 'Bearer test-view')
    return url.includes('other-trades') ? Response.json({ message: '交易所暂不可用' }, { status: 503 }) : Response.json({ total: 2 })
  })
  assert.equal((await getPlatformPnl('test-view', 3)).total, 2)
  await getPlatformValuation('test-view')
  await assert.rejects(getOtherTrades('test-view', 'spot', 'ETHBTC'), /交易所暂不可用/)
  assert.deepEqual(urls, ['/api/platform/pnl?page=3', '/api/platform/valuation', '/api/futures/other-trades?market=spot&symbol=ETHBTC'])
})

test('合约账户按当前会话读取来源、全账户仓位历史和指定交易对的其他成交', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.method, 'GET')
    assert.equal(init.headers.get('authorization'), 'Bearer demo-token')
    calls.push(url)
    return Response.json({})
  })
  await getPositionSources('demo-token')
  await getFuturesPositionHistory('demo-token', 'live')
  await getOtherTrades('demo-token', 'futures', 'ETHUSDT')
  assert.deepEqual(calls, ['/api/futures/position-sources', '/api/futures/position-history',
    '/api/futures/other-trades?market=futures&symbol=ETHUSDT'])
})
