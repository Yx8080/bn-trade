import { ApiError, apiErrorResponse, jsonResponse } from '../worker/trading.js'
import { createPortfolioMonitor } from './portfolio-monitor.js'
import { observeClosedPositions } from './observed-positions.js'

function integer(params, name, fallback) {
  const value = params.get(name)
  if (value === null && fallback !== undefined) return fallback
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ApiError(400, 'INVALID_MONITOR_QUERY', '查询参数无效。')
  }
  return Number(value)
}

function methodRequired(expected) {
  return jsonResponse({ message: '请求方法无效。' }, 405, { Allow: expected })
}

export function createMonitorApi(getDb, fetchBinance) {
  const sampler = createPortfolioMonitor({ fetchBinance, getStore: () => getDb().observedTrades,
    observeClosures: (id, sample) => observeClosedPositions({ fetchBinance }, () => getDb().observedPositions, id, sample) })

  async function handle(request) {
    try {
      const { pathname, searchParams: params } = new URL(request.url)
      if (pathname === '/api/monitor/trades' || pathname === '/api/monitor/positions') {
        if (request.method !== 'GET') return methodRequired('GET')
        const portfolioId = params.get('portfolioId')
        const pageSize = integer(params, 'pageSize', 10)
        if (pathname.endsWith('/positions')) {
          return jsonResponse(getDb().observedPositions.page(portfolioId, integer(params, 'pageNumber', 1), pageSize))
        }
        return jsonResponse(getDb().observedTrades.page({ portfolioId, startTime: integer(params, 'startTime'),
          endTime: integer(params, 'endTime'), pageSize, cursor: params.get('cursor') ?? undefined }))
      }
      if (request.method !== 'POST') return methodRequired('POST')
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
        throw new ApiError(415, 'INVALID_MONITOR_REQUEST', '请使用 JSON 提交监控请求。')
      }
      const input = await request.json().catch(() => null)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'INVALID_MONITOR_REQUEST', '监控参数无效。')
      if (pathname === '/api/monitor/observe') {
        if (Object.keys(input).some(key => !['viewId', 'portfolioIds'].includes(key))) throw new ApiError(400, 'INVALID_MONITOR_REQUEST', '实时监控只接受当前组合。')
        return jsonResponse(await sampler.observe(input.viewId, input.portfolioIds))
      }
      if (pathname === '/api/monitor/release') {
        sampler.release(input.viewId)
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
      }
      // Older open tabs may still call the previous public history routes.
      // Serve the same local archive there. Private copy execution uses its
      // own transport directly and cannot be started by browsing a table.
      if (pathname === '/api/binance/latest-records') {
        const page = getDb().observedTrades.page({ portfolioId: input.portfolioId, startTime: input.startTime,
          endTime: input.endTime, pageSize: input.pageSize, cursor: input.indexValue })
        return jsonResponse({ success: true, code: '000000', data: { list: page.list, total: page.total, indexValue: page.cursor ?? '-1' } })
      }
      const page = getDb().observedPositions.page(input.portfolioId, input.pageNumber, input.pageSize)
      const list = page.rows.map(row => ({ ...row, status: 'All Closed', marginAsset: row.asset }))
      return jsonResponse({ success: true, code: '000000', data: { list, total: page.total } })
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
  return { handle, close: () => sampler.close() }
}
