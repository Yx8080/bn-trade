<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Coin,
  EditPen,
  FolderOpened,
  Link,
  List,
  Search,
  Timer,
} from '@element-plus/icons-vue'
import { usePortfolioHistory } from '../usePortfolioHistory'
import { detailUrl, formatNumber, formatTradeTime, shanghaiDate, tradeValue } from '../trades'
import { reportedPnl, summarizeReportedPnl } from '../pnl'
import type { LeadPortfolio } from '../portfolios'
import ClosedPositions from './ClosedPositions.vue'

const props = defineProps<{ entries: LeadPortfolio[]; visible: boolean }>()
const emit = defineEmits<{ edit: []; quote: [symbol: string] }>()
const {
  startDate,
  endDate,
  today,
  earliestDate,
  query,
  portfolios,
  queryNotice,
  error,
  monitoring,
  paging,
  lastDurationMs,
  loadingPortfolio,
  loading,
  hasMore,
  failedPortfolios,
  activity,
  tradeRecords,
  search,
  loadMore,
  portfolioName: name,
} = usePortfolioHistory(props.entries)
if (props.entries.length) search()
const opened = ref(false)
watch(
  () => props.visible,
  (visible) => {
    if (!visible || opened.value) return
    opened.value = true
  },
  { immediate: true },
)
const selected = ref('')
const rows = computed(() => {
  const filtered = selected.value
    ? tradeRecords.value.filter((row) => row.portfolioId === selected.value)
    : tradeRecords.value
  return filtered.map((row) => ({ ...row, pnl: reportedPnl(row) }))
})
const summaries = computed(() => summarizeReportedPnl(rows.value))
const closed = computed(() =>
  rows.value.filter((row) => row.direction === '平多' || row.direction === '平空'),
)
const reported = computed(() => closed.value.filter((row) => row.pnl != null).length)
const visiblePortfolios = computed(() => selected.value
  ? portfolios.value.filter(portfolio => portfolio.id === selected.value)
  : portfolios.value)
const loaded = computed(() => visiblePortfolios.value.some(portfolio => portfolio.successes))
const failures = computed(() => visiblePortfolios.value.filter(portfolio => portfolio.error))
const emptyState = computed(() => {
  if (!query.value) return { title: '尚未查询成交记录', detail: '添加带单组合后，将自动获取公开成交。' }
  if (failures.value.length) {
    if (loaded.value) return { title: '已加载的数据中暂无匹配成交', detail: '部分数据未能更新，请查看上方的组合状态。' }
    return {
      title: '尚未取得成交数据',
      detail: monitoring.value ? '监控会自动重试。' : '可点击「查询」重试。',
    }
  }
  if (visiblePortfolios.value.some(portfolio => !portfolio.successes)) {
    return monitoring.value
      ? { title: '正在获取成交记录', detail: '等待所选组合返回数据。' }
      : { title: '成交查询未完成', detail: '点击「查询」可重新获取所选时段的成交。' }
  }
  return { title: '暂无匹配的成交记录', detail: visiblePortfolios.value.some(portfolio => portfolio.cursor)
    ? '已加载的记录中暂无可识别的开平仓成交。'
    : '所选日期暂无公开开平仓成交。' }
})
function signed(value: number) {
  return (value > 0 ? '+' : '') + formatNumber(value)
}
function pnlColor(value: number | null) {
  return value == null || value === 0 ? '' : value > 0 ? 'gain' : 'loss'
}
</script>

