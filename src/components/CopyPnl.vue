<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Lock, Refresh } from '@element-plus/icons-vue'
import { getCopyPnl, type CopyPnlPage, type FuturesSession } from '../futures'
import type { LeadPortfolio } from '../portfolios'
import { formatNumber, formatTradeTime } from '../trades'

const props = defineProps<{ session: FuturesSession | null; token: string; entries: LeadPortfolio[] }>()
const emit = defineEmits<{ connect: [] }>()
const page = ref(1)
const revision = ref(0)
const loading = ref(false)
const error = ref('')
const snapshot = ref<{ page: number; at: number; data: CopyPnlPage }>()
const result = computed(() => snapshot.value?.data)
const current = computed(() => snapshot.value?.page === page.value ? snapshot.value.data : null)
const pages = computed(() => result.value ? Math.max(1, Math.ceil(result.value.total / result.value.pageSize)) : 1)
const names = computed(() => new Map(props.entries.map(entry => [entry.id, entry.name || entry.id])))
const columns = [
  { key: 'realized', label: '已实现盈亏' }, { key: 'fees', label: '手续费' }, { key: 'net', label: '净额' },
] as const

watch([() => props.token, page, revision], async ([token, number], _, onCleanup) => {
  if (!props.session || !token) return
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  error.value = ''
  loading.value = true
  try {
    const data = await getCopyPnl(token, number, controller.signal)
    if (controller.signal.aborted) return
    const lastPage = Math.max(1, Math.ceil(data.total / data.pageSize))
    if (number > lastPage) page.value = lastPage
    else snapshot.value = { page: number, at: Date.now(), data }
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '读取跟单盈亏失败。'
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}, { immediate: true })

function pnl(value: number) {
  return (value > 0 ? '+' : '') + formatNumber(value)
}
function direction(kind: 'open' | 'close', side: string) {
  return (kind === 'open' ? '开' : '平') + (side === 'LONG' ? '多' : '空')
}
</script>

<template>
  <header class="page-heading">
    <div><h1>盈亏情况</h1><p>查看本平台跟单订单的实际成交、手续费和持仓浮盈亏。</p></div>
    <button v-if="session" class="btn" :disabled="loading" @click="revision++"><Refresh />{{ loading ? '读取中' : '刷新盈亏' }}</button>
  </header>
  <section v-if="!session" class="panel empty-state">
    <span class="empty-icon"><Lock /></span><strong>连接账户以查看跟单盈亏</strong>
    <button class="btn" @click="emit('connect')">连接账户</button>
  </section>
  <template v-else>
    <div class="pnl-account"><strong>{{ session.name }}</strong>
      <span class="env" :class="{ live: session.environment === 'live' }">{{ session.environment === 'live' ? '实盘' : '测试网' }}</span>
    </div>
    <p v-if="error" class="notice error" role="alert">
      {{ error }}<span v-if="snapshot"> 显示 {{ formatTradeTime(snapshot.at) }} 更新的数据。</span>
    </p>
    <p v-if="loading && !result" class="panel blank-row" role="status">正在读取账户跟单记录…</p>
    <template v-if="result">
      <div class="pnl-overview">
        <section class="panel">
          <div class="ledger-heading"><h2>已结算跟单盈亏</h2></div>
          <div v-if="result.totals.length && result.total > result.pendingCount" class="table-scroll">
            <table class="pnl-totals"><thead><tr>
              <th>币种</th><th v-for="item in columns" :key="item.key" class="numeric">{{ item.label }}</th>
            </tr></thead>
              <tbody><tr v-for="item in result.totals" :key="item.asset">
                <th scope="row">{{ item.asset }}</th><td class="numeric">{{ pnl(item.realized) }}</td>
                <td class="numeric">{{ formatNumber(item.fees) }}</td>
                <td class="numeric pnl-cell" :class="{gain: item.net > 0, loss: item.net < 0}">{{ pnl(item.net) }}</td>
              </tr></tbody>
            </table>
          </div>
          <p v-else class="pnl-note">{{ result.pendingCount ? '等待交易所成交明细结算。' : '暂无已结算的跟单成交。' }}</p>
          <p class="pnl-note">净额按币种扣除成交手续费，资金费请在币安资金流水中另行核对。<span v-if="result.pendingCount">另有 {{ result.pendingCount }} 笔待结算。</span></p>
        </section>
        <section class="panel pnl-unrealized">
          <div class="ledger-heading"><h2>持仓未实现盈亏</h2></div>
          <div v-if="result.openCount && result.unrealized != null" class="pnl-mark"
            :class="{gain: result.unrealized > 0, loss: result.unrealized < 0}">{{ pnl(result.unrealized) }} <small>USDT</small></div>
          <p v-else class="pnl-note">{{ result.openCount ? '等待跟单持仓的标记估值。' : '当前无跟单持仓。' }}</p>
          <p v-if="result.openCount" class="pnl-note">{{ result.openCount }} 个跟单持仓
            <span v-if="result.unrealizedAt"> · 估值时间 {{ formatTradeTime(result.unrealizedAt) }} UTC+8</span>
          </p>
        </section>
      </div>
      <section class="panel" :aria-busy="loading">
        <div class="ledger-heading"><h2>跟单成交记录</h2><span class="count">{{ result.total }} 笔</span></div>
        <div v-if="current?.rows.length" class="table-scroll">
          <table class="pnl-trades">
            <thead><tr><th>提交时间（UTC+8）</th><th>交易对 / 币安订单号</th><th>方向</th><th>带单组合</th>
              <th class="numeric">成交数量</th><th class="numeric">均价</th>
              <th v-for="item in columns" :key="item.key" class="numeric">{{ item.label }}</th></tr></thead>
            <tbody><tr v-for="row in current.rows" :key="row.clientOrderId">
              <td>{{ formatTradeTime(row.time) }}</td>
              <td :title="'客户订单号 ' + row.clientOrderId"><strong>{{ row.symbol }}</strong><small class="pnl-order-id">{{ row.orderId }}</small></td>
              <td>{{ direction(row.kind, row.direction) }}</td><td>{{ names.get(row.portfolioId) || row.portfolioId }}</td>
              <td class="numeric">{{ formatNumber(row.quantity) }}</td><td class="numeric">{{ formatNumber(row.price) }}</td>
              <td v-if="!row.settled" colspan="3" class="numeric">待结算</td>
              <template v-else><td v-for="column in columns" :key="column.key" class="numeric">
                <div v-for="amount in row.amounts" :key="amount.asset">
                  {{ column.key === 'fees' ? formatNumber(amount.fees) : pnl(amount[column.key]) }} <small>{{ amount.asset }}</small>
                </div>
                <span v-if="!row.amounts.length">—</span>
              </td></template>
            </tr></tbody>
          </table>
        </div>
        <p v-else-if="loading || current" class="blank-row" role="status">
          {{ loading ? '正在读取成交记录…' : '暂无跟单成交记录。' }}
        </p>
        <div v-if="pages > 1" class="ledger-footer">
          <button class="text-button" :disabled="page <= 1 || loading" @click="page--">上一页</button>
          <span>第 {{ page }} / {{ pages }} 页</span>
          <button class="text-button" :disabled="page >= pages || loading" @click="page++">下一页</button>
        </div>
      </section>
    </template>
  </template>
</template>

<style scoped>
.pnl-account { display: flex; align-items: center; gap: 8px; font-size: 14px; margin-bottom: 14px; }
.pnl-overview { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 16px; margin-bottom: 18px; }
.pnl-note { margin: 0 20px 15px; color: var(--muted); line-height: 1.6; font-size: 13px; }
.pnl-totals { min-width: 320px; margin-bottom: 12px; }
.pnl-mark { margin: 0 20px 10px; font-size: 29px; font-weight: 650; font-variant-numeric: tabular-nums; }
.pnl-mark small { font-size: 13px; }
.pnl-order-id { display: block; font-size: 11px; color: var(--muted); }
.pnl-trades { min-width: 880px; }
.pnl-trades td { vertical-align: top; }
@media (max-width: 740px) { .pnl-overview { grid-template-columns: 1fr; gap: 12px; } }
</style>
