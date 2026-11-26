import { ApiError, apiErrorResponse, getTradingUser, jsonResponse } from '../worker/trading.js'
import { createPortfolioMonitor } from './portfolio-monitor.js'
import { validMonitorIds } from './monitor-watchlists.js'

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

export function createMonitorApi(env) {
  const sampler = createPortfolioMonitor({ fetchBinance: env.fetchBinance, getStore: () => env.orderStore.observedTrades,
    getPortfolioIds: () => env.orderStore.monitorWatchlists.ids() })

  async function handle(request) {
    try {
      const { pathname, searchParams: params } = new URL(request.url)
      if (pathname === '/api/monitor/status') {
        if (request.method !== 'GET') return methodRequired('GET')
        const ids = params.getAll('portfolioId')
        if (!validMonitorIds(ids, 100)) throw new ApiError(400, 'INVALID_MONITOR_QUERY', '监控组合 ID 无效。')
        return jsonResponse({ portfolios: sampler.status(ids) })
      }
      if (pathname === '/api/monitor/watchlist') {
        if (request.method !== 'GET' && request.method !== 'PUT') return methodRequired('GET, PUT')
        const owner = request.headers.has('authorization') ? (await getTradingUser(request, env)).id : undefined
        const watchlists = env.orderStore.monitorWatchlists
        if (request.method === 'GET') return jsonResponse({ portfolioIds: watchlists.get(owner) })
        if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
          throw new ApiError(415, 'INVALID_MONITOR_REQUEST', '请使用 JSON 提交监控组合。')
        }
        const input = await request.json().catch(() => null)
        if (!validMonitorIds(input?.portfolioIds)) throw new ApiError(400, 'INVALID_MONITOR_REQUEST', '监控组合列表无效。')
        watchlists.save(owner, input.portfolioIds)
        sampler.refresh()
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
      }
      if (pathname === '/api/monitor/trades' || pathname === '/api/monitor/positions') {
        if (request.method !== 'GET') return methodRequired('GET')
        const portfolioId = params.get('portfolioId')
        const pageSize = integer(params, 'pageSize', 10)
        if (pathname.endsWith('/positions')) {
          return jsonResponse(env.orderStore.observedPositions.page(portfolioId, integer(params, 'pageNumber', 1), pageSize))
        }
        return jsonResponse(env.orderStore.observedTrades.page({ portfolioId, startTime: integer(params, 'startTime'),
          endTime: integer(params, 'endTime'), pageSize, cursor: params.get('cursor') ?? undefined }))
      }
      if (request.method !== 'POST') return methodRequired('POST')
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
        throw new ApiError(415, 'INVALID_MONITOR_REQUEST', '请使用 JSON 提交监控请求。')
      }
      const input = await request.json().catch(() => null)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'INVALID_MONITOR_REQUEST', '监控参数无效。')
      // Older open tabs may still call the previous public history routes.
      // Serve the same local archive there. Private copy execution uses its
      // own transport directly and cannot be started by browsing a table.
      if (pathname === '/api/binance/latest-records') {
        const page = env.orderStore.observedTrades.page({ portfolioId: input.portfolioId, startTime: input.startTime,
          endTime: input.endTime, pageSize: input.pageSize, cursor: input.indexValue })
        return jsonResponse({ success: true, code: '000000', data: { list: page.list, total: page.total, indexValue: page.cursor ?? '-1' } })
      }
      const page = env.orderStore.observedPositions.page(input.portfolioId, input.pageNumber, input.pageSize)
      const list = page.rows.map(row => ({ ...row, status: 'All Closed', marginAsset: row.asset }))
      return jsonResponse({ success: true, code: '000000', data: { list, total: page.total } })
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
  return { handle, close: () => sampler.close() }
}
