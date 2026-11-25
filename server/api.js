import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import worker from '../worker/index.js'
import { createLocalOrderDb } from '../worker/local-orders.js'
import { getTradingEnvironment } from '../worker/trading.js'
import { createBinanceTransport } from './binance-transport.js'
import { createCopyService } from './copy-service.js'
import { platformPnl } from './platform-pnl.js'
import { createPlatformSettlement } from './platform-settlement.js'
import { accountBinding } from './account-binding.js'
import { createConfiguredVerifier } from './configured-accounts.js'
import { createMonitorApi } from './monitor-api.js'

const maxBodyBytes = 8192

function fail(response, status, code, message) {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ code, message }))
}

export function createApiMiddleware({ env, databaseFile }) {
  const defaultEnvironment = getTradingEnvironment(env)
  let database
  const transport = createBinanceTransport(env)
  function getDatabase() {
    if (!database) {
      mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 })
      database = createLocalOrderDb(databaseFile)
    }
    return database
  }
  const monitor = createMonitorApi(getDatabase, transport.fetch)
  const environments = new Map()
  for (const environment of ['testnet', 'live']) {
    const context = {
      fetchBinance: transport.fetch,
      openMarkStream: transport.websocket,
      BINANCE_FUTURES_ENV: environment,
      BINANCE_FUTURES_USERS: environment === defaultEnvironment ? env.BINANCE_FUTURES_USERS : undefined,
      get orderStore() { return getDatabase() },
    }
    context.verifyConfiguredUser = createConfiguredVerifier(context, environment)
    // Background jobs must retain their environment even when no browser is connected.
    const copy = createCopyService(context)
    const settlement = createPlatformSettlement(context)
    const handlers = new Map([
      ['/api/monitor/observe', monitor.handle], ['/api/monitor/release', monitor.handle],
      ['/api/monitor/trades', monitor.handle], ['/api/monitor/positions', monitor.handle],
      ['/api/binance/latest-records', monitor.handle], ['/api/binance/position-history', monitor.handle],
      ['/api/accounts/bind', accountBinding], ['/api/accounts/session', accountBinding],
      ['/api/futures/copy', copy.fetch], ['/api/futures/copy-pnl', copy.fetch],
      ['/api/futures/other-trades', copy.fetch],
      ['/api/platform/pnl', platformPnl], ['/api/platform/valuation', platformPnl],
    ])
    environments.set(environment, { context, handlers, copy, settlement })
  }

  async function middleware(incoming, outgoing, next) {
    if (!incoming.url?.startsWith('/api/')) return next()
    try {
      const url = new URL(incoming.url, 'http://localhost')
      if (!url.pathname.startsWith('/api/')) return fail(outgoing, 404, 'NOT_FOUND', '接口不存在。')
      const selected = incoming.headers['x-trading-environment']
      const services = environments.get(selected ?? defaultEnvironment)
      if (!services) {
        incoming.resume()
        return fail(outgoing, 400, 'INVALID_ENVIRONMENT', '请选择测试网或实盘环境。')
      }
      if (selected && url.searchParams.getAll('environment').some(value => value !== selected)) {
        incoming.resume()
        return fail(outgoing, 409, 'ENVIRONMENT_CHANGED', '请求与当前交易环境不一致，请重新确认。')
      }
      if (Number(incoming.headers['content-length']) > maxBodyBytes) {
        incoming.resume()
        return fail(outgoing, 413, 'REQUEST_TOO_LARGE', '请求内容过长。')
      }
      const chunks = []
      let bytes = 0
      for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length
        if (bytes > maxBodyBytes) {
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
      const handle = services.handlers.get(url.pathname) ?? worker.fetch
      const response = await handle(request, services.context)
      const body = Buffer.from(await response.arrayBuffer())
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(body)
    } catch {
      if (!outgoing.destroyed && !outgoing.headersSent) {
        fail(outgoing, 500, 'INTERNAL_ERROR', '本地交易接口暂时不可用。')
      }
    }
  }
  middleware.close = async () => {
    await monitor.close()
    await Promise.all([...environments.values()].flatMap(({ copy, settlement }) => [copy.close(), settlement.close()]))
    database?.close()
    database = undefined
    return transport.close()
  }
  return middleware
}
