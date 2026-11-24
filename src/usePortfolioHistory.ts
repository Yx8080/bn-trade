import { computed, onUnmounted, reactive, ref } from 'vue'
import type { LeadPortfolio } from './portfolios'
import {
  DAY_MS,
  TradeRequestError,
  fetchBinancePortfolioName,
  fetchBinanceTradePage,
  shanghaiDate,
  tradeDirection,
  tradeKey,
  type Trade,
  type TradePage,
  type TradeQuery,
} from './trades'

interface PortfolioResult {
  id: string
  records: Trade[]
  cursor?: string
  loading: boolean
  error: string
  lastSuccessAt?: number
  requests: number
  successes: number
}

type DateRange = Pick<TradeQuery, 'startTime' | 'endTime'>

export const BINANCE_INTERVAL_MS = 5_000

export function usePortfolioHistory(entries: LeadPortfolio[]) {
  const initialIds = entries.map(entry => entry.id)
  const now = Date.now()
  const today = ref(shanghaiDate(now))
  const earliestDate = computed(() => shanghaiDate(dayStart(today.value) - 29 * DAY_MS))
  const startDate = ref(shanghaiDate(now - 6 * DAY_MS))
  const endDate = ref(today.value)
  const query = ref<DateRange>()
  const portfolios = ref(initialIds.map(createPortfolio))
  const portfolioNames = reactive(new Map(entries.filter(entry => entry.name).map(entry => [entry.id, entry.name])))
  const queryNotice = ref('')
  const error = ref('')
  const monitoring = ref(false)
  const lastDurationMs = ref<number>()
  const loadingPortfolio = computed(() => portfolios.value.find(portfolio => portfolio.loading))
  const loading = computed(() => loadingPortfolio.value != null)
  const paging = ref(false)
  const hasMore = computed(() => portfolios.value.some(portfolio => portfolio.cursor))
  const failedPortfolios = computed(() => portfolios.value.filter(portfolio => portfolio.error))
  const activity = computed(() => {
    const stats = { requests: 0, successes: 0, lastSuccessAt: 0 }
    for (const portfolio of portfolios.value) {
      stats.requests += portfolio.requests
      stats.successes += portfolio.successes
      stats.lastSuccessAt = Math.max(stats.lastSuccessAt, portfolio.lastSuccessAt ?? 0)
    }
    return stats
  })
  const tradeRecords = computed(() => portfolios.value.flatMap(portfolio => {
    const traderName = portfolioName(portfolio.id)
    return portfolio.records.flatMap(record => {
      const direction = tradeDirection(record)
      return direction ? [{ ...record, direction, portfolioId: portfolio.id, traderName }] : []
    })
  }).sort((first, second) => second.orderUpdateTime - first.orderUpdateTime))
  let queryController: AbortController | undefined
  let revision = 0
  let rolling = true
  let earlier: string[] = []

  onUnmounted(stopQueries)

  function portfolioName(id: string) {
    return portfolioNames.get(id) ?? id
  }

  function dayStart(date: string) {
    return Date.parse(`${date}T00:00:00+08:00`)
  }

  function createPortfolio(id: string): PortfolioResult {
    return { id, records: [], loading: false, error: '', requests: 0, successes: 0 }
  }

  function errorMessage(cause: unknown) {
    if (cause instanceof DOMException && cause.name === 'TimeoutError') return '查询超时。'
    if (cause instanceof TypeError) return '连接查询接口失败。'
    return cause instanceof Error ? cause.message : '查询失败。'
  }

  function isCurrentRange(range: DateRange) {
    return query.value?.startTime === range.startTime && query.value.endTime === range.endTime
  }

  function selectQuery(ids: string[], range: DateRange) {
    const previous = new Map(isCurrentRange(range) ? portfolios.value.map(portfolio => [portfolio.id, portfolio]) : [])
    portfolios.value = ids.map(id => previous.get(id) ?? createPortfolio(id))
    query.value = range
  }

  function search() {
    if (!initialIds.length) return

    today.value = shanghaiDate(Date.now())
    const startTime = dayStart(startDate.value)
    const endDay = dayStart(endDate.value)
    if (!Number.isFinite(startTime) || !Number.isFinite(endDay) || startTime > endDay) {
      error.value = '请选择有效的开始和结束日期。'
      return
    }
    if (startDate.value < earliestDate.value || endDate.value > today.value) {
      error.value = '请选择币安官网开放的最近 30 天。'
      return
    }

    error.value = ''
    rolling = endDate.value === today.value && startTime === endDay - 6 * DAY_MS
    selectQuery(initialIds, { startTime, endTime: endDay + DAY_MS - 1 })
    earlier = []
    paging.value = false
    revision++
    if (!monitoring.value) void monitor()
  }

  function loadMore() {
    if (!monitoring.value || paging.value) return
    earlier = portfolios.value.filter(p => p.cursor).map(p => p.id)
    paging.value = earlier.length > 0
  }

  function applyPage(portfolio: PortfolioResult, page: TradePage, cursor?: string) {
    if (cursor && page.cursor === cursor) {
      throw new Error('未返回下一页，请稍后重试或缩小日期范围。')
    }

    if (cursor) {
      // Binance may repeat the last record of the preceding page at the cursor.
      const loaded = new Set(portfolio.records.map(tradeKey))
      portfolio.records.push(...page.list.filter(record => !loaded.has(tradeKey(record))))
    } else {
      // Preserve loaded older pages when the newest page still overlaps them.
      const last = page.list.at(-1)
      const overlap = last ? portfolio.records.findIndex(row => tradeKey(row) === tradeKey(last)) : -1
      if (overlap >= 0 && overlap < portfolio.records.length - 1 && page.cursor && page.list.length < page.total) {
        const keys = new Set(page.list.map(tradeKey))
        portfolio.records = [...page.list, ...portfolio.records.slice(overlap + 1).filter(row => !keys.has(tradeKey(row)))]
        return
      }
      portfolio.records = page.list
    }
    portfolio.cursor = page.list.length && portfolio.records.length < page.total ? page.cursor : undefined
  }

  async function load(portfolio: PortfolioResult, request: TradeQuery, cursor: string | undefined, signal: AbortSignal) {
    portfolio.loading = true
    const started = performance.now()
    try {
      const page = await fetchBinanceTradePage(request, cursor, signal)
      if (signal.aborted || !isCurrentRange(request)) return
      applyPage(portfolio, page, cursor)
      portfolio.error = ''
      portfolio.successes++
      portfolio.lastSuccessAt = Date.now()
    } catch (cause) {
      if (signal.aborted || !isCurrentRange(request)) return
      portfolio.error = errorMessage(cause)
      return cause
    } finally {
      if (!signal.aborted) {
        portfolio.loading = false
        if (isCurrentRange(request)) {
          portfolio.requests++
          lastDurationMs.value = Math.round(performance.now() - started)
        }
      }
    }
  }

  async function loadPortfolioName(id: string, signal: AbortSignal) {
    if (portfolioNames.has(id)) return
    try {
      const name = await fetchBinancePortfolioName(id, signal)
      if (name && !signal.aborted) portfolioNames.set(id, name)
    } catch {
      // The portfolio ID identifies the trader when their nickname is unavailable.
    }
  }

  function stopQueries() {
    queryController?.abort()
    queryController = undefined
    for (const portfolio of portfolios.value) portfolio.loading = false
    monitoring.value = false
    paging.value = false
  }

  async function monitor() {
    if (monitoring.value || !initialIds.length || !query.value) return
    const controller = new AbortController()
    queryController = controller
    monitoring.value = true
    let sequence = revision
    let next = 0
    let outageDelay = BINANCE_INTERVAL_MS
    try {
      while (!controller.signal.aborted) {
        const day = shanghaiDate(Date.now())
        if (rolling && day !== today.value) {
          const start = dayStart(day) - 6 * DAY_MS
          if (endDate.value === today.value && startDate.value === shanghaiDate(query.value.startTime)) {
            startDate.value = shanghaiDate(start)
            endDate.value = day
          }
          selectQuery(initialIds, { startTime: start, endTime: dayStart(day) + DAY_MS - 1 })
          revision++
          earlier = []
          paging.value = false
        }
        today.value = day
        if (sequence !== revision) { sequence = revision; next = 0; outageDelay = BINANCE_INTERVAL_MS }
        const extra = earlier.shift()
        const portfolio = extra ? portfolios.value.find(item => item.id === extra)! : portfolios.value[next]
        const request = { ...query.value, portfolioId: portfolio.id }
        queryNotice.value = ''
        const [failure] = await Promise.all([
          load(portfolio, request, extra ? portfolio.cursor : undefined, controller.signal),
          portfolio.requests === 0 ? loadPortfolioName(portfolio.id, controller.signal) : undefined,
        ])
        if (controller.signal.aborted) return
        paging.value = earlier.length > 0
        let delay = nextDelay(failure)
        if (delay === undefined) return
        if (!extra && sequence === revision) {
          next = (next + 1) % portfolios.value.length
          if (!next && portfolios.value.every(item => item.error)) {
            outageDelay = Math.min(outageDelay * 2, 60_000)
            delay = Math.max(delay, outageDelay)
            queryNotice.value = `本轮全部组合查询失败，将在 ${Math.ceil(delay / 1000)} 秒后重试。`
          } else if (!next) outageDelay = BINANCE_INTERVAL_MS
        }
        await waitForNextRequest(delay, controller.signal)
      }
    } finally {
      if (queryController === controller) {
        monitoring.value = false
        paging.value = false
        queryController = undefined
      }
    }
  }

  function nextDelay(failure: unknown) {
    let delay = BINANCE_INTERVAL_MS

    if (failure instanceof TradeRequestError) {
      if ([401, 403, 418, 451].includes(failure.status)) {
        queryNotice.value = '币安拒绝访问，已暂停查询。'
        return
      }
      if (failure.status === 429 && !failure.retryAfterMs) {
        queryNotice.value = '已达币安请求限额，已暂停查询。'
        return
      }
      delay = Math.max(delay, failure.retryAfterMs)
    }
    if (delay > 2_147_483_647) {
      queryNotice.value = '服务端要求延后查询，已暂停查询。'
      return
    }
    if (delay > BINANCE_INTERVAL_MS) queryNotice.value = `按服务端要求等待 ${Math.ceil(delay / 1000)} 秒后继续查询。`
    return delay
  }

  function waitForNextRequest(delay: number, signal: AbortSignal) {
    return new Promise<void>(resolve => {
      const done = () => {
        window.clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = window.setTimeout(done, delay)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  return {
    startDate, endDate, today, earliestDate, query, portfolios, portfolioNames, queryNotice,
    error, monitoring, paging, lastDurationMs, loadingPortfolio, loading,
    hasMore, failedPortfolios, activity, tradeRecords, search, loadMore,
    stopQueries, portfolioName,
  }
}
