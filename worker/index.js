const binancePortfolioUrl = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/'

function isPortfolioId(value) {
  return typeof value === 'string' && /^\d+$/.test(value)
}

async function fetchBinance(url, body) {
  const headers = new Headers({ Accept: 'application/json', clienttype: 'web' })
  if (body != null) headers.set('Content-Type', 'application/json')

  const responseHeaders = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  })
  try {
    const upstream = await fetch(url, {
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
      return new Response(null, { status: upstream.status >= 400 ? upstream.status : 502, headers: responseHeaders })
    }
    return new Response(await upstream.text(), { headers: responseHeaders })
  } catch (error) {
    console.warn('Binance request failed', error?.name, url.pathname)
    return new Response(null, { status: error?.name === 'TimeoutError' ? 504 : 502, headers: responseHeaders })
  }
}

export default {
  async fetch(request) {
    const { pathname, searchParams } = new URL(request.url)
    if (pathname === '/api/binance/portfolio-detail') {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
      const portfolioId = searchParams.get('portfolioId')
      if (!isPortfolioId(portfolioId)) return new Response(null, { status: 400 })
      const url = new URL('detail', binancePortfolioUrl)
      url.searchParams.set('portfolioId', portfolioId)
      return fetchBinance(url)
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
      return fetchBinance(new URL('order-history', binancePortfolioUrl), body)
    }

    const file = pathname === '/' ? '/index.html' : pathname
    // The Sites build inlines the Vite assets into the Worker module.
    if ((request.method === 'GET' || request.method === 'HEAD') && Object.hasOwn(siteAssets, file)) {
      const { contentType, body } = siteAssets[file]
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': file === '/index.html' ? 'no-cache' : 'private, max-age=31536000, immutable',
        },
      })
    }
    return new Response(null, { status: 404 })
  },
}
