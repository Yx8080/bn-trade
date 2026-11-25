import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLocalOrderDb } from '../worker/local-orders.js'
import { createApiMiddleware } from './api.js'
import { observeClosedPositions } from './observed-positions.js'

test('offline HTTP date queries and older pages survive a restart without starting any Binance traffic', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bn-observed-http-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const databaseFile = join(directory, 'journal.sqlite')
  const id = '1001'
  const db = createLocalOrderDb(databaseFile)
  try {
    const rows = [9, 10, 11].map(time => ({ symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', executedQty: 1,
      orderId: String(time), orderUpdateTime: time, avgPrice: 42 }))
    db.observedTrades.record(id, { startTime: 10, endTime: 11, rows })
    db.observedPositions.record(id, [{ positionId: '9001', symbol: 'BTCUSDT', side: 'Long', closed: 11, asset: 'USDT', closingPnl: 3 }])
  } finally { db.close() }
  const localFetch = globalThis.fetch
  const upstream = t.mock.method(globalThis, 'fetch', () => { throw Error('offline') })
  const api = createApiMiddleware({ env: { NO_PROXY: '*' }, databaseFile })
  const server = createServer((req, res) => api(req, res, () => res.writeHead(404).end()))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const base = 'http://127.0.0.1:' + server.address().port + '/api/'
    const path = 'monitor/trades?portfolioId=' + id + '&startTime=0&endTime=12&pageSize=1'
    const first = await (await localFetch(base + path)).json()
    assert.equal(first.total, 2)
    assert.deepEqual(first.list.map(row => row.orderUpdateTime), [11])
    const second = await (await localFetch(base + path + '&cursor=' + first.cursor)).json()
    assert.deepEqual(second.list.map(row => row.orderUpdateTime), [10])
    assert.equal(second.cursor, undefined)
    const empty = await (await localFetch(base + 'monitor/trades?portfolioId=' + id + '&startTime=0&endTime=9')).json()
    assert.deepEqual(empty, { list: [], total: 0 })
    assert.equal((await localFetch(base + path + '&cursor=bad')).status, 400)
    const positions = await (await localFetch(base + 'monitor/positions?portfolioId=' + id)).json()
    assert.equal(positions.rows[0].closingPnl, 3)
    // Cached versions of the monitor also read from the local store.
    for (const [route, query, size] of [
      ['latest-records', { startTime: 0, endTime: 12 }, 2], ['position-history', { pageNumber: 1 }, 1],
    ]) {
      const old = await localFetch(base + 'binance/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portfolioId: id, pageSize: 10, ...query }) })
      assert.equal((await old.json()).data.list.length, size)
    }
    assert.equal(upstream.mock.callCount(), 0)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await api.close()
  }
})

test('an observed close retains only matching, newly closed full positions and preserves precise exchange IDs', async t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const sample = { startTime: 10, endTime: 20, isCurrent: () => true,
    rows: [{ symbol: 'BTCUSDT', positionSide: 'LONG', orderUpdateTime: 18 }] }
  const position = { symbol: 'BTCUSDT', positionId: '1', status: 'All Closed', side: 'Long', closed: 18, closingPnl: '3.5', type: 'UM' }
  let calls = 0
  const env = { fetchBinance: async (url, init) => {
    calls++
    assert.equal(url.pathname.split('/').at(-1), 'position-history')
    assert.deepEqual(JSON.parse(init.body), { portfolioId: '42', pageNumber: 1, pageSize: 50 })
    const list = [{ ...position, positionId: 'large-id' }, { ...position, closed: 9 }, { ...position, closed: 21 }, { ...position, closed: 17 },
      { ...position, side: 'Short' }, { ...position, status: 'Open' }, { ...position, symbol: 'ETHUSDT' }]
    return new Response(JSON.stringify({ code: '000000', data: { total: 200, list } }).replace('"large-id"', '9223372036854775807'))
  } }
  assert.equal(await observeClosedPositions(env, () => db.observedPositions, '42', sample), 1)
  assert.equal(calls, 1)
  const result = db.observedPositions.page('42', 1, 10)
  assert.equal(result.total, 1)
  assert.deepEqual(result.rows.map(row => [row.positionId, row.closingPnl, row.asset]), [['9223372036854775807', 3.5, 'USDT']])
  let active = true
  const late = { fetchBinance: async () => { active = false; return Response.json({ code: '000000', data: { list: [position] } }) } }
  assert.equal(await observeClosedPositions(late, () => db.observedPositions, '43', { ...sample, isCurrent: () => active }), 0)
  assert.equal(db.observedPositions.page('43', 1, 10).total, 0)
})

