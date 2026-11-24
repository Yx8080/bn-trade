import assert from 'node:assert/strict'
import test from 'node:test'
import { marketStreamUrl, subscribeMarketQuote } from '../src/market-stream.ts'

const timestamp = 1_800_000_000_000
function setup(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: timestamp })
  const sockets = []
  class FakeSocket {
    constructor(url) { this.url = url; sockets.push(this) }
    close() { this.closed = true; this.onclose?.() }
    emit(data) { this.onmessage?.({ data: JSON.stringify(data) }) }
  }
  const original = globalThis.WebSocket
  globalThis.WebSocket = FakeSocket
  t.after(() => { globalThis.WebSocket = original })
  return sockets
}

test('market streams route each environment and combine futures feeds on one socket', () => {
  assert.equal(marketStreamUrl('futures', 'live', 'BTCUSDT'),
    'wss://fstream.binance.com/market/stream?streams=btcusdt@miniTicker/btcusdt@markPrice@1s')
  assert.match(marketStreamUrl('futures', 'testnet', 'BTCUSDT'), /\/\/fstream\.binancefuture\.com\/market\//)
  assert.match(marketStreamUrl('spot', 'live', 'ETHUSDT'), /\/\/stream\.binance\.com:443\/ws\/ethusdt@miniTicker$/)
  assert.match(marketStreamUrl('spot', 'testnet', 'ETHUSDT'), /\/\/stream\.testnet\.binance\.vision\/ws\/ethusdt@miniTicker$/)
})

test('an older HTTP snapshot cannot replace newer stream prices, and updates coalesce', async t => {
  const sockets = setup(t)
  let finishBootstrap
  const updates = []
  const errors = []
  const stop = subscribeMarketQuote('futures', 'live', 'BTCUSDT',
    () => new Promise(resolve => { finishBootstrap = resolve }), q => updates.push(q), e => errors.push(e), () => {})
  const [socket] = sockets
  socket.emit({ data: { e: '24hrMiniTicker', s: 'BTCUSDT', c: '101', E: timestamp } })
  socket.emit({ data: { e: 'markPriceUpdate', s: 'BTCUSDT', p: '102.5', E: timestamp - 100 } })
  socket.emit({ data: { e: '24hrMiniTicker', s: 'ETHUSDT', c: '999', E: timestamp } })
  finishBootstrap({ symbol: 'BTCUSDT', environment: 'live', lastPrice: '98', lastTime: timestamp - 1,
    markPrice: '99', time: timestamp - 1000 })
  await Promise.resolve()
  t.mock.timers.tick(200)
  assert.deepEqual(updates, [{ price: '101', priceTime: timestamp, mark: '102.5', markTime: timestamp - 100 }])
  assert.deepEqual(errors, [])
  stop()
  assert.equal(socket.closed, true)
  t.mock.timers.tick(120000)
  assert.equal(sockets.length, 1)
})

test('fresh events suppress HTTP polling, a stale stream uses fallback, and cleanup aborts it', async t => {
  const sockets = setup(t)
  const requests = []
  const stop = subscribeMarketQuote('spot', 'testnet', 'BTCUSDT', signal => {
    requests.push(signal)
    return requests.length > 1 ? new Promise(() => {}) :
      Promise.resolve({ symbol: 'BTCUSDT', environment: 'testnet', lastPrice: '10', time: Date.now() })
  }, () => {}, () => {}, () => {})
  await Promise.resolve()
  t.mock.timers.tick(14_000)
  sockets[0].emit({ e: '24hrMiniTicker', s: 'BTCUSDT', E: Date.now(), c: '11' })
  t.mock.timers.tick(1_000)
  assert.equal(requests.length, 1)
  t.mock.timers.tick(15_000)
  assert.equal(requests.length, 2)
  sockets[0].close()
  t.mock.timers.tick(1_000)
  assert.equal(sockets.length, 2)
  stop()
  assert.equal(requests[1].aborted, true)
  assert.equal(sockets[1].closed, true)
})

test('an access or rate error pauses streaming and HTTP until the user refreshes', async t => {
  const sockets = setup(t)
  const error = Object.assign(new Error('rate limited'), { status: 429 })
  const errors = []
  let requests = 0
  const stop = subscribeMarketQuote('spot', 'live', 'BTCUSDT', async () => { requests++; throw error },
    () => {}, e => errors.push(e), () => {})
  await Promise.resolve()
  assert.equal(sockets[0].closed, true)
  assert.match(errors[0], /已暂停/)
  t.mock.timers.tick(120000)
  assert.equal(sockets.length, 1)
  assert.equal(requests, 1)
  stop()
})
