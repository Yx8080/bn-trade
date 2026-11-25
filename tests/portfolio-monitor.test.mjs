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
    if (url.pathname === '/api/monitor/release') return new Response(null, { status: 204 })
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

test('可见期间建租约；历史查询、游标翻页和过期请求都不改变采集范围', async t => {
  const late = Promise.withResolvers()
  const historicalStart = Date.parse('2020-01-01T00:00:00+08:00')
  const { history, calls, tick } = fixture(t, (path, params) => {
    if (path === '/api/monitor/observe') return status(Date.now(), 123456789)
    assert.equal(path, '/api/monitor/trades')
    if (Number(params.get('startTime')) !== historicalStart) return late.promise
    return params.get('cursor') ? Response.json({ list: [row('older')], total: 2 })
      : Response.json({ list: [row('newer')], total: 2, cursor: 'sqlite-snapshot' })
  })
  assert.equal(calls.length, 0)
  history.start()
  await settle()
  const firstVisit = calls.find(c => c.path.endsWith('/observe')).body
  assert.deepEqual(history.updatedAtById.value, { '123': 123456789 })
  assert.deepEqual(Object.keys(firstVisit).sort(), ['portfolioIds', 'viewId'])
  history.startDate.value = history.endDate.value = '2020-01-01'
  history.search()
  await settle()
  history.loadMore()
  await settle()
  assert.equal(calls.at(-1).params.get('cursor'), 'sqlite-snapshot')
  assert.equal(calls.filter(c => c.path.endsWith('/observe')).length, 1)
  late.resolve(Response.json({ list: [row('discarded')], total: 1 }))
  await settle()
  assert.deepEqual(history.portfolios.value[0].records.map(r => r.observedId), ['newer', 'older'])
  const localReads = calls.filter(c => c.path.endsWith('/trades')).length
  await tick()
  assert.equal(calls.filter(c => c.path.endsWith('/trades')).length, localReads)
  history.stop()
  assert.deepEqual(history.updatedAtById.value, {})
  assert.deepEqual(calls.at(-1).body, { viewId: firstVisit.viewId })
  history.start()
  assert.notEqual(calls.at(-1).body.viewId, firstVisit.viewId)
})

test('心跳失败后释放旧租约，下次恢复从新访问开始', async t => {
  let available = false
  const { history, calls, tick } = fixture(t, path => {
    if (path === '/api/monitor/trades') return Response.json({ list: [], total: 0 })
    assert.equal(path, '/api/monitor/observe')
    if (!available) throw Error('断线')
    return status(null)
  })
  history.start()
  await settle()
  const first = calls.find(c => c.path.endsWith('/observe')).body.viewId
  assert.equal(calls.at(-1).path, '/api/monitor/release')
  assert.deepEqual(calls.at(-1).body, { viewId: first })
  assert.equal(history.portfolios.value[0].observation.error, '断线')
  available = true
  await tick()
  assert.notEqual(calls.at(-1).body.viewId, first)
  assert.equal(history.portfolios.value[0].observation.error, '')
})