test('only fresh evidence fills missing position fields, preserves zero, and skips the exchange once complete', async t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const store = db.observedPositions
  const sample = { startTime: 10, endTime: 20, isCurrent: () => true,
    rows: [{ positionId: 'p1', symbol: 'BTCUSDT', positionSide: 'SHORT', orderUpdateTime: 18 }] }
  let position = { positionId: 'p1', symbol: 'BTCUSDT', status: 'All Closed', side: 'Short',
    closed: 17, closingPnl: '0', avgCost: '128' }
  let calls = 0
  const env = { fetchBinance: async () => {
    calls++
    const other = { ...position, positionId: 'p2', closed: 18, closingPnl: 100 }
    return Response.json({ code: '000000', data: { list: [other, position] } })
  } }
  const observe = event => observeClosedPositions(env, () => store, '42', event)
  const local = () => store.page('42', 1, 10).rows
  assert.equal(await observe(sample), 1)
  assert.equal(local().length, 1)
  assert.equal(local()[0].roi, null)
  assert.equal(await observe(sample), 0)
  position = { ...position, marginAsset: 'USDT', opened: 5, avgCost: 30, avgClosePrice: 130,
    closedVolume: 6, closingPnl: 80, roi: 0 }
  assert.equal(await observe({ ...sample, rows: [] }), 0)
  assert.equal(await observe({ ...sample, startTime: 19 }), 0)
  assert.equal(await observe({ ...sample, isCurrent: () => false }), 0)
  assert.equal(calls, 2)
  assert.equal(local()[0].roi, null)
  // A newly observed update explicitly naming this same archived position can
  // fill its gaps even when its original closing instant is in an older sample.
  assert.equal(await observe({ ...sample, startTime: 18 }), 1)
  assert.deepEqual(local()[0], { positionId: 'p1', symbol: 'BTCUSDT', side: 'Short', asset: 'USDT',
    closed: 17, opened: 5, avgCost: 128, avgClosePrice: 130, closedVolume: 6, closingPnl: 0, roi: 0 })
  assert.equal(await observe(sample), 0)
  assert.equal(await observe({ ...sample, rows: [{ symbol: 'BTCUSDT', positionSide: 'SHORT', orderUpdateTime: 17 }] }), 0)
  assert.equal(calls, 3)
})

test('an ambiguous close without position ID or a newly seen ID for an older position cannot add past positions', async t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const row = { symbol: 'BTCUSDT', positionSide: 'LONG', orderUpdateTime: 18, orderId: 'p1' }
  const sample = { startTime: 10, endTime: 20, isCurrent: () => true, rows: [row] }
  const position = { positionId: 'p1', symbol: row.symbol, status: 'All Closed', side: 'Long', closed: 18 }
  const env = { fetchBinance: async () => Response.json({ code: '000000', data: { list: [
    position, { ...position, positionId: 'p2' }, { ...position, closed: 5, positionId: 'old' },
  ] } }) }
  const observe = rows => observeClosedPositions(env, () => db.observedPositions, '42', { ...sample, rows })
  assert.equal(await observe([row]), 0)
  assert.equal(await observe([{ ...row, positionId: 'old' }]), 0)
  assert.equal(db.observedPositions.page('42', 1, 10).total, 0)
})
