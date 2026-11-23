<script setup lang="ts">
import { computed, onUnmounted, reactive, ref } from 'vue'
import { ElAlert, ElButton, ElInput, ElTable, ElTableColumn, ElTag } from 'element-plus'
import {
  DAY_MS,
  TradeRequestError,
  fetchBinancePortfolioName,
  fetchBinanceTradePage,
  formatTradeTime,
  parsePortfolioId,
  shanghaiDate,
  tradeDirection,
  tradeKey,
  tradeValue,
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
type QueryMode = 'search' | 'monitor' | 'more'

const BINANCE_INTERVAL_MS = 5_000
const now = Date.now()
const defaultPortfolioIds = [
  '5075281354358777856', // 熬鹰资本
  '4751838302089254401', // Btc星辰
]
const today = ref(shanghaiDate(now))
const earliestDate = computed(() => shanghaiDate(dayStart(today.value) - 29 * DAY_MS))
const portfolioInput = ref(defaultPortfolioIds.join('\n'))
const startDate = ref(shanghaiDate(now - 6 * DAY_MS))
const endDate = ref(today.value)
const query = ref<DateRange>()
const portfolios = ref(defaultPortfolioIds.map(createPortfolio))
const portfolioNames = reactive(new Map<string, string>())
const queryNotice = ref('')
const error = ref('')
const monitoring = ref(false)
const searching = ref(false)
const lastDurationMs = ref<number>()
const loadingPortfolio = computed(() => portfolios.value.find(portfolio => portfolio.loading))
const loading = computed(() => searching.value || loadingPortfolio.value != null)
const queryLocked = computed(() => loading.value || monitoring.value)
const queryRunning = computed(() => searching.value || monitoring.value)
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
const emptyText = computed(() => {
  if (!query.value) return '暂无成交记录。'
  if (hasMore.value) return '已加载的记录中暂无可识别的开平仓成交。'
  if (activity.value.successes) return '所选日期暂无公开开平仓成交。'
  return queryRunning.value ? '等待币安返回成交…' : '暂无可显示的查询结果。'
})
let queryController: AbortController | undefined

onUnmounted(stopQueries)

const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 })

function formatNumber(value: number | null) {
  return value != null && Number.isFinite(value) ? numberFormat.format(value) : '—'
}

function portfolioName(id: string) {
  return portfolioNames.get(id) ?? id
}

function detailUrl(id: string) {
  return `https://www.binance.com/zh-CN/copy-trading/lead-details/${id}`
}

function dayStart(date: string) {
  return Date.parse(`${date}T00:00:00+08:00`)
}

function selectedPortfolioIds() {
  const entries = portfolioInput.value.trim().split(/[\s,，]+/)
  const ids = new Set<string>()
  for (const entry of entries) {
    const id = parsePortfolioId(entry)
    if (!id) {
      error.value = '请输入有效的币安带单详情链接或数字组合 ID，每行一个。'
      return
    }
    ids.add(id)
  }
  return [...ids]
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
  if (queryLocked.value) return
  const ids = selectedPortfolioIds()
  if (!ids) return

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

  return runQueries(ids, { startTime, endTime: endDay + DAY_MS - 1 }, 'search')
}

function loadMore() {
  if (query.value && hasMore.value && !queryLocked.value) {
    return runQueries(portfolios.value.map(portfolio => portfolio.id), query.value, 'more')
  }
}

function applyPage(portfolio: PortfolioResult, page: TradePage, cursor?: string) {
  if (cursor && page.cursor === cursor) {
    throw new Error('未返回下一页，请稍后重试或缩小日期范围。')
  }

  if (cursor) {
    // Binance may repeat the last record of the preceding page at the cursor.
    const loaded = new Set(portfolio.records.map(tradeKey))
    portfolio.records.push(...page.list.filter(record => !loaded.has(tradeKey(record))))
  } else if (page.list.length !== portfolio.records.length
    || page.list.some((record, index) => tradeKey(record) !== tradeKey(portfolio.records[index]))) {
    portfolio.records = page.list
  }
  portfolio.cursor = page.list.length && portfolio.records.length < page.total ? page.cursor : undefined
}

