import assert from 'node:assert/strict'
import test from 'node:test'
import { createMarkWatch } from './mark-watch.js'

const now = 1_800_000_000_000
const position = { userId: 'alice', symbol: 'BTCUSDT', direction: 'LONG', quantity: 2, entryPrice: 100, stopLoss: 10 }
function fakeSocket() {
  const messages = []
  return { readyState: 1, messages, closed: false, close() { this.closed = true },
    send(text) { messages.push(JSON.parse(text)) },
    tick(p, E = Date.now(), s = 'BTCUSDT') {
      this.onmessage?.({ data: JSON.stringify({ data: { e: 'markPriceUpdate', s, E, p } }) })
    } }
}

test('one mark socket tracks only held symbols and coalesces durable risk threshold crossings', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now })
  const calls = []
  const socket = fakeSocket()
  const connect = t.mock.fn(async url => { assert.equal(url, 'wss://fstream.binance.com/market/stream'); return socket })
  const watch = createMarkWatch('live', connect, id => calls.push(id))
  const other = { ...position, userId: 'bob', direction: 'SHORT' }
  watch.update([position, other])
  await Promise.resolve()
  assert.deepEqual(socket.messages.map(m => [m.method, m.params]), [['SUBSCRIBE', ['btcusdt@markPrice@1s']]])
  socket.tick('90', now - 5001)
  socket.tick('90', now + 5000)
  socket.tick('90', now, 'ETHUSDT')
  await Promise.resolve()
  assert.deepEqual(calls, [])
  socket.tick('95')
  watch.update([position, other])
  t.mock.timers.tick(1000)
  socket.tick('94')
  await Promise.resolve()
  assert.deepEqual(calls, ['alice'])
  t.mock.timers.tick(3000)
  socket.tick('106')
  socket.tick('90', Date.now() - 1)
  t.mock.timers.tick(1000)
  socket.tick('94', Date.now() + 10)
  await Promise.resolve()
  assert.deepEqual(calls, ['alice', 'bob'])
  t.mock.timers.tick(11)
  await Promise.resolve()
  assert.deepEqual(calls, ['alice', 'bob', 'alice'])
  watch.update([{ ...position, symbol: 'ETHUSDT' }])
  assert.deepEqual(socket.messages.slice(1).map(m => [m.method, m.params]), [
    ['UNSUBSCRIBE', ['btcusdt@markPrice@1s']], ['SUBSCRIBE', ['ethusdt@markPrice@1s']],
  ])
  assert.equal(connect.mock.callCount(), 1)
  watch.update([])
  assert.equal(socket.closed, true)
  watch.close()
})

test('disconnects back off, while removal of all holdings cancels reconnect and pending connections', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now })
  const sockets = []
  const connect = t.mock.fn(async () => { const socket = fakeSocket(); sockets.push(socket); return socket })
  const watch = createMarkWatch('testnet', connect, () => assert.fail())
  watch.update([position])
  await Promise.resolve()
  sockets[0].onclose()
  watch.update([position])
  assert.equal(sockets.length, 1)
  t.mock.timers.tick(1000)
  await Promise.resolve()
  assert.equal(sockets.length, 2)
  sockets[1].onclose()
  watch.update([])
  t.mock.timers.tick(120000)
  assert.equal(sockets.length, 2)
  watch.update([position])
  watch.close()
  await Promise.resolve()
  assert.equal(sockets[2].closed, true)
})
