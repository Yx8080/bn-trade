<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { Lock, Refresh } from '@element-plus/icons-vue'
import { getCopyPnl, getPlatformPnl, getPlatformValuation, type PlatformValuation, type CopyAmount, type FuturesSession } from '../futures'
import type { LeadPortfolio } from '../portfolios'
import { formatAmount, formatFee, formatNumber, formatTradeTime } from '../trades'
import ExchangeActivity from './ExchangeActivity.vue'

const props = defineProps<{ session: FuturesSession | null; token: string; entries: LeadPortfolio[] }>()
const emit = defineEmits<{ connect: [] }>()
const revision = ref(0)
const source = ref<'copy' | 'manual'>('copy')
const names = computed(() => new Map(props.entries.map(entry => [entry.id, entry.name || entry.id])))
const columns = [
  { key: 'realized', label: '已实现盈亏' }, { key: 'fees', label: '手续费' }, { key: 'net', label: '净额' },
] as const

function useLedger<T extends { pageSize: number; total: number }>(read: (token: string, page: number, signal: AbortSignal) => Promise<T>) {
  const page = ref(1)
  const loading = ref(false)
  const error = ref('')
  const snapshot = shallowRef<{ page: number; at: number; data: T }>()
  const result = computed(() => snapshot.value?.data)
  const current = computed(() => snapshot.value?.page === page.value ? snapshot.value.data : null)
  const pages = computed(() => result.value ? Math.max(1, Math.ceil(result.value.total / result.value.pageSize)) : 1)
  watch([() => props.token, page, revision], async ([token, number], _, onCleanup) => {
    if (!props.session || !token) return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    error.value = ''
    loading.value = true
    try {
      const data = await read(token, number, controller.signal)
      if (controller.signal.aborted) return
      const last = Math.max(1, Math.ceil(data.total / data.pageSize))
      if (number > last) page.value = last
      else snapshot.value = { page: number, at: Date.now(), data }
    } catch (cause) {
      if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '读取平台记录失败。'
    } finally {
      if (!controller.signal.aborted) loading.value = false
    }
  }, { immediate: true })
  return { page, loading, error, snapshot, result, current, pages }
}
const copy = useLedger(getCopyPnl)
const manual = useLedger(getPlatformPnl)
const valuation = shallowRef<PlatformValuation | null>(null)
const valuationError = ref('')
watch([() => props.token, revision], async ([token], _, onCleanup) => {
  if (!props.session || !token) return
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  valuationError.value = ''
  valuation.value = null
  try {
    const result = await getPlatformValuation(token, controller.signal)
    if (!controller.signal.aborted) valuation.value = result
  } catch (cause) {
    if (!controller.signal.aborted) valuationError.value = cause instanceof Error ? cause.message : '持仓估值暂不可用。'
  }
}, { immediate: true })
const copyData = copy.result
const manualData = manual.result
const ledger = computed(() => source.value === 'copy' ? copy : manual)
const pendingCount = computed(() => (copyData.value?.pendingCount ?? 0) + (manualData.value?.pendingCount ?? 0))
const settledTotals = computed(() => {
  if (!copyData.value || !manualData.value) return null
  const totals = new Map<string, CopyAmount>()
  for (const row of [...copyData.value.totals, ...manualData.value.totals]) {
    const total = totals.get(row.asset) ?? { asset: row.asset, realized: 0, fees: 0, net: 0 }
    total.realized += row.realized
    total.fees += row.fees
    total.net += row.net
    totals.set(row.asset, total)
  }
  return [...totals.values()]
})
const rows = computed(() => {
  if (source.value === 'manual') return manual.current.value?.rows.map(row => ({
    ...row, label: row.market === 'spot' ? '手动现货' : '手动合约', portfolio: '',
    action: row.side === 'BUY' ? '买入' : '卖出',
    price: row.quantity > 0 && row.quote > 0 ? row.quote / row.quantity : null,
  })) ?? []
  return copy.current.value?.rows.map(row => ({
    ...row, label: '合约跟单', portfolio: names.value.get(row.portfolioId) || row.portfolioId,
    action: (row.kind === 'open' ? '开' : '平') + (row.direction === 'LONG' ? '多' : '空'),
    status: '',
  })) ?? []
})
const loading = computed(() => copy.loading.value || manual.loading.value)
const errors = computed(() => [
  { name: '跟单账本', ledger: copy }, { name: '手动订单账本', ledger: manual },
].filter(item => item.ledger.error.value).map(({ name, ledger }) => name + ' · ' + ledger.error.value
  + (ledger.snapshot.value ? ' 显示 ' + formatTradeTime(ledger.snapshot.value.at) + ' 的记录。' : '')))
