import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createPortfolioMonitor } from './portfolio-monitor.js'

const epoch = 1_800_000_000_000
const trade = (ms, overrides = {}) => ({ orderUpdateTime: epoch + ms, orderTime: epoch + ms - 1,
  symbol: 'BTCUSDT', positionSide: 'LONG', side: 'BUY', executedQty: '1', avgPrice: '10', ...overrides })
const day = 86_400_000
const success = (rows, indexValue = null, total) => Response.json({ code: '000000', data: { list: rows, indexValue, total } })

function harness(t, observeClosures) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let time = epoch
  let reply = () => success([])
  const calls = []
  const stored = new Map()
  const sampler = createPortfolioMonitor({ now: () => time, observeClosures,
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
    }, getStore: () => ({ record(id, { startTime, endTime, rows }) {
      const changed = []
      for (const row of rows) {
        assert.ok(row.orderUpdateTime >= startTime && row.orderUpdateTime <= endTime)
        const key = id + ':' + row.orderUpdateTime
        if (!stored.has(key)) { stored.set(key, row); changed.push(row) }
      }
      return changed
    } }),
  })
  t.after(() => sampler.close())
  return { sampler, calls, rows: () => [...stored.values()], at(ms) { time = epoch + ms }, send(fn) { reply = fn } }
}

test('backfills a shared 24-hour window and keeps polling only while observed', async t => {
  const h = harness(t)
  const a = randomUUID(), b = randomUUID()
  h.send(() => success([trade(-day - 1), trade(-day), trade(-1), trade(4_500)], 'final-row', 4))
  h.sampler.observe(a, ['91'])
  h.sampler.observe(b, ['91'])
  await h.sampler.poll()
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0], { portfolioId: '91', startTime: epoch - day, endTime: epoch, pageSize: 50 })
  assert.deepEqual(h.rows(), [trade(-day), trade(-1)])

  h.at(5_000)
  // No heartbeat since the first request: a timer alone cannot collect trades.
  await h.sampler.poll()
  assert.equal(h.calls.length, 1)
  h.sampler.observe(a, ['91'])
  h.sampler.observe(b, ['91'])
  await h.sampler.poll()
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.rows(), [trade(-day), trade(-1), trade(4_500)])
  h.sampler.release(a)
  h.at(10_000)
  h.send(() => success([trade(9_900), trade(4_500), trade(3_300)]))
  h.sampler.observe(b, ['91'])
  await h.sampler.poll()
  assert.deepEqual(h.rows(), [trade(-day), trade(-1), trade(4_500), trade(9_900), trade(3_300)])

  h.sampler.release(b)
  h.at(15_000)
  h.send(() => success([trade(12_000)]))
  assert.deepEqual(h.sampler.observe(a, ['91']), { portfolios: [] })
  await h.sampler.poll()
  assert.equal(h.calls.length, 3)
  h.sampler.observe(randomUUID(), ['91'])
  await h.sampler.poll()
  assert.equal(h.calls.length, 4)
  assert.deepEqual(h.rows(), [trade(-day), trade(-1), trade(4_500), trade(9_900), trade(3_300), trade(12_000)])
})

test('a new tab shares an active collector and reopening after expiration catches up inside 24 hours', async t => {
  const h = harness(t)
  const a = randomUUID(), b = randomUUID()
  h.sampler.observe(a, ['1'])
  await h.sampler.poll()
  // The original lease has not yet timed out, so the new page uses its feed.
  h.at(10_000)
  h.send(() => success([trade(5_000)]))
  h.sampler.observe(b, ['1'])
  await h.sampler.poll()
  h.at(18_000)
  h.send(() => success([trade(5_000), trade(12_000)]))
  h.sampler.observe(b, ['1'])
  await h.sampler.poll()
  assert.deepEqual(h.rows(), [trade(5_000), trade(12_000)])
  assert.equal(h.calls[1].startTime, epoch + 10_000 - 300_000)

  h.at(60_000)
  h.send(() => success([trade(59_900), trade(24_000)]))
  h.sampler.observe(b, ['1'])
  await h.sampler.poll()
  assert.equal(h.calls.at(-1).startTime, epoch + 60_000 - day)
  assert.deepEqual(h.rows(), [trade(5_000), trade(12_000), trade(59_900), trade(24_000)])
})

test('rate limits pause all portfolios and recovered snapshots include the offline interval', async t => {
  const h = harness(t)
  const view = randomUUID()
  h.send(() => new Response(null, { status: 429, headers: { 'Retry-After': '12' } }))
  h.sampler.observe(view, ['1', '2'])
  await h.sampler.poll()
  h.at(8_000)
  h.sampler.observe(view, ['1', '2'])
  await h.sampler.poll()
  assert.deepEqual(h.calls.map(x => x.portfolioId), ['1'])

  h.send(() => success([trade(7_000), trade(18_000)]))
  h.at(12_000)
  h.sampler.observe(view, ['1', '2'])
  await h.sampler.poll()
  assert.deepEqual(h.calls.map(x => x.portfolioId), ['1', '2'])
  assert.deepEqual(h.rows(), [trade(7_000)])
  h.at(17_000)
  h.sampler.observe(view, ['1'])
  await h.sampler.poll()
  assert.equal(h.calls.at(-1).portfolioId, '1')
  h.at(22_000)
  h.sampler.observe(view, ['1'])
  await h.sampler.poll()
  assert.deepEqual(h.rows().filter(row => row.orderUpdateTime === epoch + 18_000), [trade(18_000)])
})

