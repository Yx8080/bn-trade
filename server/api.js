import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import worker from '../worker/index.js'
import { createLocalOrderDb } from '../worker/local-orders.js'
import { ApiError, checkTradingEnvironment } from '../worker/trading.js'
import { createBinanceTransport } from './binance-transport.js'
import { createCopyService } from './copy-service.js'
import { platformPnl } from './platform-pnl.js'
import { positionSources } from './position-sources.js'
import { futuresPositionHistory } from './futures-position-history.js'
import { createPlatformSettlement } from './platform-settlement.js'
import { accountBinding } from './account-binding.js'
import { createConfiguredVerifier } from './configured-accounts.js'
import { createMonitorApi } from './monitor-api.js'

const maxBodyBytes = 8192
const maxWatchlistBytes = 67_000

function fail(response, status, code, message) {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ code, message }))
}

export function createApiMiddleware({ env, databaseFile }) {
  let database
  const transport = createBinanceTransport(env)
  function getDatabase() {
    if (!database) {
      mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 })
      database = createLocalOrderDb(databaseFile)
    }
    return database
  }
  const context = {
    fetchBinance: transport.fetch,
    openMarkStream: transport.websocket,
    // Legacy credentials without an explicit live setting belonged to the former test venue.
    BINANCE_FUTURES_USERS: env.BINANCE_FUTURES_ENV === 'live' ? env.BINANCE_FUTURES_USERS : undefined,
    get orderStore() { return getDatabase() },
  }
  context.verifyConfiguredUser = createConfiguredVerifier(context, 'live')
  const copy = createCopyService(context)
  const monitor = createMonitorApi(context, copy.notifyPortfolio)
  const settlement = createPlatformSettlement(context)
  const handlers = new Map([
    ['/api/monitor/status', monitor.handle], ['/api/monitor/watchlist', monitor.handle],
    ['/api/monitor/trades', monitor.handle], ['/api/monitor/positions', monitor.handle],
    ['/api/binance/latest-records', monitor.handle], ['/api/binance/position-history', monitor.handle],
    ['/api/accounts/bind', accountBinding], ['/api/accounts/session', accountBinding],
    ['/api/futures/copy', copy.fetch], ['/api/futures/copy-pnl', copy.fetch],
    ['/api/futures/other-trades', copy.fetch],
    ['/api/futures/position-sources', positionSources],
    ['/api/futures/position-history', futuresPositionHistory],
    ['/api/platform/pnl', platformPnl], ['/api/platform/valuation', platformPnl],
  ])

  async function middleware(incoming, outgoing, next) {
    if (!incoming.url?.startsWith('/api/')) return next()
    try {
      const url = new URL(incoming.url, 'http://localhost')
      if (!url.pathname.startsWith('/api/')) return fail(outgoing, 404, 'NOT_FOUND', '接口不存在。')
      checkTradingEnvironment(incoming.headers['x-trading-environment'], url.searchParams)
      const limit = url.pathname === '/api/monitor/watchlist' ? maxWatchlistBytes : maxBodyBytes
      if (Number(incoming.headers['content-length']) > limit) {
        incoming.resume()
        return fail(outgoing, 413, 'REQUEST_TOO_LARGE', '请求内容过长。')
      }
      const chunks = []
      let bytes = 0
      for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length
        if (bytes > limit) {
          incoming.resume()
          return fail(outgoing, 413, 'REQUEST_TOO_LARGE', '请求内容过长。')
        }
        chunks.push(chunk)
      }
      if (bytes && (incoming.method === 'GET' || incoming.method === 'HEAD')) {
        return fail(outgoing, 400, 'INVALID_BODY', '此请求不接受正文。')
      }
      const headers = new Headers()
      for (const name of ['authorization', 'content-type', 'origin', 'sec-fetch-site']) {
        const value = incoming.headers[name]
        if (typeof value === 'string') headers.set(name, value)
      }
      const request = new Request(url, {
        method: incoming.method, headers, body: bytes ? Buffer.concat(chunks, bytes) : undefined,
      })
      const handle = handlers.get(url.pathname) ?? worker.fetch
      const response = await handle(request, context)
      const body = Buffer.from(await response.arrayBuffer())
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(body)
    } catch (error) {
      if (!outgoing.destroyed && !outgoing.headersSent) {
        incoming.resume()
        if (error instanceof ApiError) fail(outgoing, error.status, error.code, error.message)
        else fail(outgoing, 500, 'INTERNAL_ERROR', '本地交易接口暂时不可用。')
      }
    }
  }
  middleware.close = async () => {
    await Promise.all([monitor.close(), copy.close(), settlement.close()])
    database?.close()
    database = undefined
    return transport.close()
  }
  return middleware
}
