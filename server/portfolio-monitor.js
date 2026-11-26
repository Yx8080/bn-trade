import worker from '../worker/index.js'
import { ApiError } from '../worker/trading.js'

const interval = 5_000
const historyWindow = 86_400_000
const recentOverlap = 300_000
const exactNumericFields = new Set(['orderId', 'positionId', 'avgPrice', 'executedQty', 'quoteQuantity', 'totalPnl'])

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

export function createPortfolioMonitor({ fetchBinance, getStore, getPortfolioIds, now = Date.now }) {
  const feeds = new Map()
  let stopped = false
  let nextAt = 0
  let active

  function refresh(at = now()) {
    if (stopped) return
    const ids = new Set(getPortfolioIds())
    for (const [id, feed] of feeds) {
      if (ids.has(id)) continue
      feeds.delete(id)
      feed.controller.abort()
    }
    for (const id of ids) {
      const feed = feeds.get(id)
      if (feed) feed.endTime = Math.max(feed.endTime, at)
      else {
        feeds.set(id, { id, controller: new AbortController(), startedAt: at, endTime: at,
          sampledThrough: -1, history: undefined, lastSuccessAt: null, lastPositionChangeAt: null, error: '',
          failures: 0, retryAt: 0 })
      }
    }
  }

  function status(ids) {
    return [...new Set(ids)].flatMap(id => {
      const feed = feeds.get(id)
      return feed ? [{ portfolioId: id, startedAt: feed.startedAt, lastSuccessAt: feed.lastSuccessAt, syncing: feed.sampledThrough < 0,
        lastPositionChangeAt: feed.lastPositionChangeAt, error: feed.error }] : []
    })
  }

  function current(feed) {
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
      // An older entry can complete a position whose close was already saved.
      if (changed.length) feed.lastPositionChangeAt = now()
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
    if (stopped || at < nextAt) return
    refresh(at)
    for (const [id, feed] of feeds) {
      if (at < feed.retryAt || (!feed.history && feed.endTime <= feed.sampledThrough)) continue
      feeds.delete(id)
      feeds.set(id, feed)
      try {
        await sample(feed)
      } catch (error) {
        if (current(feed)) {
          feed.error = error instanceof ApiError ? error.message : '监控采样暂时失败，请稍后查看。'
          const delay = backoff(error, now(), ++feed.failures)
          feed.retryAt = now() + delay
          if ([401, 403, 418, 429, 451].includes(error.status) || error.offline || error.retryAfter || error.headers?.['Retry-After']) {
            nextAt = Math.max(nextAt, feed.retryAt)
          }
        }
      } finally {
        nextAt = Math.max(nextAt, now() + interval)
      }
      break
    }
  }

  function poll() {
    if (!active) active = run().catch(error => {
      nextAt = now() + interval
      console.warn('读取后台监控组合失败', error?.code ?? error?.name)
    }).finally(() => { active = undefined })
    return active
  }
  const timer = setInterval(poll, 1_000)
  timer.unref()
  return { refresh, status, poll, async close() {
    stopped = true
    clearInterval(timer)
    for (const feed of feeds.values()) feed.controller.abort()
    feeds.clear()
    await active
  } }
}