<template>
  <header class="page-heading">
    <div>
      <h1>带单监控</h1>
      <p>查看组合成交记录，追踪已披露的平仓盈亏。</p>
    </div>
    <button class="btn" @click="emit('edit')">
      <EditPen />
      管理组合
    </button>
  </header>
  <div class="overview-grid">
    <section class="profit-card" aria-label="已披露平仓盈亏">
      <div class="profit-title">
        <Coin />
        <h2>已披露平仓盈亏</h2>
      </div>
      <div class="profit-values">
        <div
          v-for="item in summaries"
          :key="item.asset"
          class="profit-value"
          :class="pnlColor(item.pnl)"
        >
          {{ signed(item.pnl) }}
          <small>{{ item.asset }}</small>
        </div>
        <div v-if="!summaries.length" class="profit-value empty-amount">—</div>
      </div>
      <div class="profit-caption">
        <span class="legend-dot"></span>
        {{
          loaded
            ? `已加载平仓成交 ${closed.length} 笔 · 已披露 ${reported} 笔`
            : '查询成交后，按结算币种汇总'
        }}
      </div>
    </section>
    <section class="panel watchlist-card">
      <div class="section-title">
        <div class="title-icon"><List /></div>
        <h2>跟踪组合</h2>
        <span class="count">{{ entries.length }}</span>
      </div>
      <div class="watchlist">
        <a
          v-for="(item, i) in entries"
          :key="item.id"
          class="lead-chip"
          :href="detailUrl(item.id)"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span class="avatar" :class="'tone-' + (i % 4)">
            {{ (name(item.id) === item.id ? '#' : name(item.id)).slice(0, 1) }}
          </span>
          <span class="lead-text">
            <strong>{{ name(item.id) }}</strong>
            <small v-if="name(item.id) !== item.id">{{ item.id }}</small>
          </span>
          <Link class="external-icon" />
        </a>
        <button v-if="!entries.length" class="btn" @click="emit('edit')">添加第一个带单组合</button>
      </div>
    </section>
  </div>

  <section class="panel ledger-card" aria-label="成交明细" :aria-busy="loading">
    <div class="ledger-heading">
      <div class="section-title">
        <div class="title-icon"><FolderOpened /></div>
        <h2>成交明细</h2>
      </div>
      <span class="status" :class="{ active: monitoring && !failedPortfolios.length }">
        <i></i>
        {{ monitoring && failedPortfolios.length ? '监控中 · 查询异常' : monitoring ? '监控中' : entries.length ? '监控已暂停' : '等待添加组合' }}
      </span>
    </div>
    <form class="filters" @submit.prevent="search">
      <label class="field">
        <span>开始日期</span>
        <input
          v-model="startDate"
          type="date"
          :min="earliestDate"
          :max="endDate || today"
          required
        />
      </label>
      <label class="field">
        <span>结束日期</span>
        <input
          v-model="endDate"
          type="date"
          :min="startDate || earliestDate"
          :max="today"
          required
        />
      </label>
      <label class="field">
        <span>带单组合</span>
        <select v-model="selected">
          <option value="">全部组合</option>
          <option v-for="item in entries" :key="item.id" :value="item.id">
            {{ name(item.id) }}
          </option>
        </select>
      </label>
      <div class="filter-actions">
        <button type="submit" class="btn primary" :disabled="!entries.length">
          <Search />
          查询
        </button>
      </div>
    </form>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-for="item in failures" :key="item.id" class="notice warning" role="status">
      {{ name(item.id) }} · {{ item.error }}
      <span v-if="item.lastSuccessAt">最近成功更新于 {{ formatTradeTime(item.lastSuccessAt) }}。</span>
    </p>
    <p v-if="queryNotice" class="notice warning" role="status">{{ queryNotice }}</p>
    <div class="table-scroll">
      <table class="trades-table">
        <thead>
          <tr>
            <th>交易对</th>
            <th>方向</th>
            <th class="numeric" title="开仓记录与未披露盈亏的平仓记录显示为 —">平仓盈亏</th>
            <th>带单员</th>
            <th class="numeric">成交均价</th>
            <th class="numeric">成交数量</th>
            <th class="numeric">总价值</th>
            <th>更新时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in rows" :key="index">
            <td>
              <button
                v-if="typeof row.symbol === 'string' && row.symbol.endsWith('USDT')"
                class="text-button"
                :aria-label="'查看 ' + row.symbol + ' 合约行情'"
                @click="emit('quote', row.symbol)"
              >
                {{ row.symbol }}
              </button>
              <strong v-else>{{ row.symbol }}</strong>
            </td>
            <td>
              <span class="direction" :class="row.positionSide === 'LONG' ? 'long' : 'short'">
                {{ row.direction }}
              </span>
            </td>
            <td class="numeric pnl-cell" :class="pnlColor(row.pnl)">
              {{ row.pnl == null ? '—' : signed(row.pnl) }}
              <small v-if="row.pnl != null">{{ row.quoteAsset }}</small>
            </td>
            <td>
              <a
                class="trader-link"
                :href="detailUrl(row.portfolioId)"
                target="_blank"
                rel="noopener noreferrer"
              >
                {{ name(row.portfolioId) }}
              </a>
            </td>
            <td class="numeric">
              {{ formatNumber(row.avgPrice) }}
              <small>{{ row.quoteAsset }}</small>
            </td>
            <td class="numeric">
              {{ formatNumber(row.executedQty) }}
              <small>{{ row.baseAsset }}</small>
            </td>
            <td class="numeric">
              {{ formatNumber(tradeValue(row.avgPrice, row.executedQty, row.quoteQuantity)) }}
              <small>{{ row.quoteAsset }}</small>
            </td>
            <td class="time-cell">{{ formatTradeTime(row.orderUpdateTime) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="!rows.length" class="empty-state">
      <span class="empty-icon"><List /></span>
      <strong>{{ emptyState.title }}</strong>
      <p>{{ emptyState.detail }}</p>
    </div>
    <div class="ledger-footer">
      <span>
        <Timer />
        北京时间 UTC+8
      </span>
      <span v-if="loadingPortfolio">正在查询 {{ name(loadingPortfolio.id) }}</span>
      <span
        v-else-if="activity.requests"
        :title="activity.lastSuccessAt ? '最近成功 ' + formatTradeTime(activity.lastSuccessAt) : ''"
      >
        成功 {{ activity.successes }}/{{ activity.requests }}<template v-if="lastDurationMs != null"> · {{ lastDurationMs }} ms</template>
      </span>
      <span v-if="query">
        {{ shanghaiDate(query.startTime) }} 至 {{ shanghaiDate(query.endTime) }}
        <template v-if="loaded"> · 已加载 {{ rows.length }} 笔</template>
      </span>
      <button
        v-if="hasMore && monitoring"
        class="text-button"
        :disabled="paging"
        @click="loadMore"
      >
        {{ paging ? '正在加载更早成交…' : '加载更早成交' }}
      </button>
    </div>
  </section>
  <p v-if="monitoring" class="footnote">
    按顺序轮询 {{ portfolios.length }} 个组合，两次请求间隔至少 5 秒。
  </p>
  <div v-if="opened" class="position-history">
    <ClosedPositions :entries="entries" @quote="emit('quote', $event)" />
  </div>
</template>
