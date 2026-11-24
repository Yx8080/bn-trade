import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchBinanceTradePage, fetchClosedPositions, TradeRequestError } from '../src/trades.ts'
import { linearPnl, reportedPnl, summarizeReportedPnl } from '../src/pnl.ts'
import { loadWatchlist, saveWatchlist } from '../src/portfolios.ts'

test('公开查询保留服务端错误说明和限流时间，纯文本错误回退到 HTTP 状态', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () =>
    Response.json({ message: '服务端连接币安超时。' }, { status: 504, headers: { 'Retry-After': '12' } }))
  await assert.rejects(fetchClosedPositions('1', 1), error =>
    error instanceof TradeRequestError && error.message === '服务端连接币安超时。'
      && error.status === 504 && error.retryAfterMs === 12_000)
  fetch.mock.mockImplementation(() => new Response('<html>Bad gateway</html>', { status: 502 }))
  await assert.rejects(fetchBinanceTradePage({ portfolioId: '1', startTime: 0, endTime: 1 }), {
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
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    success: true, code: '000000', data: { list: rows, total: rows.length, indexValue: '-1' },
  }))
  const page = await fetchBinanceTradePage({ portfolioId: '1', startTime: 0, endTime: 1 })
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

test('完整仓位采用 closingPnl 并按上游页码分页，缺失值保留为空', async t => {
  const position = { symbol: 'ETHUSDT', positionId: '1173503880041443328', type: 'UM',
    status: 'All Closed', side: 'Long', closed: 1795445614673, roi: '0.03' }
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(url, '/api/binance/position-history')
    assert.deepEqual(JSON.parse(init.body), { portfolioId: '123', pageNumber: 2, pageSize: 10 })
    return Response.json({ code: '000000', data: { total: 12, list: [
      { ...position, closingPnl: '-14523.75111698' },
      { ...position, positionId: '2', closingPnl: null },
      { ...position, positionId: '3', status: 'Open', closingPnl: 100 },
    ] } })
  })
  const result = await fetchClosedPositions('123', 2)
  assert.equal(result.total, 12)
  assert.deepEqual(result.rows.map(row => [row.positionId, row.closingPnl, row.asset]),
    [['1173503880041443328', -14523.75111698, 'USDT'], ['2', null, 'USDT']])
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
})
