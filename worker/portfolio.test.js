import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.js'

const portfolioId = '5075281354358777856'
const api = 'https://local.test/api/'

test('portfolio details and both history queries use the configured transport and retain identifier precision', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected direct connection'))
  const raw = '{"code":"000000","data":{"id":9223372036854775807}}'
  for (const [route, path, body] of [
    ['portfolio-detail?portfolioId=' + portfolioId, 'detail', null],
    ['position-history', 'position-history', { portfolioId, pageNumber: 1, pageSize: 10 }],
    ['latest-records', 'order-history', { portfolioId, startTime: 1, endTime: 2, pageSize: 10, indexValue: 'page2' }],
  ]) {
    const init = body ? { method: 'POST', body: JSON.stringify(body) } : {}
    const fetchBinance = t.mock.fn((url, options) => {
      assert.equal(url.origin, 'https://www.binance.com')
      assert.equal(url.pathname.split('/').at(-1), path)
      assert.equal(options.method, body ? 'POST' : 'GET')
      if (body) assert.deepEqual(JSON.parse(options.body), body)
      else assert.equal(url.searchParams.get('portfolioId'), portfolioId)
      return new Response(raw)
    })
    const result = await worker.fetch(new Request(api + 'binance/' + route, init), { fetchBinance })
    assert.equal(result.status, 200)
    assert.equal(await result.text(), raw)
    assert.equal(fetchBinance.mock.callCount(), 1)
  }
})

test('the public futures and spot quotes use the configured transport', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected direct connection'))
  const fetchBinance = t.mock.fn(url => Response.json(url.pathname.endsWith('premiumIndex')
    ? { symbol: 'BTCUSDT', markPrice: '120', time: 1 }
    : { symbol: 'BTCUSDT', price: '123', time: 1 }))
  for (const market of ['futures', 'spot']) {
    const response = await worker.fetch(new Request(api + market + '/quote?symbol=BTCUSDT'), { fetchBinance })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).lastPrice, '123')
  }
  assert.equal(fetchBinance.mock.callCount(), 3)
})

test('portfolio gateway failures identify the failing layer, retain retry delays and do not retry upstream', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected direct connection'))
  const cases = [
    [() => new Response('busy', { status: 429, headers: { 'Retry-After': '30' } }), 429, 'UPSTREAM_HTTP_ERROR', /频率/],
    [() => new Response(null, { status: 502 }), 502, 'UPSTREAM_HTTP_ERROR', /HTTP 502/],
    [() => new Response('<html>Gateway</html>'), 502, 'INVALID_UPSTREAM_DATA', /JSON/],
    [() => { throw new TypeError('fetch failed') }, 502, 'UPSTREAM_UNAVAILABLE', /代理/],
    [() => { throw new DOMException('timed out', 'TimeoutError') }, 504, 'UPSTREAM_TIMEOUT', /超时/],
  ]
  for (const [upstream, status, code, description] of cases) {
    const fetchBinance = t.mock.fn(upstream)
    const response = await worker.fetch(new Request(api + 'binance/portfolio-detail?portfolioId=' + portfolioId), { fetchBinance })
    assert.equal(response.status, status)
    assert.equal(response.headers.get('Retry-After'), status === 429 ? '30' : null)
    const failure = await response.json()
    assert.equal(failure.code, code)
    assert.match(failure.message, description)
    assert.equal(fetchBinance.mock.callCount(), 1)
  }
})
