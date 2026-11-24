import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { createBinanceTransport } from './binance-transport.js'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return 'http://127.0.0.1:' + server.address().port
}

test('HTTPS requests use the system proxy without shell settings and explicit HTTPS_PROXY takes precedence', async t => {
  const proxy = createServer()
  const tunnels = []
  proxy.on('connect', (request, socket) => {
    tunnels.push(request.url)
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
  })
  const address = await listen(proxy)
  t.after(() => new Promise(resolve => proxy.close(resolve)))
  const origin = 'https://127.0.0.1:44443'
  const systemLookup = t.mock.fn(async target => {
    assert.equal(target, origin)
    return address
  })
  for (const env of [{}, { HTTPS_PROXY: address }]) {
    const transport = createBinanceTransport(env, systemLookup)
    try {
      await Promise.all(['/detail', '/order-history'].map(path =>
        assert.rejects(transport.fetch(new URL(path, origin), { signal: AbortSignal.timeout(2000) }))))
    } finally {
      await transport.close()
    }
  }
  assert.equal(systemLookup.mock.callCount(), 1)
  assert.deepEqual(tunnels, Array(4).fill('127.0.0.1:44443'))
})

test('NO_PROXY sends matching hosts directly even when a proxy is configured', async t => {
  const target = createServer((_req, res) => res.end('direct'))
  const address = await listen(target)
  t.after(() => new Promise(resolve => target.close(resolve)))
  const transport = createBinanceTransport({ http_proxy: 'http://127.0.0.1:1', no_proxy: '127.0.0.1' })
  try {
    const response = await transport.fetch(new URL(address), { signal: AbortSignal.timeout(2000) })
    assert.equal(await response.text(), 'direct')
  } finally {
    await transport.close()
  }
})
