<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
import { detailUrl, formatNumber, formatTradeAmount, formatTradeTime, shanghaiDate, tradeValue } from '../trades'
import { reportedPnl, summarizeReportedPnl } from '../pnl'
import type { LeadPortfolio } from '../portfolios'
import ClosedPositions from './ClosedPositions.vue'

const props = defineProps<{ entries: LeadPortfolio[]; visible: boolean }>()
const emit = defineEmits<{ edit: []; quote: [symbol: string] }>()
const {
  startDate,
  endDate,
  today,
  query,
  portfolios,
  error,
  monitoring,
  paging,
  loading,
  pinned,
  tradeRecords,
  updatedAtById,
  search,
  showRecent,
  loadMore,
  start,
  stop,
  portfolioName: name,
} = usePortfolioHistory(props.entries)
const opened = ref(false)
watch(
  () => props.visible,
  (visible) => {
    if (!visible || opened.value) return
    opened.value = true
  },
  { immediate: true },
)
let away = false
function syncVisibility() {
  if (props.visible && !document.hidden && !away) start()
  else stop()
}
function leave() { away = true; stop() }
function returnToPage() { away = false; syncVisibility() }
watch(() => props.visible, syncVisibility, { flush: 'sync' })
onMounted(() => {
  document.addEventListener('visibilitychange', syncVisibility)
  window.addEventListener('pagehide', leave)
  window.addEventListener('pageshow', returnToPage)
  syncVisibility()
})
onUnmounted(() => {
  document.removeEventListener('visibilitychange', syncVisibility)
  window.removeEventListener('pagehide', leave)
  window.removeEventListener('pageshow', returnToPage)
  stop()
})
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
const loaded = computed(() => visiblePortfolios.value.some(portfolio => portfolio.loaded))
const failures = computed(() => visiblePortfolios.value.filter(portfolio => portfolio.error))
const hasMore = computed(() => visiblePortfolios.value.some(portfolio => portfolio.nextPage))
const observationFailures = computed(() => visiblePortfolios.value.filter(portfolio => portfolio.observation?.error))
const syncing = computed(() => monitoring.value && visiblePortfolios.value.some(portfolio =>
  !portfolio.observation || portfolio.observation.syncing))
const lastObserved = computed(() => Math.max(0, ...visiblePortfolios.value.map(p => p.observation?.lastSuccessAt ?? 0)))
const emptyState = computed(() => {
  if (!props.entries.length) return { title: '尚未添加带单组合', detail: '添加组合后，打开本页即可开始监控。' }
  if (failures.value.length) return { title: '本地成交记录读取未完成', detail: '点击「最近 24 小时」或「查询」重新读取本地记录。' }
  if (!loaded.value && loading.value) return { title: '正在读取本地成交记录', detail: '' }
  if (hasMore.value) return { title: '当前结果没有可识别的开平仓成交', detail: '可继续加载更早的本地记录。' }
  if (query.value === 'recent' && observationFailures.value.length) {
    return { title: '最近 24 小时的成交暂未同步完成', detail: '币安查询会自动重试。' }
  }
  if (query.value === 'recent' && syncing.value) return { title: '正在同步币安最近 24 小时的公开成交', detail: '' }
  return { title: '所选时段暂无已记录的成交', detail: '本地历史只覆盖工作台实际监控到的公开成交。' }
})
function signed(value: number) {
  return (value > 0 ? '+' : '') + formatTradeAmount(value)
}
function pnlColor(value: number | null) {
  return value == null || value === 0 ? '' : value > 0 ? 'gain' : 'loss'
}
</script>

<template>
  <header class="page-heading">
    <div>
      <h1>带单监控</h1>
      <p>查看币安实盘带单员的公开成交与平仓盈亏。</p>
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
      <span class="status" :class="{ active: monitoring && !observationFailures.length }">
        <i></i>
        {{ monitoring && observationFailures.length ? '同步异常' : syncing ? '同步中' : monitoring ? '监控中' : entries.length ? '监控已暂停' : '等待添加组合' }}
      </span>
    </div>
    <form class="filters" @submit.prevent="search">
      <label class="field">
        <span>开始日期</span>
        <input
          v-model="startDate"
          type="date"
          :max="endDate || today"
          required
        />
      </label>
      <label class="field">
        <span>结束日期</span>
        <input
          v-model="endDate"
          type="date"
          :min="startDate || undefined"
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
        <button type="button" class="btn" :disabled="!entries.length" @click="showRecent">
          最近 24 小时
        </button>
        <button type="submit" class="btn primary" :disabled="!entries.length">
          <Search />
          查询
        </button>
      </div>
    </form>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-for="item in failures" :key="item.id" class="notice warning" role="status">
      {{ name(item.id) }} · 本地记录读取失败。{{ item.error }}
    </p>
    <p v-for="item in observationFailures" :key="'observation:' + item.id" class="notice warning" role="status">
      {{ name(item.id) }} · {{ item.observation?.error }}
    </p>
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
          <tr v-for="row in rows" :key="row.portfolioId + ':' + row.observedId">
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
              {{ formatTradeAmount(row.avgPrice) }}
              <small>{{ row.quoteAsset }}</small>
            </td>
            <td class="numeric">
              {{ formatNumber(row.executedQty) }}
              <small>{{ row.baseAsset }}</small>
            </td>
            <td class="numeric">
              {{ formatTradeAmount(tradeValue(row.avgPrice, row.executedQty, row.quoteQuantity)) }}
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
      <p v-if="emptyState.detail">{{ emptyState.detail }}</p>
    </div>
    <div class="ledger-footer">
      <span>
        <Timer />
        北京时间 UTC+8
      </span>
      <span v-if="loading">正在读取本地记录</span>
      <span v-else-if="lastObserved">最近监控 {{ formatTradeTime(lastObserved) }}</span>
      <span>
        {{ query === 'recent' ? '最近 24 小时' : `${shanghaiDate(query.startTime)} 至 ${shanghaiDate(query.endTime)}` }}
        <template v-if="loaded"> · 已加载 {{ rows.length }} 笔</template>
      </span>
      <button
        v-if="hasMore"
        class="text-button"
        :disabled="loading"
        @click="loadMore(selected)"
      >
        {{ paging ? '正在加载更早成交…' : '加载更早成交' }}
      </button>
    </div>
  </section>
  <p v-if="entries.length" class="footnote">
    {{ pinned ? '翻页期间保持当前结果，点击「最近 24 小时」可恢复滚动显示。' : '打开此页时从币安同步最近 24 小时的公开成交。日期查询和翻页读取本地记录。' }}
  </p>
  <div v-if="opened" class="position-history">
    <ClosedPositions :entries="entries" :updated-at-by-id="updatedAtById" @quote="emit('quote', $event)" />
  </div>
</template>
