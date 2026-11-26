import worker from '../worker/index.js'
import { ApiError } from '../worker/trading.js'

const interval = 5_000
const lease = 25_000
const historyWindow = 86_400_000
const recentOverlap = 300_000
const maxViews = 512
const maxPortfolios = 2_000
const exactNumericFields = new Set(['orderId', 'positionId', 'avgPrice', 'executedQty', 'quoteQuantity', 'totalPnl'])
const validView = id => typeof id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)
const invalid = () => new ApiError(400, 'INVALID_MONITOR', '监控页面标识或组合列表无效。')
const busy = () => new ApiError(429, 'MONITOR_BUSY', '当前监控组合过多，请稍后重试。')

async function historyPage(fetchBinance, portfolioId, { startTime, endTime, indexValue }, signal) {
  const body = { portfolioId, startTime, endTime, pageSize: 50, indexValue }
  const req = new Request('http://localhost/api/binance/latest-records', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const response = await worker.fetch(req, { fetchBinance: (url, init) =>
    fetchBinance(url, { ...init, signal: AbortSignal.any([signal, init.signal]) }) })
  const data = JSON.parse(await response.text(), (key, value, context) =>
    typeof value === 'number' && exactNumericFields.has(key) ? context.source : value)
  if (!response.ok || data?.code !== '000000' || data.success === false || !Array.isArray(data.data?.list)) {
    const message = data?.code === '11012005' ? '币安查询繁忙（11012005），将自动重试。'
      : data?.message || '币安暂未提供这个组合的公开成交。'
    const error = new ApiError(response.ok ? 502 : response.status, 'MONITOR_UPSTREAM', message)
    error.retryAfter = response.headers.get('Retry-After')
    error.offline = ['UPSTREAM_TIMEOUT', 'UPSTREAM_UNAVAILABLE'].includes(data?.code)
    throw error
  }
  return data.data
}

function backoff(error, now, failures) {
  const header = error.retryAfter ?? error.headers?.['Retry-After']
  const after = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now
  if (Number.isFinite(after) && after > 0) return Math.max(interval, after)
  if ([401, 403, 418, 429, 451].includes(error.status)) return 60_000
  return Math.min(60_000, interval * 2 ** Math.min(4, failures - 1))
}

function isClosing(row) {
  return Number(row.executedQty) > 0 && ((row.positionSide === 'LONG' && row.side === 'SELL')
    || (row.positionSide === 'SHORT' && row.side === 'BUY'))
}

export function createPortfolioMonitor({ fetchBinance, getStore, observeClosures, now = Date.now }) {
  const views = new Map()
  const feeds = new Map()
  const released = new Map()
  let stopped = false
  let nextAt = 0
  let cooldownUntil = 0
  let active

  function leave(viewId, id) {
    const feed = feeds.get(id)
    if (!feed) return
    feed.watchers.delete(viewId)
    if (!feed.watchers.size) {
      feeds.delete(id)
      feed.controller.abort()
    }
  }

  function expire(at) {
    for (const [id, view] of views) {
      if (at - view.seenAt <= lease) continue
      for (const portfolio of view.ids) leave(id, portfolio)
      views.delete(id)
    }
    for (const [id, until] of released) if (at >= until) released.delete(id)
  }

  function observe(viewId, portfolioIds) {
    if (!validView(viewId) || !Array.isArray(portfolioIds) || portfolioIds.length > 100
      || portfolioIds.some(id => typeof id !== 'string' || !/^\d{1,30}$/.test(id))) throw invalid()
    const at = now()
    expire(at)
    if (stopped || released.has(viewId)) return { portfolios: [] }
    const ids = new Set(portfolioIds)
    const prior = views.get(viewId)
    if ((!prior && views.size >= maxViews)
      || feeds.size + [...ids].filter(id => !feeds.has(id)).length > maxPortfolios) throw busy()
    if (prior) for (const id of prior.ids) if (!ids.has(id)) leave(viewId, id)
    views.set(viewId, { ids, seenAt: at })
    const portfolios = []
    for (const id of ids) {
      let feed = feeds.get(id)
      if (!feed) {
        feed = { id, watchers: new Set(), controller: new AbortController(), startedAt: at, endTime: at,
          sampledThrough: -1, history: undefined, lastSuccessAt: null, lastPositionChangeAt: null, error: '',
          failures: 0, retryAt: 0, closure: null }
        feeds.set(id, feed)
      }
      feed.endTime = at
      feed.watchers.add(viewId)
      portfolios.push({ portfolioId: id, startedAt: feed.startedAt, lastSuccessAt: feed.lastSuccessAt, syncing: feed.sampledThrough < 0,
        lastPositionChangeAt: feed.lastPositionChangeAt, error: feed.error })
    }
    void poll()
    return { portfolios }
  }

  function release(viewId) {
    if (!validView(viewId)) throw invalid()
    const at = now()
    expire(at)
    const view = views.get(viewId)
    if (view) for (const id of view.ids) leave(viewId, id)
    views.delete(viewId)
    // A keepalive release may arrive before a delayed heartbeat.
    if (released.size >= maxViews * 2) released.delete(released.keys().next().value)
    released.set(viewId, at + 2 * lease)
  }

  function current(feed) {
    expire(now())
    return !stopped && feeds.get(feed.id) === feed
  }

  async function sample(feed) {
    if (!feed.history?.indexValue || feed.history.endTime <= feed.endTime - historyWindow) {
      const endTime = feed.endTime
      // Keep a short overlap for delayed disclosures and catch up after outages.
      const startTime = Math.max(0, endTime - historyWindow, Math.min(feed.sampledThrough, endTime - recentOverlap))
      feed.history = { startTime, endTime, indexValue: undefined, cursors: new Set() }
    }
    const query = feed.history
    const { startTime, endTime } = query
    const { list, total, indexValue } = await historyPage(fetchBinance, feed.id, query, feed.controller.signal)
    if (!current(feed)) return
    // Binance can return the last row's cursor even when it has no next page.
    const firstPageComplete = !query.indexValue && Number.isSafeInteger(total) && total <= list.length
    const hasMore = !firstPageComplete && list.length > 0 && typeof indexValue === 'string' && indexValue !== '' && indexValue !== '-1'
    if (hasMore && query.cursors.has(indexValue)) {
      feed.history = undefined
      throw new ApiError(502, 'MONITOR_UPSTREAM_CURSOR', '币安返回了重复的成交分页游标，将重新同步。')
    }
    const visible = list.filter(row => {
      const raw = row?.orderUpdateTime
      const time = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
      return Number.isSafeInteger(time) && time >= startTime && time <= endTime
    })
    if (visible.length) {
      const changed = getStore().record(feed.id, { startTime, endTime, rows: visible })
      const closes = changed.filter(isClosing)
      if (observeClosures && closes.length) feed.closure = { startTime, endTime, rows: closes, queuedAt: now() }
    }
    if (hasMore) {
      query.cursors.add(indexValue)
      query.indexValue = indexValue
    } else {
      feed.sampledThrough = endTime
      feed.history = undefined
    }
    feed.lastSuccessAt = now()
    feed.error = ''
    feed.failures = 0
  }

  async function run() {
    const at = now()
    expire(at)
    if (stopped || at < nextAt) return
    for (const [id, feed] of feeds) {
      let closure = feed.closure
      if (closure && at - closure.queuedAt > lease) closure = feed.closure = null
      if (at < feed.retryAt || (!closure && !feed.history && feed.endTime <= feed.sampledThrough)) continue
      feeds.delete(id)
      feeds.set(id, feed)
      try {
        if (closure) {
          feed.closure = null
          const isCurrent = () => current(feed)
          const changed = await observeClosures(id, { ...closure, isCurrent, signal: feed.controller.signal })
          if (changed > 0 && isCurrent()) feed.lastPositionChangeAt = now()
        } else await sample(feed)
      } catch (error) {
        if (current(feed)) {
          feed.error = error instanceof ApiError ? error.message : '监控采样暂时失败，请稍后查看。'
          const delay = backoff(error, now(), ++feed.failures)
          feed.retryAt = now() + delay
          if ([401, 403, 418, 429, 451].includes(error.status) || error.offline || error.retryAfter || error.headers?.['Retry-After']) {
            cooldownUntil = Math.max(cooldownUntil, feed.retryAt)
            nextAt = Math.max(nextAt, cooldownUntil)
          }
        }
      } finally {
        nextAt = Math.max(nextAt, now() + interval)
      }
      break
    }
  }

  function poll() {
    if (!active) active = run().finally(() => { active = undefined })
    return active
  }
  const timer = setInterval(poll, 1_000)
  timer.unref()
  return { observe, release, poll, async close() {
    stopped = true
    clearInterval(timer)
    for (const feed of feeds.values()) feed.controller.abort()
    views.clear()
    feeds.clear()
    released.clear()
    await active
  } }
}
