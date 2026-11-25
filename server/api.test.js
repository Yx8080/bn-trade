import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApiMiddleware } from './api.js'

test('a self-bound HTTP client receives its trading pair’s signed leverage brackets', async t => {
  const localFetch = globalThis.fetch.bind(globalThis)
  const payload = { environment: 'testnet', apiKey: 'http-fixture-key', apiSecret: 'http-fixture-secret' }
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(init.method, 'GET')
    assert.equal(init.headers.get('X-MBX-APIKEY'), payload.apiKey)
    assert.ok(url.searchParams.has('signature'))
    if (url.pathname === '/fapi/v3/account') return Response.json({ assets: [] })
    if (url.pathname === '/api/v3/account') return url.hostname === 'demo-api.binance.com'
      ? Response.json({ balances: [], uid: 741 }) : Response.json({ code: -2015 }, { status: 401 })
    const symbol = url.searchParams.get('symbol')
    assert.equal(symbol, 'BTCUSDT')
    if (url.pathname === '/fapi/v1/leverageBracket') return Response.json({ symbol, brackets: [
      { notionalFloor: 0, notionalCap: 1000, initialLeverage: 150 }, { notionalFloor: 1000, notionalCap: 5000, initialLeverage: 50 }] })
    if (url.pathname === '/fapi/v1/symbolConfig') return Response.json([{ symbol, leverage: 10 }])
    assert.equal(url.pathname, '/fapi/v3/positionRisk')
    return Response.json([{ symbol, notional: '-1200' }])
  })
  const api = createApiMiddleware({ env: { NO_PROXY: '*' }, databaseFile: ':memory:' })
  const server = createServer((req, res) => api(req, res, () => res.writeHead(404).end()))
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + server.address().port + '/api/'
    const response = await localFetch(base + 'accounts/bind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    assert.equal(response.status, 200)
    const { token, markets } = await response.json()
    assert.deepEqual(markets, ['futures'])
    const headers = { Authorization: 'Bearer ' + token }
    const path = base + 'futures/leverage?symbol=BTCUSDT'
    const info = await (await localFetch(path, { headers })).json()
    assert.deepEqual([info.symbol, info.symbolMaxLeverage, info.maxLeverage, info.leverage], ['BTCUSDT', 150, 50, 10])
    assert.equal((await localFetch(base + 'accounts/session', { method: 'DELETE', headers })).status, 204)
    assert.equal((await localFetch(path, { headers })).status, 401)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await api.close()
  }
})

test('the Node API preserves a submitted order ID across restarts and rotation of a configured key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bn-trade-node-'))
  const databaseFile = join(directory, 'orders.sqlite')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const localFetch = globalThis.fetch.bind(globalThis)
  const boundKeys = []
  let orderCount = 0
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (url.pathname === '/api/v3/account') {
      assert.equal(url.hostname, 'testnet.binance.vision')
      assert.ok(url.searchParams.has('signature'))
      boundKeys.push(options.headers.get('X-MBX-APIKEY'))
      return Response.json({ balances: [], uid: 97531 })
    }
    assert.equal(url.href, 'https://testnet.binance.vision/api/v3/order')
    assert.equal(options.method, 'POST')
    orderCount++
    return Response.json({
      symbol: 'BTCUSDT', clientOrderId: 'restart-test', orderId: 1, status: 'FILLED', side: 'BUY', type: 'MARKET',
      executedQty: '0.001', cummulativeQuoteQty: '50',
    })
  })
  // Open a fresh HTTP listener and SQLite connection for each attempt.
  for (const expected of [201, 409]) {
    const env = { BINANCE_FUTURES_USERS: JSON.stringify([{
      id: 'local', name: 'Local', token: 'local-test-token', spotApiKey: 'test-key-' + expected, spotApiSecret: 'test-secret-' + expected,
    }]) }
    const api = createApiMiddleware({ env, databaseFile })
    const server = createServer((req, res) => api(req, res, () => res.writeHead(404).end()))
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const response = await localFetch('http://127.0.0.1:' + server.address().port + '/api/spot/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-test-token' },
        body: JSON.stringify({ symbol: 'BTCUSDT', clientOrderId: 'restart-test', environment: 'testnet', quoteOrderQty: '50' }),
      })
      assert.equal(response.status, expected)
      await response.arrayBuffer()
    } finally {
      await new Promise(resolve => server.close(resolve))
      await api.close()
    }
  }
  assert.deepEqual(boundKeys, ['test-key-201', 'test-key-409'])
  assert.equal(orderCount, 1)
})
