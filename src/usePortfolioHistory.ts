import { computed, ref } from 'vue'
import type { LeadPortfolio } from './portfolios'
import { DAY_MS, fetchObservedTrades, observePortfolios, releaseObservation, shanghaiDate, tradeDirection,
  type ObservedTrade, type ObservationStatus, type TradeQuery } from './trades'

interface PortfolioResult {
  id: string
  records: ObservedTrade[]
  nextPage?: { cursor: string; range: DateRange }
  loading: boolean
  paging: boolean
  loaded: boolean
  error: string
  observation?: ObservationStatus
  refreshedAt: number
}

type DateRange = Pick<TradeQuery, 'startTime' | 'endTime'>
const dayStart = (date: string) => Date.parse(date + 'T00:00:00+08:00')
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : '暂时无法连接本地服务。'

function newViewId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export function usePortfolioHistory(entries: LeadPortfolio[]) {
  const now = ref(Date.now())
  const today = computed(() => shanghaiDate(now.value))
  const startDate = ref(shanghaiDate(now.value - DAY_MS))
  const endDate = ref(today.value)
  const query = ref<DateRange | 'recent'>('recent')
  const portfolios = ref<PortfolioResult[]>(entries.map(({ id }) => ({
    id, records: [], loading: false, paging: false, loaded: false, error: '', refreshedAt: 0,
  })))
  const names = new Map(entries.filter(entry => entry.name).map(entry => [entry.id, entry.name]))
  const portfolioName = (id: string) => names.get(id) ?? id
  const error = ref('')
  const monitoring = ref(false)
  const pinnedAt = ref<number>()
  const pinned = computed(() => pinnedAt.value !== undefined)
  const loading = computed(() => portfolios.value.some(p => p.loading))
  const paging = computed(() => portfolios.value.some(p => p.paging))
  const updatedAtById = computed(() => {
    const updated: Record<string, number> = {}
    for (const portfolio of portfolios.value) {
      const at = portfolio.observation?.lastPositionChangeAt
      if (typeof at === 'number' && at > 0) updated[portfolio.id] = at
    }
    return updated
  })
  const tradeRecords = computed(() => portfolios.value.flatMap(portfolio => portfolio.records.flatMap(record => {
    if (query.value === 'recent' && record.orderUpdateTime < (pinnedAt.value ?? now.value) - DAY_MS) return []
    const direction = tradeDirection(record)
    return direction ? [{ ...record, direction, portfolioId: portfolio.id }] : []
  })).sort((a, b) => b.orderUpdateTime - a.orderUpdateTime))

  let reads = new AbortController()
  let visit: AbortController | undefined
  const activeViewIds = new Set<string>()
  let timer: number | undefined

  async function read(portfolio: PortfolioResult, more = false) {
    const next = more ? portfolio.nextPage : undefined
    if (portfolio.loading || (more && !next)) return
    const signal = reads.signal
    const endTime = Date.now()
    const range = next?.range ?? (query.value === 'recent' ? { startTime: endTime - DAY_MS, endTime } : query.value)
    const sampledAt = portfolio.observation?.lastSuccessAt ?? 0
    portfolio.loading = true
    portfolio.paging = more
    try {
      const page = await fetchObservedTrades({ ...range, portfolioId: portfolio.id }, next?.cursor, signal)
      if (signal.aborted) return
      if (next) {
        const existing = new Set(portfolio.records.map(row => row.observedId))
        portfolio.records.push(...page.list.filter(row => !existing.has(row.observedId)))
      } else {
        portfolio.records = page.list
      }
      portfolio.nextPage = page.cursor ? { cursor: page.cursor, range } : undefined
      portfolio.loaded = true
      portfolio.refreshedAt = sampledAt
      portfolio.error = ''
    } catch (cause) {
      if (!signal.aborted) portfolio.error = errorMessage(cause)
    } finally {
      if (!signal.aborted) {
        portfolio.loading = false
        portfolio.paging = false
      }
    }
  }

  function cancelReads() {
    reads.abort()
    reads = new AbortController()
    for (const portfolio of portfolios.value) {
      portfolio.loading = false
      portfolio.paging = false
    }
  }

  function applyRange(range: DateRange | 'recent') {
    cancelReads()
    query.value = range
    pinnedAt.value = undefined
    for (const portfolio of portfolios.value) {
      portfolio.records = []
      portfolio.nextPage = undefined
      portfolio.loaded = false
      portfolio.error = ''
      portfolio.refreshedAt = 0
      void read(portfolio)
    }
  }

  function showRecent() {
    now.value = Date.now()
    startDate.value = shanghaiDate(now.value - DAY_MS)
    endDate.value = today.value
    error.value = ''
    applyRange('recent')
  }

  function search() {
    now.value = Date.now()
    const startTime = dayStart(startDate.value)
    const endDay = dayStart(endDate.value)
    if (!Number.isFinite(startTime) || !Number.isFinite(endDay) || startTime > endDay || endDate.value > today.value) {
      error.value = '请选择有效的日期范围，结束日期最晚为今天。'
      return
    }
    error.value = ''
    applyRange({ startTime, endTime: endDay + DAY_MS - 1 })
  }

  function loadMore(selected = '') {
    const next = portfolios.value.filter(p => p.nextPage && (!selected || p.id === selected))
    if (loading.value || !next.length) return
    // Stay on this SQLite snapshot while the user pages through it.
    pinnedAt.value ??= now.value
    for (const portfolio of next) void read(portfolio, true)
  }

  function updateClock() {
    const previous = now.value
    const previousDay = today.value
    now.value = Date.now()
    if (today.value !== previousDay && query.value === 'recent' && !pinned.value &&
      endDate.value === previousDay && startDate.value === shanghaiDate(previous - DAY_MS)) {
      startDate.value = shanghaiDate(now.value - DAY_MS)
      endDate.value = today.value
    }
  }

  function start() {
    if (visit || !entries.length) return
    const controller = new AbortController()
    visit = controller
    const groups: { id: string; items: PortfolioResult[] }[] = []
    for (let i = 0; i < portfolios.value.length; i += 100) {
      groups.push({ id: newViewId(), items: portfolios.value.slice(i, i + 100) })
    }
    monitoring.value = true
    updateClock()
    if (!pinned.value) for (const portfolio of portfolios.value) void read(portfolio)

    async function heartbeat() {
      if (controller.signal.aborted) return
      updateClock()
      await Promise.all(groups.map(async group => {
        try {
          activeViewIds.add(group.id)
          const statuses = await observePortfolios(group.id, group.items.map(p => p.id), controller.signal)
          if (controller.signal.aborted) return
          const byId = new Map(statuses.map(status => [status.portfolioId, status]))
          for (const portfolio of group.items) {
            const status = byId.get(portfolio.id)
            if (!status) throw Error('服务未能确认组合的监控状态。')
            portfolio.observation = status
            if (!pinned.value && status.lastSuccessAt && status.lastSuccessAt !== portfolio.refreshedAt &&
              (query.value === 'recent' || query.value.endTime >= status.startedAt - DAY_MS)) void read(portfolio)
          }
        } catch (cause) {
          if (controller.signal.aborted) return
          releaseObservation(group.id)
          activeViewIds.delete(group.id)
          group.id = newViewId()
          for (const portfolio of group.items) {
            portfolio.observation = { portfolioId: portfolio.id, startedAt: portfolio.observation?.startedAt ?? 0,
              lastSuccessAt: portfolio.observation?.lastSuccessAt ?? null,
              lastPositionChangeAt: portfolio.observation?.lastPositionChangeAt, error: errorMessage(cause) }
          }
        }
      }))
      if (!controller.signal.aborted) timer = window.setTimeout(heartbeat, 8_000)
    }
    void heartbeat()
  }

  function stop() {
    visit?.abort()
    visit = undefined
    window.clearTimeout(timer)
    cancelReads()
    for (const id of activeViewIds) releaseObservation(id)
    activeViewIds.clear()
    monitoring.value = false
    for (const portfolio of portfolios.value) portfolio.observation = undefined
  }

  return { startDate, endDate, today, query, portfolios, error, monitoring, paging, loading,
    pinned, tradeRecords, updatedAtById, search, showRecent, loadMore, start, stop, portfolioName }
}
