import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import worker from '../worker/index.js'
import { createLocalOrderDb } from '../worker/local-orders.js'
import { createBinanceTransport } from './binance-transport.js'
import { createCopyService } from './copy-service.js'

const maxBodyBytes = 8192

function fail(response, status, code, message) {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ code, message }))
}

export function createApiMiddleware({ env, databaseFile }) {
  let database
  const transport = createBinanceTransport(env)
  const context = {
    fetchBinance: transport.fetch,
    openMarkStream: transport.websocket,
    BINANCE_FUTURES_ENV: env.BINANCE_FUTURES_ENV,
    BINANCE_FUTURES_USERS: env.BINANCE_FUTURES_USERS,
    get orderStore() {
      if (!database) {
        mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 })
        database = createLocalOrderDb(databaseFile)
      }
      return database
    },
  }
  const copyService = createCopyService(context)

  async function middleware(incoming, outgoing, next) {
    if (!incoming.url?.startsWith('/api/')) return next()
    try {
      const url = new URL(incoming.url, 'http://localhost')
      if (!url.pathname.startsWith('/api/')) return fail(outgoing, 404, 'NOT_FOUND', '接口不存在。')
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
      for (const name of ['authorization', 'content-type']) {
        const value = incoming.headers[name]
        if (typeof value === 'string') headers.set(name, value)
      }
      const request = new Request(url, {
        method: incoming.method, headers, body: bytes ? Buffer.concat(chunks, bytes) : undefined,
      })
      const response = ['/api/futures/copy', '/api/futures/copy-pnl'].includes(url.pathname)
        ? await copyService.fetch(request) : await worker.fetch(request, context)
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
    await copyService.close()
    database?.close()
    database = undefined
    return transport.close()
  }
  return middleware
}
