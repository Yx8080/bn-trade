import { handleFutures } from './futures.js'
import { handleSpot } from './spot.js'

const binancePortfolioUrl = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/'

function isPortfolioId(value) {
  return typeof value === 'string' && /^\d+$/.test(value)
}

async function fetchPortfolio(env, url, body) {
  const headers = new Headers({ Accept: 'application/json', clienttype: 'web' })
  if (body != null) headers.set('Content-Type', 'application/json')

  const responseHeaders = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  })
  try {
    const fetchBinance = env.fetchBinance ?? fetch
    const upstream = await fetchBinance(url, {
      method: body == null ? 'GET' : 'POST',
      body,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
    })
    const retryAfter = upstream.headers.get('Retry-After')
    if (retryAfter) responseHeaders.set('Retry-After', retryAfter)
    if (upstream.status !== 200) {
      console.warn('Binance returned HTTP', upstream.status, url.pathname)
      await upstream.body?.cancel().catch(() => {})
      const status = upstream.status >= 400 ? upstream.status : 502
      let message = `币安查询接口返回 HTTP ${upstream.status}，请稍后重试。`
      if (upstream.status === 429 || upstream.status === 418) message = `币安已限制查询频率（HTTP ${upstream.status}），请稍后重试。`
      if ([401, 403, 451].includes(upstream.status)) message = `币安拒绝了此服务器的访问（HTTP ${upstream.status}），请检查服务所在网络的访问条件。`
      return Response.json({ code: 'UPSTREAM_HTTP_ERROR', message }, { status, headers: responseHeaders })
    }
    const text = await upstream.text()
    try {
      JSON.parse(text)
    } catch {
      return Response.json({ code: 'INVALID_UPSTREAM_DATA', message: '币安未返回有效的 JSON 数据，请检查服务端网络后重试。' },
        { status: 502, headers: responseHeaders })
    }
    // Forward the original bytes as text so large numeric identifiers retain their exact digits.
    return new Response(text, { headers: responseHeaders })
  } catch (error) {
    const causeCode = error?.cause?.code
    console.warn('Binance request failed', error?.name, causeCode, url.pathname)
    const timedOut = error?.name === 'TimeoutError' || causeCode === 'UND_ERR_CONNECT_TIMEOUT'
    const code = timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE'
    const message = timedOut ? '服务器连接币安超时，请检查服务器网络和代理后重试。' : '服务器无法连接币安，请检查服务器网络和代理设置。'
    return Response.json({ code, message }, { status: timedOut ? 504 : 502, headers: responseHeaders })
  }
}

export default {
  async fetch(request, env = {}) {
    const { pathname, searchParams } = new URL(request.url)
    if (pathname.startsWith('/api/futures/')) return handleFutures(request, env)
    if (pathname.startsWith('/api/spot/')) return handleSpot(request, env)
    if (pathname === '/api/binance/portfolio-detail') {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
      const portfolioId = searchParams.get('portfolioId')
      if (!isPortfolioId(portfolioId)) return new Response(null, { status: 400 })
      const url = new URL('detail', binancePortfolioUrl)
      url.searchParams.set('portfolioId', portfolioId)
      return fetchPortfolio(env, url)
    }

    if (pathname === '/api/binance/position-history') {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
      const { portfolioId, pageNumber, pageSize } = await request.json().catch(() => null) ?? {}
      if (!isPortfolioId(portfolioId) || !Number.isSafeInteger(pageNumber) || pageNumber < 1
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) return new Response(null, { status: 400 })
      return fetchPortfolio(env, new URL('position-history', binancePortfolioUrl), JSON.stringify({ portfolioId, pageNumber, pageSize }))
    }

    if (pathname === '/api/binance/latest-records') {
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
      const query = await request.json().catch(() => null)
      const { portfolioId, startTime, endTime, pageSize, indexValue } = query ?? {}
      if (!isPortfolioId(portfolioId) || !Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime)
        || startTime > endTime || !Number.isSafeInteger(pageSize) || pageSize < 1
        || (indexValue != null && typeof indexValue !== 'string')) {
        return new Response(null, { status: 400 })
      }
      const body = JSON.stringify({ portfolioId, startTime, endTime, pageSize, indexValue })
      return fetchPortfolio(env, new URL('order-history', binancePortfolioUrl), body)
    }

    return new Response(null, { status: 404 })
  },
}
