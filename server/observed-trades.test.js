import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLocalOrderDb } from '../worker/local-orders.js'

const owner = '9007199254740993123'
const query = { portfolioId: owner, startTime: 100, endTime: 200 }
const trade = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', side: 'BUY', positionSide: 'LONG',
  type: 'MARKET', orderTime: 100, orderUpdateTime: 120, executedQty: '0.05', avgPrice: '60000', totalPnl: '0' }

test('archive records only the sampled time window, deduplicates overlaps and preserves same-ms fills', t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const store = db.observedTrades
  const isolated = { ...trade, orderId: '9223372036854775807' }
  const rows = [{ ...trade, orderUpdateTime: 99 }, trade, { ...trade, avgPrice: 60001 }, trade, isolated,
    { ...isolated, orderId: '9223372036854775806' }, { ...trade, orderUpdateTime: 201 }]
  const changed = store.record(owner, { ...query, rows })
  assert.equal(changed.length, 5)
  assert.equal(new Set(changed.map(row => row.observedId)).size, 5)
  assert.deepEqual(store.record(owner, { ...query, rows: rows.toReversed() }), [])
  const extra = { ...trade, side: 'SELL', totalPnl: null }
  const overlap = store.record(owner, { startTime: 120, endTime: 140, rows: [trade, extra, isolated] })
  assert.equal(overlap.length, 1)
  assert.equal(overlap[0].totalPnl, null)
  assert.equal(store.page(query).total, 6)
  assert.equal(store.page({ ...query, startTime: 120, endTime: 120 }).total, 6)
  assert.equal(store.page({ ...query, portfolioId: '2' }).total, 0)
  assert.deepEqual(store.record(owner, { ...query, rows: [
    { ...trade, executedQty: 0 }, { ...trade, positionSide: 'BOTH' }, { ...trade, side: 'UNKNOWN' },
  ] }), [])
  // Different fills may first appear in separate overlapping samples.
  for (const price of ['60000.12345678901231', '60000.12345678901232']) {
    assert.equal(store.record(owner, { ...query, rows: [{ ...trade, avgPrice: price }] }).length, 1)
  }
  assert.equal(store.record(owner, { ...query, rows: [{ ...trade, avgPrice: '60000123456789012320e-15' }] }).length, 0)
  const undisclosed = store.record(owner, { ...query, rows: [{ ...trade, totalPnl: null }] })
  assert.equal(undisclosed[0].totalPnl, null)
  assert.notEqual(undisclosed[0].observedId, changed[0].observedId)
})

test('paging pins source revisions/inserts even at a shared timestamp and rejects a cursor from a different range', t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const store = db.observedTrades
  const a = { ...trade, orderId: 'a', orderUpdateTime: 125 }
  const b = { ...trade, orderId: 'b' }
  const c = { ...trade, orderId: 'c' }
  store.record(owner, { ...query, rows: [a, b, c] })
  const first = store.page({ ...query, pageSize: 1 })
  assert.deepEqual(first.list.map(row => row.orderId), ['a'])
  assert.equal(first.total, 3)
  const changed = store.record(owner, { ...query, endTime: 210, rows: [
    { ...b, orderUpdateTime: 201, totalPnl: 3 }, { ...c, totalPnl: 2 }, { ...trade, orderId: 'new' },
  ] })
  assert.equal(changed.length, 3)
  assert.deepEqual(store.record(owner, { ...query, rows: [b] }), [])
  for (const bad of [{ startTime: 101 }, { portfolioId: '7' }, { cursor: 'bad.cursor' }]) {
    assert.throws(() => store.page({ ...query, cursor: first.cursor, ...bad }), { code: 'INVALID_OBSERVED_CURSOR' })
  }
  const second = store.page({ ...query, cursor: first.cursor, pageSize: 2 })
  assert.equal(second.total, 3)
  assert.equal(second.cursor, undefined)
  assert.deepEqual(second.list.map(row => [row.orderId, row.totalPnl]), [['c',0], ['b',0]])
  const refreshed = store.page(query)
  assert.equal(refreshed.total, 3)
  assert.deepEqual(refreshed.list.map(row => [row.orderId, row.totalPnl]), [['a',0], ['new',0], ['c',2]])
  const revised = store.page({ ...query, endTime: 205 }).list.find(row => row.orderId === 'b')
  assert.equal(revised.observedId, second.list[1].observedId)
  assert.equal(revised.totalPnl, 3)
})

test('only explicitly disclosed position IDs associate an observed closing trade to its full position', t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const store = db.observedTrades
  const close = { ...trade, side: 'SELL' }
  const rows = [{ ...close, positionId: '9223372036854775807' }, { ...close, positionId: '9223372036854775806' },
    { ...close, orderId: 'unrelated-order-id' }]
  const changed = store.record(owner, { ...query, rows })
  assert.equal(changed.length, 3)
  assert.deepEqual(changed.map(row => row.positionId), ['9223372036854775807', '9223372036854775806', undefined])
  assert.deepEqual(store.record(owner, { ...query, rows: rows.toReversed() }), [])
  assert.equal(store.page(query).list.find(row => row.orderId === 'unrelated-order-id').positionId, undefined)
})

test('only public fields persist across restart and invalid samples roll back atomically', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bn-public-trades-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'orders.sqlite')
  let db = createLocalOrderDb(filename)
  try {
    const rows = [{ ...trade, tag: 'omit-this-private-sentinel' }]
    db.observedTrades.record(owner, { ...query, rows })
    assert.throws(() => db.observedTrades.record(owner, { ...query, rows: [
      { ...trade, orderId: 'tentative' }, { ...trade, orderUpdateTime: null },
    ] }), { code: 'INVALID_OBSERVED_SAMPLE' })
    assert.throws(() => db.observedTrades.page({ ...query, pageSize: 1000 }), { code: 'INVALID_OBSERVED_QUERY' })
  } finally { db.close() }
  assert.equal((await readFile(filename)).includes('omit-this-private-sentinel'), false)
  db = createLocalOrderDb(filename)
  try {
    assert.equal(db.observedTrades.page(query).total, 1)
    assert.equal(db.observedTrades.page(query).list[0].executedQty, 0.05)
  } finally { db.close() }
})
