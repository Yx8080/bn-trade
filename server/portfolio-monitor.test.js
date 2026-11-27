import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalOrderDb } from '../worker/local-orders.js'
import { createPortfolioMonitor } from './portfolio-monitor.js'

const epoch = 1_800_000_000_000
const trade = (ms, overrides = {}) => ({ orderUpdateTime: epoch + ms, orderTime: epoch + ms - 1,
  symbol: 'BTCUSDT', positionSide: 'LONG', side: 'BUY', executedQty: '1', avgPrice: '10', ...overrides })
const day = 86_400_000
const success = (rows, indexValue = null, total) => Response.json({ code: '000000', data: { list: rows, indexValue, total } })

function harness(t, store, copy) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let time = epoch
  let portfolioIds = []
  let reply = () => success([])
  const calls = []
  const stored = new Map()
  const sampler = createPortfolioMonitor({ now: () => time, getPortfolioIds: () => portfolioIds,
    ...copy,
    fetchBinance(url, init) {
      assert.equal(url.href, 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history')
      assert.equal(init.method, 'POST')
      const body = JSON.parse(init.body)
      assert.deepEqual(Object.keys(body).sort(), body.indexValue
        ? ['endTime', 'indexValue', 'pageSize', 'portfolioId', 'startTime'] : ['endTime', 'pageSize', 'portfolioId', 'startTime'])
      assert.equal(body.pageSize, 50)
      assert.ok(body.endTime - body.startTime <= day)
      calls.push(body)
      return reply(body)
    }, getStore: () => store ?? { record(id, { startTime, endTime, rows }) {
      const changed = []
      for (const row of rows) {
        assert.ok(row.orderUpdateTime >= startTime && row.orderUpdateTime <= endTime)
        const key = id + ':' + row.orderUpdateTime
        if (!stored.has(key)) { stored.set(key, row); changed.push(row) }
      }
      return changed
    } },
  })
  t.after(() => sampler.close())
  return { sampler, calls, rows: () => [...stored.values()], at(ms) { time = epoch + ms }, send(fn) { reply = fn },
    watch(ids) { portfolioIds = ids; sampler.refresh() } }
}

test('backfills a 24-hour window and keeps polling with no browser requests', async t => {
  const h = harness(t)
  h.send(() => success([trade(-day - 1), trade(-day), trade(-1), trade(4_500)], 'final-row', 4))
  h.watch(['91', '91'])
  await h.sampler.poll()
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0], { portfolioId: '91', startTime: epoch - day, endTime: epoch, pageSize: 50 })
  assert.deepEqual(h.rows(), [trade(-day), trade(-1)])

  h.at(5_000)
  t.mock.timers.tick(1000)
  await h.sampler.poll()
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.rows(), [trade(-day), trade(-1), trade(4_500)])
  h.at(10_000)
  h.send(() => success([trade(9_900), trade(4_500), trade(3_300)]))
  await h.sampler.poll()
  assert.deepEqual(h.rows(), [trade(-day), trade(-1), trade(4_500), trade(9_900), trade(3_300)])

  h.watch([])
  h.at(15_000)
  h.send(() => success([trade(12_000)]))
  assert.deepEqual(h.sampler.status(['91']), [])
  await h.sampler.poll()
  assert.equal(h.calls.length, 3)
  h.watch(['91'])
  await h.sampler.poll()
  assert.equal(h.calls.length, 4)
  assert.deepEqual(h.rows(), [trade(-day), trade(-1), trade(4_500), trade(9_900), trade(3_300), trade(12_000)])
})

test('a background feed catches up after gaps without losing the overlap for late fills', async t => {
  const h = harness(t)
  h.watch(['1'])
  await h.sampler.poll()
  h.at(10_000)
  h.send(() => success([trade(5_000)]))
  await h.sampler.poll()
  h.at(18_000)
  h.send(() => success([trade(5_000), trade(12_000)]))
  await h.sampler.poll()
  assert.deepEqual(h.rows(), [trade(5_000), trade(12_000)])
  assert.equal(h.calls[1].startTime, epoch + 10_000 - 300_000)

  h.at(60_000)
  h.send(() => success([trade(59_900), trade(24_000)]))
  await h.sampler.poll()
  assert.equal(h.calls.at(-1).startTime, epoch + 60_000 - 300_000)
  assert.deepEqual(h.rows(), [trade(5_000), trade(12_000), trade(59_900), trade(24_000)])
})

test('rate limits pause all portfolios and recovered snapshots include the offline interval', async t => {
  const h = harness(t)
  h.send(() => new Response(null, { status: 429, headers: { 'Retry-After': '12' } }))
  h.watch(['1', '2'])
  await h.sampler.poll()
  h.at(8_000)
  await h.sampler.poll()
  assert.deepEqual(h.calls.map(x => x.portfolioId), ['1'])

  h.send(() => success([trade(7_000), trade(18_000)]))
  h.at(12_000)
  await h.sampler.poll()
  assert.deepEqual(h.calls.map(x => x.portfolioId), ['1', '2'])
  assert.deepEqual(h.rows(), [trade(7_000)])
  h.at(17_000)
  h.watch(['1'])
  await h.sampler.poll()
  assert.equal(h.calls.at(-1).portfolioId, '1')
  h.at(22_000)
  await h.sampler.poll()
  assert.deepEqual(h.rows().filter(row => row.orderUpdateTime === epoch + 18_000), [trade(18_000)])
})