test('paginates the original 24-hour window, distinguishes Binance busy from an empty result, and deduplicates overlap', async t => {
  const h = harness(t)
  const view = randomUUID()
  const recent = trade(-1_000)
  const earlier = trade(-12 * 3_600_000)
  h.send(() => success([recent], 'page2'))
  assert.equal(h.sampler.observe(view, ['3']).portfolios[0].syncing, true)
  await h.sampler.poll()
  assert.deepEqual(h.rows(), [recent])
  h.at(5_000)
  h.send(() => Response.json({ code: '11012005', message: 'The system is currently busy.' }))
  h.sampler.observe(view, ['3'])
  await h.sampler.poll()
  const status = h.sampler.observe(view, ['3']).portfolios[0]
  assert.equal(status.syncing, true)
  assert.match(status.error, /11012005/)
  assert.deepEqual(h.calls[1], { ...h.calls[0], indexValue: 'page2' })
  await h.sampler.poll()
  h.at(10_000)
  h.send(() => success([recent, earlier], 'page3'))
  h.sampler.observe(view, ['3'])
  await h.sampler.poll()
  assert.deepEqual(h.calls[2], h.calls[1])
  assert.deepEqual(h.rows(), [recent, earlier])
  h.at(15_000)
  h.send(() => success([], 'page3'))
  h.sampler.observe(view, ['3'])
  await h.sampler.poll()
  const recovered = h.sampler.observe(view, ['3']).portfolios[0]
  assert.equal(recovered.syncing, false)
  assert.equal(recovered.error, '')
})

test('closing details share the same pacing and repeat disclosures do not schedule more lookups', async t => {
  const details = []
  const h = harness(t, (id, window) => {
    assert.equal(window.isCurrent(), true)
    details.push([id, window.startTime, window.endTime, window.rows])
    return 1
  })
  const view = randomUUID()
  assert.equal(h.sampler.observe(view, ['19']).portfolios[0].lastPositionChangeAt, null)
  await h.sampler.poll()
  const close = trade(3_000, { side: 'SELL' })
  h.at(6_000)
  h.send(() => success([close, trade(2_000)]))
  h.sampler.observe(view, ['19'])
  await h.sampler.poll()
  assert.deepEqual(details, [])
  h.at(11_000)
  h.sampler.observe(view, ['19'])
  await h.sampler.poll()
  assert.deepEqual(details, [['19', epoch + 6_000 - 300_000, epoch + 6_000, [close]]])
  assert.equal(h.calls.length, 2)
  for (const now of [16_000, 21_000]) {
    h.at(now)
    assert.equal(h.sampler.observe(view, ['19']).portfolios[0].lastPositionChangeAt, epoch + 11_000)
    await h.sampler.poll()
  }
  assert.equal(details.length, 1)
  assert.equal(h.calls.length, 4)
})

test('removing a portfolio during the request discards its late response', async t => {
  const h = harness(t)
  const view = randomUUID()
  let finish
  let started
  const inProgress = new Promise(resolve => { started = resolve })
  h.send(() => new Promise(resolve => { finish = resolve; started() }))
  h.sampler.observe(view, ['5'])
  const inFlight = h.sampler.poll()
  await inProgress
  h.sampler.observe(view, ['8'])
  finish(success([trade(0)]))
  await inFlight
  assert.deepEqual(h.rows(), [])
  await h.sampler.close()
  assert.deepEqual(h.sampler.observe(randomUUID(), ['5']), { portfolios: [] })
})

test('numeric position IDs keep all source digits from public disclosure to the closing lookup', async t => {
  const ids = ['9007199254740992', '9007199254740993']
  let lookup
  const h = harness(t, (_, { rows }) => { lookup = rows.map(row => row.positionId) })
  const view = randomUUID()
  h.sampler.observe(view, ['55'])
  await h.sampler.poll()
  h.send(() => success(ids.map((id, i) => trade(1_000 + i, { side: 'SELL', positionId: JSON.rawJSON(id) }))))
  h.at(5_000)
  h.sampler.observe(view, ['55'])
  await h.sampler.poll()
  assert.deepEqual(h.rows().map(row => row.positionId), ids)
  h.at(10_000)
  h.sampler.observe(view, ['55'])
  await h.sampler.poll()
  assert.deepEqual(lookup, ids)
})