async function load(portfolio: PortfolioResult, request: TradeQuery, cursor: string | undefined, signal: AbortSignal) {
  portfolio.loading = true
  portfolio.error = ''
  const started = performance.now()
  try {
    const page = await fetchBinanceTradePage(request, cursor, signal)
    if (signal.aborted || !isCurrentRange(request)) return
    applyPage(portfolio, page, cursor)
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
  searching.value = false
  queryNotice.value = ''
}

function toggleMonitor() {
  if (queryRunning.value) return stopQueries()
  if (loading.value) return
  const ids = selectedPortfolioIds()
  if (ids) return runQueries(ids, recentRange(), 'monitor')
}

function recentRange(): DateRange {
  today.value = shanghaiDate(Date.now())
  const todayStart = dayStart(today.value)
  return { startTime: todayStart - 6 * DAY_MS, endTime: todayStart + DAY_MS - 1 }
}

async function runQueries(ids: string[], range: DateRange, mode: QueryMode) {
  selectQuery(ids, range)
  error.value = ''
  queryNotice.value = ''
  lastDurationMs.value = undefined
  monitoring.value = mode === 'monitor'
  searching.value = mode !== 'monitor'
  const controller = new AbortController()
  queryController = controller
  try {
    await pollPortfolios(ids, range, controller.signal, mode)
  } finally {
    if (queryController === controller) {
      queryController = undefined
      monitoring.value = false
      searching.value = false
    }
  }
}

async function pollPortfolios(ids: string[], initialRange: DateRange, signal: AbortSignal, mode: QueryMode) {
  const repeat = mode === 'monitor'
  const more = mode === 'more'
  let targets = more ? portfolios.value.filter(portfolio => portfolio.cursor) : portfolios.value
  let next = 0
  let firstRound = true
  while (!signal.aborted && targets.length) {
    const range = repeat ? recentRange() : initialRange
    if (!isCurrentRange(range)) {
      selectQuery(ids, range)
      targets = portfolios.value
    }
    const portfolio = targets[next]
    const request = { ...range, portfolioId: portfolio.id }
    queryNotice.value = ''
    const [failure] = await Promise.all([
      load(portfolio, request, more ? portfolio.cursor : undefined, signal),
      firstRound && !more ? loadPortfolioName(portfolio.id, signal) : undefined,
    ])
    if (signal.aborted) return

    next = (next + 1) % targets.length
    if (next === 0) {
      if (!repeat) return
      firstRound = false
    }
    const delay = nextDelay(failure)
    if (delay === undefined) return
    await waitForNextRequest(delay, signal)
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
</script>

<template>
  <main class="page">
    <header class="page-header">
      <h1>币安开平仓记录</h1>
      <p>汇总多个公域带单组合的开平仓成交，按更新时间从新到旧排列。</p>
    </header>

    <form class="panel query" aria-label="交易查询" @submit.prevent="search">
      <div class="field">
        <label for="portfolio">组合 ID 或带单详情链接（每行一个）</label>
        <ElInput
          id="portfolio" v-model="portfolioInput" type="textarea"
          :autosize="{ minRows: 2, maxRows: 5 }" :disabled="queryLocked"
        />
      </div>
      <div class="date-fields">
        <div class="field">
          <label for="start-date">开始日期</label>
          <ElInput
            id="start-date" v-model="startDate" type="date" :min="earliestDate"
            :max="endDate || today" :disabled="queryLocked"
          />
        </div>
        <div class="field">
          <label for="end-date">结束日期</label>
          <ElInput
            id="end-date" v-model="endDate" type="date" :min="startDate || earliestDate"
            :max="today" :disabled="queryLocked"
          />
        </div>
      </div>
      <div class="query-actions">
        <ElButton type="primary" native-type="submit" :loading="!monitoring && loading" :disabled="monitoring">查询</ElButton>
        <ElButton :type="queryRunning ? 'danger' : 'primary'" plain :disabled="!queryRunning && loading" @click="toggleMonitor">
          {{ monitoring ? '停止监控' : searching ? '停止查询' : '开始监控' }}
        </ElButton>
      </div>
    </form>

    <ElAlert v-if="error" class="query-error" :title="error" type="error" :closable="false" show-icon />
    <section class="panel results" aria-label="币安官网成交" :aria-busy="loading">
      <div class="results-header">
        <div>
          <h2>币安官网成交</h2>
          <div v-if="query" class="query-summary">
            <span>{{ shanghaiDate(query.startTime) }} 至 {{ shanghaiDate(query.endTime) }}</span>
            <span v-if="monitoring">轮询 {{ portfolios.length }} 个组合，每次请求后等 {{ BINANCE_INTERVAL_MS / 1000 }} 秒</span>
            <span v-if="activity.successes">已加载 {{ tradeRecords.length }} 条成交</span>
          </div>
          <div v-if="activity.requests || queryNotice" class="query-summary">
            <span v-if="activity.requests">成功 {{ activity.successes }}/{{ activity.requests }}</span>
            <span v-if="lastDurationMs != null">最近请求 {{ lastDurationMs }} ms</span>
            <span v-if="activity.lastSuccessAt">上次成功 {{ formatTradeTime(activity.lastSuccessAt) }}</span>
            <span v-if="queryNotice" role="status">{{ queryNotice }}</span>
          </div>
        </div>
        <span v-if="loadingPortfolio" class="unit">正在查询 {{ portfolioName(loadingPortfolio.id) }}</span>
      </div>

      <div v-if="failedPortfolios.length" class="portfolio-errors">
        <ElAlert
          v-for="portfolio in failedPortfolios" :key="portfolio.id"
          :title="`${portfolioName(portfolio.id)} · ${portfolio.error}`"
          type="warning" :closable="false" show-icon
        />
      </div>
      <ElTable :data="tradeRecords" :empty-text="emptyText" show-overflow-tooltip stripe>
        <ElTableColumn label="更新时间（UTC+8）" width="167">
          <template #default="{ row }">{{ formatTradeTime(row.orderUpdateTime) }}</template>
        </ElTableColumn>
        <ElTableColumn label="带单员" min-width="145">
          <template #default="{ row }">
            <a class="trader-link" :href="detailUrl(row.portfolioId)" target="_blank" rel="noopener noreferrer">{{ row.traderName }}</a>
          </template>
        </ElTableColumn>
        <ElTableColumn prop="symbol" label="交易对" min-width="105" />
        <ElTableColumn label="方向" width="59">
          <template #default="{ row }">
            <ElTag size="small" :type="row.positionSide === 'LONG' ? 'success' : 'danger'">
              {{ row.direction }}
            </ElTag>
          </template>
        </ElTableColumn>
        <ElTableColumn label="成交均价" min-width="108" align="right">
          <template #default="{ row }">
            {{ formatNumber(row.avgPrice) }}<span v-if="row.avgPrice != null && row.quoteAsset" class="unit">{{ row.quoteAsset }}</span>
          </template>
        </ElTableColumn>
        <ElTableColumn label="成交数量" min-width="92" align="right">
          <template #default="{ row }">
            {{ formatNumber(row.executedQty) }}<span v-if="row.baseAsset" class="unit">{{ row.baseAsset }}</span>
          </template>
        </ElTableColumn>
        <ElTableColumn label="总价值" min-width="113" align="right">
          <template #default="{ row }">
            {{ formatNumber(tradeValue(row.avgPrice, row.executedQty, row.quoteQuantity)) }}<span
              v-if="row.quoteAsset && (row.avgPrice != null || row.quoteQuantity != null)"
              class="unit"
            >{{ row.quoteAsset }}</span>
          </template>
        </ElTableColumn>
      </ElTable>

      <div v-if="hasMore && !monitoring" class="results-footer">
        <ElButton :disabled="loading" @click="loadMore">查看更早成交</ElButton>
      </div>
    </section>
  </main>
</template>
