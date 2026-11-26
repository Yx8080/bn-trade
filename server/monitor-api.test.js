import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createLocalOrderDb } from '../worker/local-orders.js'
import { createApiMiddleware } from './api.js'

test('offline HTTP date queries and older pages survive a restart without starting any Binance traffic', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const directory = await mkdtemp(join(tmpdir(), 'bn-observed-http-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const databaseFile = join(directory, 'journal.sqlite')
  const id = '1001'
  const db = createLocalOrderDb(databaseFile)
  try {
    const rows = [9, 10, 11].map(time => ({ symbol: 'BTCUSDT', side: time === 11 ? 'SELL' : 'BUY', positionSide: 'LONG', executedQty: 1,
      orderId: String(time), orderUpdateTime: time, avgPrice: 42, totalPnl: time === 11 ? 3 : null }))
    db.observedTrades.record(id, { startTime: 10, endTime: 11, rows })
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

test('saved watchlists restart public collection with no connected page', async t => {
  const epoch = 1_800_000_000_000
  const id = '1042'
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: epoch })
  const directory = await mkdtemp(join(tmpdir(), 'bn-background-monitor-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const databaseFile = join(directory, 'journal.sqlite')
  const localFetch = globalThis.fetch.bind(globalThis)
  const times = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(url.hostname, 'www.binance.com')
    const { portfolioId, endTime } = JSON.parse(init.body)
    assert.equal(portfolioId, id)
    times.push(endTime)
    return Response.json({ code: '000000', data: { total: 1, list: [{ symbol: 'BTCUSDT', side: 'BUY',
      positionSide: 'LONG', executedQty: '1', avgPrice: '42', orderId: String(endTime), orderUpdateTime: endTime }] } })
  })
  async function run(check) {
    const api = createApiMiddleware({ env: { NO_PROXY: '*' }, databaseFile })
    const server = createServer((req, res) => api(req, res, () => res.writeHead(404).end()))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + server.address().port + '/api/'
    try { await check((path, options) => localFetch(base + path, options)) }
    finally { await new Promise(resolve => server.close(resolve)); await api.close() }
  }

  await run(async call => {
    const update = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portfolioIds: [id, id] }) }
    assert.equal((await call('monitor/watchlist', { ...update, headers: { ...update.headers, Authorization: 'Bearer bad' } })).status, 401)
    assert.equal((await call('monitor/watchlist', update)).status, 204)
    assert.deepEqual(times, [])
  })

  await run(async call => {
    t.mock.timers.tick(1000)
    await setImmediate()
    assert.deepEqual(times, [epoch + 1000])
    t.mock.timers.tick(5000)
    await setImmediate()
    assert.deepEqual(times, [epoch + 1000, epoch + 6000])
    assert.deepEqual(await (await call('monitor/watchlist')).json(), { portfolioIds: [id] })
    const status = await (await call('monitor/status?portfolioId=' + id + '&portfolioId=999')).json()
    assert.deepEqual(status.portfolios.map(portfolio => portfolio.portfolioId), [id])
    const archive = await (await call(`monitor/trades?portfolioId=${id}&startTime=${epoch}&endTime=${epoch + 6000}`)).json()
    assert.deepEqual(archive.list.map(trade => trade.orderUpdateTime), times.toReversed())
    assert.equal(times.length, 2)
    assert.equal((await call('monitor/observe', { method: 'POST' })).status, 404)
  })
})

test('closed positions sum actual fills only when the observed balance returns to zero', t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const save = (portfolioId, rows) => db.observedTrades.record(portfolioId, { startTime: 0, endTime: 30, rows })
  const fill = (time, side, qty, price, pnl, overrides = {}) => ({ symbol: 'BTCUSDT', quoteAsset: 'USDT',
    orderId: String(time), positionSide: 'LONG', side, orderUpdateTime: time, executedQty: qty,
    avgPrice: price, totalPnl: pnl, ...overrides })
  const page = (number = 1) => db.observedPositions.page('42', number, 1)
  const firstReduce = fill(6, 'SELL', '0.1', 30, 1)
  save('42', [
    fill(1, 'SELL', '0.1', 9, 1), // A close without a recorded opening.
    fill(2, 'BUY', '0.1', 10, null),
    fill(3, 'SELL', '0.1', 50, null, { positionSide: 'SHORT' }),
    fill(4, 'BUY', '0.2', 25, null),
    firstReduce,
  ])
  save('43', [fill(7, 'SELL', '0.2', 60, 2)])
  assert.equal(page().total, 0)

  save('42', [firstReduce, { ...firstReduce, orderUpdateTime: 7, totalPnl: 2 }, fill(8, 'SELL', '0.2', 45, -2)])
  const result = page()
  assert.equal(result.total, 1)
  const [long] = result.rows
  assert.deepEqual({ ...long, positionId: undefined }, { positionId: undefined, symbol: 'BTCUSDT', side: 'Long',
    asset: 'USDT', opened: 2, closed: 8, avgCost: 20, avgClosePrice: 40, closedVolume: 0.3, closingPnl: 0, roi: null })

  save('42', [
    fill(9, 'BUY', '0.05', 42, 1, { positionSide: 'SHORT' }),
    fill(10, 'BUY', '0.05', 38, null, { positionSide: 'SHORT' }),
    fill(11, 'BUY', '0.1', 10, null),
    fill(12, 'SELL', '0.2', 20, 1),
  ])
  assert.equal(page().total, 2)
  assert.deepEqual(page().rows.map(row => [row.side, row.avgClosePrice, row.closingPnl]), [['Short', 40, null]])
  assert.deepEqual(page(2).rows, [long])
})

test('a previously archived close can be grouped after its opening arrives in an older page', t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const position = { symbol: '牛来USDT', positionSide: 'LONG', executedQty: 480192 }
  const closed = { ...position, side: 'SELL', orderUpdateTime: 20, avgPrice: 0.0457336, totalPnl: 1901.34684871 }
  const opened = { ...position, side: 'BUY', orderUpdateTime: 10, avgPrice: 0.0417741 }
  db.observedTrades.record('42', { startTime: 10, endTime: 20, rows: [closed] })
  assert.equal(db.observedPositions.page('42', 1, 10).total, 0)
  db.observedTrades.record('42', { startTime: 10, endTime: 20, rows: [opened, closed] })
  const { total, rows } = db.observedPositions.page('42', 1, 10)
  assert.equal(total, 1)
  assert.equal(rows[0].closedVolume, 480192)
  assert.equal(rows[0].closingPnl, 1901.34684871)
})