</script>

<template>
  <header class="page-heading">
    <div><h1>盈亏情况</h1><p>查看本平台跟单、手动合约和现货买入的成交、手续费与持仓估值。</p></div>
    <button v-if="session" class="btn" :disabled="loading" @click="revision++"><Refresh />{{ loading ? '读取中' : '刷新盈亏' }}</button>
  </header>
  <section v-if="!session" class="panel empty-state">
    <span class="empty-icon"><Lock /></span><strong>连接账户以查看平台盈亏</strong>
    <button class="btn" @click="emit('connect')">连接账户</button>
  </section>
  <template v-else>
    <div class="pnl-account"><strong>{{ session.name }}</strong>
      <span class="env live">实盘</span>
    </div>
    <p v-for="message in errors" :key="message" class="notice error" role="alert">{{ message }}</p>
    <div class="pnl-overview">
      <section class="panel">
        <div class="ledger-heading"><h2>平台已实现盈亏</h2></div>
        <div v-if="settledTotals?.length" class="table-scroll">
          <table class="pnl-totals"><thead><tr><th>币种</th><th v-for="item in columns" :key="item.key" class="numeric">{{ item.label }}</th></tr></thead>
            <tbody><tr v-for="item in settledTotals" :key="item.asset">
              <th scope="row">{{ item.asset }}</th><td class="numeric">{{ formatAmount(item.realized, true) }}</td>
              <td class="numeric">{{ formatFee(item.fees) }}</td>
              <td class="numeric pnl-cell" :class="{gain: item.net > 0, loss: item.net < 0}">{{ formatAmount(item.net, true) }}</td>
            </tr></tbody>
          </table>
        </div>
        <p v-else class="pnl-note">{{ settledTotals ? '暂无已结算的平台成交。' : loading ? '正在读取平台账本…' : '平台账本尚未完整返回，暂时无法合计。' }}</p>
        <p class="pnl-note">按币种汇总已核实的平台成交，净额已扣除手续费。资金费可在币安资金流水核对。<span v-if="pendingCount">还有 {{ pendingCount }} 笔订单待结算。</span></p>
      </section>
      <section class="panel">
        <div class="ledger-heading"><h2>合约持仓未实现盈亏</h2></div>
        <dl class="position-marks">
          <div><dt>跟单份额估值</dt><dd>{{ !copyData ? '暂未读取' : !copyData.openCount ? '暂无持仓' : copyData.unrealized == null ? '等待估值' : formatAmount(copyData.unrealized, true) + ' USDT' }}</dd></div>
          <div v-for="row in valuation?.manualPositions" :key="row.symbol + row.positionSide">
            <dt>手动 · {{ row.symbol }} {{ row.positionSide === 'BOTH' ? '' : row.positionSide === 'LONG' ? '多' : '空' }}</dt>
            <dd>{{ row.unrealized == null ? '待核实' : formatAmount(row.unrealized, true) + ' USDT' }}</dd>
          </div>
          <div v-if="!valuation?.manualPositions.length"><dt>平台手动</dt><dd>{{ !valuation || valuation.valuationError ? '暂未取得估值' : '暂无可归属持仓' }}</dd></div>
        </dl>
        <p class="pnl-note">手动和跟单同向合仓时，跟单浮盈和止损按跟单成交均价估算。已实现盈亏取币安按合仓均价结算的成交回执。</p>
        <p v-if="copyData?.openCount && copyData.unrealizedAt" class="pnl-note">跟单估值 {{ formatTradeTime(copyData.unrealizedAt) }} UTC+8</p>
        <p v-if="valuation?.manualPositions.length && valuation.valuationTime" class="pnl-note">手动估值 {{ formatTradeTime(valuation.valuationTime) }} UTC+8</p>
      </section>
    </div>
    <p v-if="valuationError || valuation?.valuationError" class="notice warning" role="status">{{ valuationError || valuation?.valuationError }}</p>
    <section class="panel pnl-section">
      <div class="ledger-heading"><h2>平台现货买入估值</h2></div>
      <p v-if="valuation?.spot.length" class="pnl-note">按平台买入成本、净数量和当前价格估算。跨交易对买卖或充提可能改变实际持有批次。这里的估值单独展示。</p>
      <div v-if="valuation?.spot.length" class="table-scroll"><table>
        <thead><tr><th>交易对</th><th class="numeric">买入数量</th><th class="numeric">成本（USDT）</th><th class="numeric">估计市值（USDT）</th><th class="numeric">未实现盈亏（USDT）</th></tr></thead>
        <tbody><tr v-for="row in valuation.spot" :key="row.symbol"><td>{{ row.symbol }}</td>
          <td class="numeric">{{ formatNumber(row.quantity) }}</td><td class="numeric">{{ formatAmount(row.cost) }}</td>
          <td class="numeric">{{ formatAmount(row.value) }}</td><td class="numeric">{{ row.unrealized == null ? '待估值' : formatAmount(row.unrealized, true) }}</td>
        </tr></tbody>
      </table></div>
      <p v-else class="pnl-note">{{ valuation ? '暂无平台现货买入记录。' : '现货估值暂未返回。' }}</p>
    </section>
    <section class="panel pnl-section" :aria-busy="ledger.loading.value">
      <div class="ledger-heading"><h2>平台成交记录</h2><span v-if="ledger.result.value" class="count">{{ ledger.result.value.total }} 笔</span></div>
      <nav class="trade-tabs record-tabs" aria-label="平台成交来源">
        <button type="button" :aria-pressed="source === 'copy'" @click="source = 'copy'">合约跟单</button>
        <button type="button" :aria-pressed="source === 'manual'" @click="source = 'manual'">手动合约与现货</button>
      </nav>
      <div v-if="rows.length" class="table-scroll">
        <table class="pnl-trades"><thead><tr><th>{{ source === 'manual' ? '最近成交时间' : '提交时间' }}（UTC+8）</th><th>交易对 / 币安订单号</th><th>下单来源</th><th>方向</th>
          <th class="numeric">成交数量</th><th class="numeric">均价</th><th v-for="item in columns" :key="item.key" class="numeric">{{ item.label }}</th></tr></thead>
          <tbody><tr v-for="row in rows" :key="row.symbol + row.clientOrderId">
            <td>{{ formatTradeTime(row.time) }}</td>
            <td :title="'客户订单号 ' + row.clientOrderId"><strong>{{ row.symbol }}</strong><small class="pnl-order-id">{{ row.orderId || row.clientOrderId }}</small></td>
            <td>{{ row.label }}<small v-if="row.portfolio" class="pnl-order-id">{{ row.portfolio }}</small></td>
            <td>{{ row.action }}<small v-if="row.status" class="pnl-order-id">{{ row.status }}</small></td>
            <td class="numeric">{{ formatNumber(row.quantity) }}</td><td class="numeric">{{ formatNumber(row.price) }}</td>
            <td v-if="!row.settled && !row.amounts.length" colspan="3" class="numeric">待结算</td>
            <template v-else><td v-for="col in columns" :key="col.key" class="numeric">
              <div v-for="amount in row.amounts" :key="amount.asset">{{ col.key === 'fees' ? formatFee(amount.fees) : formatAmount(amount[col.key], true) }} <small>{{ amount.asset }}</small></div>
              <span v-if="!row.amounts.length">—</span>
            </td></template>
          </tr></tbody>
        </table>
      </div>
      <p v-else class="pnl-note">{{ ledger.loading.value ? '正在读取成交记录…' : ledger.current.value ? '暂无此来源的平台记录。' : '平台记录暂未返回。' }}</p>
      <div v-if="ledger.pages.value > 1" class="ledger-footer">
        <button class="text-button" :disabled="ledger.page.value <= 1 || ledger.loading.value" @click="ledger.page.value--">上一页</button>
        <span>第 {{ ledger.page.value }} / {{ ledger.pages.value }} 页</span>
        <button class="text-button" :disabled="ledger.page.value >= ledger.pages.value || ledger.loading.value" @click="ledger.page.value++">下一页</button>
      </div>
    </section>
    <ExchangeActivity :token="token" :revision="revision" />
  </template>
</template>

<style scoped>
.pnl-account { display: flex; align-items: center; gap: 8px; font-size: 14px; margin-bottom: 14px; }
.pnl-overview { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 16px; margin-bottom: 18px; }
.pnl-section { margin-top: 18px; overflow: hidden; }
.pnl-note { margin: 0 20px 15px; color: var(--muted); line-height: 1.6; font-size: 13px; }
.pnl-totals { min-width: 320px; margin-bottom: 12px; }
.position-marks { margin: 0 20px 12px; }
.position-marks div { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; font-size: 13px; }
.position-marks dd { font-weight: 630; }
.record-tabs { margin: 0 20px 12px; }
.pnl-order-id { display: block; font-size: 11px; color: var(--muted); }
.pnl-trades { min-width: 880px; }
.pnl-trades td { vertical-align: top; }
@media (max-width: 740px) { .pnl-overview { grid-template-columns: 1fr; gap: 12px; } }
</style>
