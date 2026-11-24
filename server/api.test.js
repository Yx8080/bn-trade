import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApiMiddleware } from './api.js'

test('the Node API preserves a submitted order ID across restarts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bn-trade-node-'))
  const databaseFile = join(directory, 'orders.sqlite')
  const env = {
    BINANCE_FUTURES_USERS: JSON.stringify([{
      id: 'local', name: 'Local', token: 'local-test-token', spotApiKey: 'test-key', spotApiSecret: 'test-secret',
    }]),
  }
  t.after(() => rm(directory, { recursive: true, force: true }))
  const localFetch = globalThis.fetch.bind(globalThis)
  const exchange = t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url.href, 'https://testnet.binance.vision/api/v3/order')
    assert.equal(options.method, 'POST')
    return Response.json({
      symbol: 'BTCUSDT', clientOrderId: 'restart-test', orderId: 1, status: 'FILLED', side: 'BUY', type: 'MARKET',
      executedQty: '0.001', cummulativeQuoteQty: '50',
    })
  })
  // Open a fresh HTTP listener and SQLite connection for each attempt.
  for (const expected of [201, 409]) {
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
  assert.equal(exchange.mock.callCount(), 1)
})
