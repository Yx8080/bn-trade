import { randomUUID } from 'node:crypto'
import worker from '../worker/index.js'
import { ApiError } from '../worker/trading.js'
import { copySignalHistory, copySignalOverlap, normalizeCopySignal } from './copy-signals.js'

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

export function createPortfolioMonitor({ fetchBinance, getStore, getPortfolioIds, getCopyPortfolios = () => [],
  getCopySignals, getSamplerStore, onCopyUpdate, now = Date.now }) {
  const feeds = new Map()
  const owner = randomUUID()
  let leaseUntil = 0
  let stopped = false
  let nextAt = 0
  let preferCopy = true
  let active

  function refresh(at = now()) {
    if (stopped) return
    const copies = new Map(getCopyPortfolios().map(({ id, since }) => [id, since]))
    const ids = new Set([...getPortfolioIds(), ...copies.keys()])
    for (const [id, feed] of feeds) {
      if (ids.has(id)) continue
      feeds.delete(id)
      feed.controller.abort()
      if (leaseUntil > at) getSamplerStore?.().remove(id)
    }
    for (const id of ids) {
      const feed = feeds.get(id)
      const since = copies.get(id)
      if (feed) {
        feed.endTime = Math.max(feed.endTime, at)
        feed.copySince = since
      }
      else {
        feeds.set(id, { id, controller: new AbortController(), startedAt: at, endTime: at,
          sampledThrough: -1, history: undefined, lastSuccessAt: null, lastPositionChangeAt: null, error: '',
          failures: 0, retryAt: 0, copySince: since })
      }
    }
  }

  function feedStatus(feed) {
    return { portfolioId: feed.id, startedAt: feed.startedAt, lastSuccessAt: feed.lastSuccessAt,
      syncing: feed.sampledThrough < 0, lastPositionChangeAt: feed.lastPositionChangeAt, error: feed.error }
  }

  function status(ids) {
    refresh()
    return [...new Set(ids)].flatMap(id => {
      const feed = feeds.get(id)
      if (!feed) return []
      return [getSamplerStore?.().status(id) ?? feedStatus(feed)]
    })
  }

  function current(feed) {
    return !stopped && (!getSamplerStore || leaseUntil > now()) && feeds.get(feed.id) === feed
  }

  function newQuery(feed, copy) {
    const target = feed.endTime
    // Keep an overlap for delayed disclosures. Older copy positions can need
    // successive windows when the service has been offline for more than a day.
    let startTime = Math.max(0, target - historyWindow, Math.min(feed.sampledThrough, target - recentOverlap))
    if (copy && feed.copySince != null) {
      const needed = Math.max(0, target - copySignalHistory, feed.copySince - copySignalOverlap)
      const saved = getCopySignals().status(feed.id)
      if (needed < startTime) {
        startTime = saved?.start != null && saved.start <= needed && saved.end >= needed
          ? Math.min(startTime, Math.max(needed, saved.end - copySignalOverlap)) : needed
      }
    }
    return { startTime, endTime: Math.min(target, startTime + (copy ? feed.querySpan ?? historyWindow : historyWindow)),
      archiveSince: target - historyWindow, cursors: new Set(),
      rows: copy ? new Map() : undefined }
  }

  function completeCopyPage(query, list, total, hasCursor) {
    if (!Number.isSafeInteger(total) || total < 0 || (query.total != null && total !== query.total)) return false
    query.total = total
    const previousCount = query.rows.size
    for (const row of list) {
      const key = JSON.stringify([row?.orderId, row?.symbol, row?.positionSide, row?.side, row?.type, row?.status,
        row?.orderTime, row?.orderUpdateTime, row?.executedQty, row?.avgPrice, row?.totalPnl, row?.positionId])
      if (!query.rows.has(key)) query.rows.set(key, row)
    }
    return query.rows.size === total || (hasCursor && query.rows.size < total && query.rows.size > previousCount)
  }

  async function sample(feed) {
    const copy = feed.copySince !== undefined
    if (!feed.history?.indexValue || Boolean(feed.history.rows) !== copy
      || (!copy && feed.history.endTime <= feed.endTime - historyWindow)) feed.history = newQuery(feed, copy)
    const query = feed.history
    const { startTime, endTime } = query
    const { list, total, indexValue } = await historyPage(fetchBinance, feed.id, query, feed.controller.signal)
    if (!current(feed)) return
    // Binance can return the last row's cursor even when it has no next page.
    const hasCursor = list.length > 0 && typeof indexValue === 'string' && indexValue !== '' && indexValue !== '-1'
    const firstPageComplete = !query.indexValue && Number.isSafeInteger(total) && total <= list.length
    const validCopyPage = !copy || completeCopyPage(query, list, total, hasCursor)
    const hasMore = copy ? query.rows.size < total && hasCursor : !firstPageComplete && hasCursor
    const visible = list.filter(row => {
      const raw = row?.orderUpdateTime
      const time = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
      return Number.isSafeInteger(time) && time >= Math.max(startTime, query.archiveSince) && time <= endTime
    })
    if (visible.length) {
      const changed = getStore().record(feed.id, { startTime, endTime, rows: visible })
      // An older entry can complete a position whose close was already saved.
      if (changed.length) feed.lastPositionChangeAt = now()
    }
    if (!validCopyPage || (hasMore && query.cursors.has(indexValue))) {
      feed.history = undefined
      if (copy) feed.querySpan = Math.max(recentOverlap, Math.floor((endTime - startTime) / 2))
      throw new ApiError(502, 'MONITOR_UPSTREAM_CURSOR', '币安返回的成交分页不完整，将重新同步。')
    }
    if (hasMore) {
      query.cursors.add(indexValue)
      query.indexValue = indexValue
    } else {
      if (copy) {
        const signals = new Map()
        try {
          for (const row of query.rows.values()) {
            const signal = normalizeCopySignal(feed.id, row)
            if (signal && signal.time >= startTime && signal.time <= endTime && !signals.has(signal.id)) signals.set(signal.id, signal)
          }
        } catch (error) {
          feed.history = undefined
          throw error
        }
        if (getCopySignals().publish(feed.id, startTime, endTime, signals.values(), now())) onCopyUpdate?.(feed.id)
      }
      feed.sampledThrough = endTime
      if (endTime >= feed.endTime - recentOverlap) delete feed.querySpan
      feed.history = undefined
    }
    feed.lastSuccessAt = now()
    feed.error = ''
    feed.failures = 0
  }

  async function run() {
    const at = now()
    if (stopped) return
    const samplerStore = getSamplerStore?.()
    if (samplerStore && leaseUntil - at <= 15_000) {
      const lease = samplerStore.claim(owner, at, at + 30_000)
      if (!lease) { leaseUntil = 0; return }
      leaseUntil = at + 30_000
      nextAt = Math.max(nextAt, lease.nextAt)
    }
    if (at < nextAt) return
    refresh(at)
    let feed
    for (const candidate of feeds.values()) {
      if (at < candidate.retryAt || (!candidate.history && candidate.endTime <= candidate.sampledThrough)) continue
      feed ??= candidate
      if ((candidate.copySince !== undefined) === preferCopy) { feed = candidate; break }
    }
    if (!feed) return
    const { id } = feed
    // Give active strategies regular slots while keeping watchlist-only feeds moving.
    preferCopy = feed.copySince === undefined
    feeds.delete(id)
    feeds.set(id, feed)
    try {
      await sample(feed)
    } catch (error) {
      if (current(feed)) {
        feed.error = error instanceof ApiError ? error.message : '监控采样暂时失败，请稍后查看。'
        if (feed.copySince !== undefined) {
          const signals = getCopySignals()
          if (signals.status(id)?.error !== feed.error) {
            signals.fail(id, feed.error)
          }
        }
        const delay = backoff(error, now(), ++feed.failures)
        feed.retryAt = now() + delay
        if ([401, 403, 418, 429, 451].includes(error.status) || error.offline || error.retryAfter || error.headers?.['Retry-After']) {
          nextAt = Math.max(nextAt, feed.retryAt)
        }
      }
    } finally {
      nextAt = Math.max(nextAt, now() + interval)
      samplerStore?.schedule(owner, nextAt)
      if (current(feed)) samplerStore?.save(feedStatus(feed))
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
    if (leaseUntil) {
      leaseUntil = 0
      getSamplerStore().release(owner)
    }
  } }
}
