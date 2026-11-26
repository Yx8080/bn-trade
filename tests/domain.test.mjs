import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchObservedTrades, fetchClosedPositions, fetchObservationStatus, saveMonitoredPortfolios, formatTradeAmount, TradeRequestError } from '../src/trades.ts'
import { linearPnl, linearPnlFromMargin, reportedPnl, summarizeReportedPnl } from '../src/pnl.ts'
import { loadWatchlist, saveWatchlist } from '../src/portfolios.ts'

test('成交金额按绝对值选择显示精度，披露盈亏在汇总后取舍小数', () => {
  assert.equal(formatTradeAmount(841.810292), '841.81')
  assert.equal(formatTradeAmount(170087.7694986), '170,087.77')
  assert.equal(formatTradeAmount(-1560), '-1,560.00')
  assert.equal(formatTradeAmount(1), '1')
  assert.equal(formatTradeAmount(0), '0')
  assert.equal(formatTradeAmount(0.0000001), '0.0000001')
  assert.equal(formatTradeAmount(0.0000000012), '0.0000000012')
  assert.equal(formatTradeAmount(null), '—')

  const close = { positionSide: 'LONG', side: 'SELL', executedQty: 1, quoteAsset: 'USDT', totalPnl: 3.004 }
  const [summary] = summarizeReportedPnl([close, close])
  assert.equal(formatTradeAmount(reportedPnl(close)), '3.00')
  assert.equal(summary.pnl, 6.008)
  assert.equal(formatTradeAmount(summary.pnl), '6.01')
})

test('公开查询保留服务端错误说明和限流时间，纯文本错误回退到 HTTP 状态', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () =>
    Response.json({ message: '服务端连接币安超时。' }, { status: 504, headers: { 'Retry-After': '12' } }))
  await assert.rejects(fetchClosedPositions('1', 1), error =>
    error instanceof TradeRequestError && error.message === '服务端连接币安超时。'
      && error.status === 504 && error.retryAfterMs === 12_000)
  fetch.mock.mockImplementation(() => new Response('<html>Bad gateway</html>', { status: 502 }))
  await assert.rejects(fetchObservedTrades({ portfolioId: '1', startTime: 0, endTime: 1 }), {
    status: 502, message: '查询接口返回 HTTP 502，请稍后重试。',
  })
})

test('公开平仓盈亏按结算币分别汇总，保留零，排除缺失值、开仓和未成交订单', async t => {
  const close = { positionSide: 'LONG', side: 'SELL', executedQty: '0.001', quoteAsset: 'USDT', totalPnl: '1.50' }
  const rows = [
    close,
    { ...close, positionSide: 'SHORT', side: 'BUY', totalPnl: '-2.25' },
    { ...close, totalPnl: '0' },
    { ...close, totalPnl: ' ' },
    { ...close, totalPnl: null },
    { ...close, side: 'BUY', totalPnl: '50' },
    { ...close, positionSide: 'BOTH' },
    { ...close, executedQty: '0' },
    { ...close, quoteAsset: 'USDC' },
  ]
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, '/api/monitor/trades?portfolioId=1&startTime=0&endTime=1&pageSize=10&cursor=next')
    assert.equal(init.body, undefined)
    return Response.json({ list: rows.map((row, i) => ({ ...row, observedId: String(i) })), total: rows.length })
  })
  const page = await fetchObservedTrades({ portfolioId: '1', startTime: 0, endTime: 1 }, 'next')
  assert.equal(page.cursor, undefined)
  assert.deepEqual(page.list.map(reportedPnl), [1.5, -2.25, 0, null, null, null, null, null, 1.5])
  assert.deepEqual(summarizeReportedPnl(page.list), [
    { asset: 'USDC', pnl: 1.5, count: 1 },
    { asset: 'USDT', pnl: -0.75, count: 3 },
  ])
  assert.deepEqual(summarizeReportedPnl([]), [])
})

test('线性合约的多空方向相反，按数量和价差计算毛盈亏', () => {
  assert.equal(linearPnl('LONG', 100, 110, 3), 30)
  assert.equal(linearPnl('SHORT', 100, 110, 3), -30)
  assert.equal(linearPnl('SHORT', 100, 90, 3), 30)
  assert.equal(linearPnl('LONG', 100, 100, 3), 0)
  assert.equal(linearPnl('LONG', 100, 0, 3), null)
  assert.equal(linearPnl('LONG', 100, 90, -3), null)
  assert.equal(linearPnl('LONG', NaN, 90, 3), null)
})

