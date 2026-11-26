import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Node's TypeScript loader needs the extension that Vite resolves for the Vue client.
const composable = new URL('../src/usePortfolioHistory.ts', import.meta.url).href
const hook = registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL === composable && specifier === './trades' ? './trades.ts' : specifier, context)
} })
const { usePortfolioHistory } = await import(composable)
hook.deregister()

const settle = () => new Promise(resolve => setImmediate(resolve))

function fixture(t, onRequest) {
  const timers = new Map()
  let sequence = 0
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout(callback, delay) { assert.equal(delay, 8_000); timers.set(++sequence, callback); return sequence },
    clearTimeout(id) { timers.delete(id) },
  } })
  const calls = []
  t.mock.method(globalThis, 'fetch', async (target, init) => {
    const url = new URL(target, 'http://localhost')
    const body = init.body && JSON.parse(init.body)
    calls.push({ path: url.pathname, params: url.searchParams, body })
    return onRequest(url.pathname, url.searchParams, body)
  })
  const history = usePortfolioHistory([{ id: '123', name: '组合' }])
  t.after(() => {
    history.stop()
    if (original) Object.defineProperty(globalThis, 'window', original)
    else delete globalThis.window
  })
  return { history, calls, async tick() {
    assert.equal(timers.size, 1)
    const [id, callback] = timers.entries().next().value
    timers.delete(id)
    await callback()
    await settle()
  } }
}

const row = observedId => ({ observedId, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
  executedQty: 1, orderTime: 1, orderUpdateTime: 1 })
const status = (lastSuccessAt, lastPositionChangeAt = null) => Response.json({ portfolios: [{
  portfolioId: '123', startedAt: Date.now(), lastSuccessAt, lastPositionChangeAt, error: '',
}] })

test('默认窗口跨日滚动 24 小时，翻页沿用原查询范围，手动搜索使用固定北京时间日期', async t => {
  const day = 86_400_000
  let now = Date.parse('2026-11-26T23:59:58+08:00')
  const initial = now
  let receivedAt = null
  t.mock.method(Date, 'now', () => now)
  const { history, calls, tick } = fixture(t, (path, params) => {
    if (path === '/api/monitor/status') return status(receivedAt)
    if (params.has('cursor')) return Response.json({ list: [], total: 3 })
    const records = [
      { ...row('recent'), orderUpdateTime: initial },
      { ...row('boundary'), orderUpdateTime: initial - day },
      { ...row('expired'), orderUpdateTime: initial - day - 1 },
    ].filter(record => record.orderUpdateTime >= Number(params.get('startTime')) &&
      record.orderUpdateTime <= Number(params.get('endTime')))
    return Response.json({ list: records, total: records.length, cursor: 'sqlite-snapshot' })
  })
  const bounds = () => {
    const { params } = calls.findLast(call => call.path.endsWith('/trades'))
    return [Number(params.get('startTime')), Number(params.get('endTime')), params.get('cursor')]
  }
  history.start()
  await settle()
  assert.deepEqual(bounds(), [initial - day, initial, null])
  assert.deepEqual(history.tradeRecords.value.map(r => r.observedId), ['recent', 'boundary'])
  now += 8_000
  await tick()
  assert.equal(history.today.value, '2026-11-27')
  assert.equal(history.startDate.value, '2026-11-26')
  assert.deepEqual(history.tradeRecords.value.map(r => r.observedId), ['recent'])
  history.loadMore()
  await settle()
  assert.deepEqual(bounds(), [initial - day, initial, 'sqlite-snapshot'])
  history.search()
  await settle()
  const manual = [Date.parse('2026-11-26T00:00:00+08:00'), Date.parse('2026-11-27T23:59:59.999+08:00'), null]
  assert.deepEqual(bounds(), manual)
  now += day
  receivedAt = now
  await tick()
  assert.deepEqual(bounds(), manual)
  history.showRecent()
  await settle()
  assert.deepEqual(bounds(), [now - day, now, null])
  assert.equal(history.pinned.value, false)
})

test('页面只读取状态和成交，换查询范围后丢弃旧的请求结果', async t => {
  const late = Promise.withResolvers()
  const historicalStart = Date.parse('2020-01-01T00:00:00+08:00')
  const { history, calls, tick } = fixture(t, (path, params) => {
    if (path === '/api/monitor/status') return status(Date.now(), 123456789)
    assert.equal(path, '/api/monitor/trades')
    if (Number(params.get('startTime')) !== historicalStart) return late.promise
    return params.get('cursor') ? Response.json({ list: [row('older')], total: 2 })
      : Response.json({ list: [row('newer')], total: 2, cursor: 'sqlite-snapshot' })
  })
  assert.equal(calls.length, 0)
  history.start()
  await settle()
  const statusRead = calls.find(c => c.path.endsWith('/status'))
  assert.deepEqual(history.updatedAtById.value, { '123': 123456789 })
  assert.deepEqual([...statusRead.params], [['portfolioId', '123']])
  assert.equal(statusRead.body, undefined)
  history.startDate.value = history.endDate.value = '2020-01-01'
  history.search()
  await settle()
  history.loadMore()
  await settle()
  assert.equal(calls.at(-1).params.get('cursor'), 'sqlite-snapshot')
  assert.equal(calls.filter(c => c.path.endsWith('/status')).length, 1)
  late.resolve(Response.json({ list: [row('discarded')], total: 1 }))
  await settle()
  assert.deepEqual(history.portfolios.value[0].records.map(r => r.observedId), ['newer', 'older'])
  const localReads = calls.filter(c => c.path.endsWith('/trades')).length
  await tick()
  assert.equal(calls.filter(c => c.path.endsWith('/trades')).length, localReads)
  const beforeStop = calls.length
  history.stop()
  assert.deepEqual(history.updatedAtById.value, {})
  assert.equal(calls.length, beforeStop)
  history.start()
  assert.equal(calls.at(-1).path, '/api/monitor/status')
})

test('状态读取失败后重试，期间仍显示 SQLite 历史', async t => {
  let available = false
  const { history, calls, tick } = fixture(t, path => {
    if (path === '/api/monitor/trades') return Response.json({ list: [row('cached')], total: 1 })
    assert.equal(path, '/api/monitor/status')
    if (!available) throw Error('断线')
    return status(null)
  })
  history.start()
  await settle()
  assert.equal(calls.at(-1).path, '/api/monitor/status')
  assert.equal(history.statusError.value, '断线')
  assert.deepEqual(history.portfolios.value[0].records.map(record => record.observedId), ['cached'])
  available = true
  await tick()
  assert.equal(calls.at(-1).path, '/api/monitor/status')
  assert.equal(history.statusError.value, '')
})