test('paginates the original 24-hour window, distinguishes Binance busy from an empty result, and deduplicates overlap', async t => {
  const h = harness(t)
  const recent = trade(-1_000)
  const earlier = trade(-12 * 3_600_000)
  h.send(() => success([recent], 'page2'))
  h.watch(['3'])
  assert.equal(h.sampler.status(['3'])[0].syncing, true)
  await h.sampler.poll()
  assert.deepEqual(h.rows(), [recent])
  h.at(5_000)
  h.send(() => Response.json({ code: '11012005', message: 'The system is currently busy.' }))
  await h.sampler.poll()
  const status = h.sampler.status(['3'])[0]
  assert.equal(status.syncing, true)
  assert.match(status.error, /11012005/)
  assert.deepEqual(h.calls[1], { ...h.calls[0], indexValue: 'page2' })
  await h.sampler.poll()
  h.at(10_000)
  h.send(() => success([recent, earlier], 'page3'))
  await h.sampler.poll()
  assert.deepEqual(h.calls[2], h.calls[1])
  assert.deepEqual(h.rows(), [recent, earlier])
  h.at(15_000)
  h.send(() => success([], 'page3'))
  await h.sampler.poll()
  const recovered = h.sampler.status(['3'])[0]
  assert.equal(recovered.syncing, false)
  assert.equal(recovered.error, '')
})

test('removing a portfolio during the request discards its late response', async t => {
  const h = harness(t)
  let finish
  let started
  const inProgress = new Promise(resolve => { started = resolve })
  h.send(() => new Promise(resolve => { finish = resolve; started() }))
  h.watch(['5'])
  const inFlight = h.sampler.poll()
  await inProgress
  h.watch(['8'])
  finish(success([trade(0)]))
  await inFlight
  assert.deepEqual(h.rows(), [])
  await h.sampler.close()
  assert.deepEqual(h.sampler.status(['5', '8']), [])
})

test('positions update from an older opening arriving in a later order-history page', async t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const h = harness(t, db.observedTrades)
  const close = trade(-1_000, { side: 'SELL', positionId: JSON.rawJSON('9007199254740993'), totalPnl: 2 })
  const open = trade(-2_000, { positionId: '9007199254740993' })
  h.send(({ indexValue }) => indexValue ? success([open]) : success([close], 'older'))
  h.watch(['55'])
  await h.sampler.poll()
  assert.equal(db.observedPositions.page('55', 1, 10).total, 0)
  h.at(5_000)
  await h.sampler.poll()
  const status = h.sampler.status(['55'])[0]
  assert.equal(status.lastPositionChangeAt, epoch + 5_000)
  assert.deepEqual(db.observedPositions.page('55', 1, 10).rows.map(row => row.closingPnl), [2])
  assert.equal(h.calls.length, 2)
})

test('an incomplete sample cannot become a signal batch, and older managed closes are recovered in bounded windows', async t => {
  const db = createLocalOrderDb(':memory:')
  t.after(() => db.close())
  const since = epoch - 2 * day + 3_000
  const close = trade(-day - 8_000, { side: 'SELL', orderId: '123' })
  const notices = []
  const h = harness(t, db.observedTrades, { getCopyPortfolios: () => [{ id: '77', since }],
    getCopySignals: () => db.copySignals, onCopyUpdate: id => notices.push(id) })

  h.send(() => success([close], '-1', 2))
  await h.sampler.poll()
  assert.equal(db.copySignals.read('77', since, epoch), null)
  assert.match(h.sampler.status(['77'])[0].error, /成交分页不完整/)
  assert.equal(db.copySignals.status('77').end, null)

  h.send(({ startTime, endTime }) => {
    const list = [close].filter(row => row.orderUpdateTime >= startTime && row.orderUpdateTime <= endTime)
    return success(list, null, list.length)
  })
  for (const at of [5_000, 10_000, 15_000, 20_000, 25_000, 30_000]) {
    h.at(at)
    await h.sampler.poll()
  }
  const sample = db.copySignals.read('77', since, epoch + 30_000)
  assert.equal(sample.through, epoch + 30_000)
  assert.equal(sample.recoveredAt, epoch + 5_000)
  assert.deepEqual(sample.signals.map(({ time, kind }) => [time, kind]), [[close.orderUpdateTime, 'close']])
  assert.deepEqual(notices, ['77', '77'])
  assert.equal(db.observedTrades.page({ portfolioId: '77', startTime: since, endTime: epoch + 30_000 }).total, 0)
})