test('按保证金和杠杆试算线性合约盈亏及回报率', () => {
  assert.deepEqual(linearPnlFromMargin('LONG', 100, 110, 100, 5), { pnl: 50, roi: 0.5 })
  assert.deepEqual(linearPnlFromMargin('LONG', 100, 110, 200, 5), { pnl: 100, roi: 0.5 })
  assert.deepEqual(linearPnlFromMargin('SHORT', 100, 110, 100, 5), { pnl: -50, roi: -0.5 })
  assert.deepEqual(linearPnlFromMargin('SHORT', 100, 90, 100, 5), { pnl: 50, roi: 0.5 })
  assert.deepEqual(linearPnlFromMargin('LONG', 100, 1000, 20, 50), { pnl: 9000, roi: 450 })
  assert.deepEqual(linearPnlFromMargin('LONG', 100, 100, 100, 5), { pnl: 0, roi: 0 })
  assert.equal(linearPnlFromMargin('LONG', 100, 110, 0, 5), null)
  assert.equal(linearPnlFromMargin('LONG', 100, 0, 100, 5), null)
  assert.equal(linearPnlFromMargin('LONG', 0, 110, 100, 5), null)
  assert.equal(linearPnlFromMargin('LONG', 100, 110, 100, 1.5), null)
  assert.equal(linearPnlFromMargin('LONG', 100, 110, Number.MAX_VALUE, 5), null)
})

test('完整仓位按本地记录分页，保留结算币种与未披露盈亏', async t => {
  const position = { symbol: 'ETHUSDT', positionId: '1173503880041443328', asset: 'USDT',
    side: 'Long', closed: 1795445614673, roi: 0.03 }
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(url, '/api/monitor/positions?portfolioId=123&pageNumber=2&pageSize=10')
    assert.equal(init.body, undefined)
    return Response.json({ total: 12, pageSize: 10, rows: [
      { ...position, closingPnl: -14523.75111698 },
      { ...position, positionId: '2', closingPnl: null },
    ] })
  })
  const result = await fetchClosedPositions('123', 2)
  assert.equal(result.total, 12)
  assert.deepEqual(result.rows.map(row => [row.positionId, row.closingPnl, row.asset]),
    [['1173503880041443328', -14523.75111698, 'USDT'], ['2', null, 'USDT']])
})

test('组合状态只读，保存操作单独提交后台组合配置', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', (url, init) => {
    if (url.startsWith('/api/monitor/status')) return Response.json({ portfolios: [] })
    assert.equal(init.method, 'PUT')
    assert.deepEqual(JSON.parse(init.body), { portfolioIds: ['123'] })
    assert.equal(init.headers.get('Authorization'), 'Bearer session-fixture')
    return new Response(null, { status: 204 })
  })
  await fetchObservationStatus(['123'], new AbortController().signal)
  await saveMonitoredPortfolios(['123'], 'session-fixture')
  const calls = fetchMock.mock.calls.map(({ arguments: [url, init] }) => [url, init.method, init.body])
  assert.deepEqual(calls, [
    ['/api/monitor/status?portfolioId=123', undefined, undefined],
    ['/api/monitor/watchlist', 'PUT', '{"portfolioIds":["123"]}'],
  ])
})

test('不同用户的公开关注列表独立，保留原始默认值和主动清空的列表', t => {
  const records = new Map()
  const oldDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => records.get(key) ?? null,
      setItem: (key, value) => records.set(key, value),
    },
  })
  t.after(() => {
    if (oldDescriptor) Object.defineProperty(globalThis, 'localStorage', oldDescriptor)
    else delete globalThis.localStorage
  })
  const defaults = loadWatchlist('guest')
  assert.deepEqual(defaults.map(item => item.id), ['5075281354358777856', '4751838302089254401'])
  const portfolio = { id: '12345678901234567890', name: '示例组合' }
  assert.equal(saveWatchlist('user:a', [portfolio, portfolio]), true)
  assert.deepEqual(loadWatchlist('user:a'), [portfolio])
  assert.deepEqual(loadWatchlist('user:b'), defaults)
  assert.equal(saveWatchlist('user:b', []), true)
  assert.deepEqual(loadWatchlist('user:b'), [])
  assert.deepEqual(loadWatchlist('guest'), defaults)
  const previousId = 'bound-' + 'a'.repeat(64)
  const live = 'live:owner:uid:42'
  const demo = 'testnet:owner:uid:demo:42'
  const spotTestnet = 'testnet:owner:uid:spot-testnet:42'
  assert.equal(saveWatchlist('live:user:' + previousId, [portfolio]), true)
  assert.deepEqual(loadWatchlist(live), defaults)
  assert.deepEqual(loadWatchlist(live, previousId), [portfolio])
  assert.deepEqual(loadWatchlist(live), [portfolio])
  assert.deepEqual(loadWatchlist(demo, previousId), defaults)
  assert.equal(saveWatchlist(demo, []), true)
  assert.deepEqual(loadWatchlist(spotTestnet), defaults)
  assert.deepEqual(loadWatchlist(demo), [])
})
