<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { Lock, Refresh, Wallet } from '@element-plus/icons-vue'
import { getPositionSources, type getSpotAccount, type FuturesAccount, type FuturesSession, type Position, type PositionAttribution } from '../futures'
import { formatReturnRate, marginReturn } from '../pnl'
import type { LeadPortfolio } from '../portfolios'
import { formatAmount, formatNumber, formatTradeTime } from '../trades'
import FuturesPositionHistory from './FuturesPositionHistory.vue'
import PositionCloseDialog from './PositionCloseDialog.vue'
import TradeSource from './TradeSource.vue'

const props = defineProps<{
  market: 'spot' | 'futures'
  session: FuturesSession | null
  token: string
  entries: LeadPortfolio[]
  account?: FuturesAccount
  spotAccount?: Awaited<ReturnType<typeof getSpotAccount>>
  loading: boolean
  error: string
  fetchedAt: number
}>()
const emit = defineEmits<{ connect: []; refresh: [] }>()
const tab = ref<'positions' | 'balances' | 'history'>(props.market === 'futures' ? 'positions' : 'balances')
const selectedPosition = shallowRef<Position | null>(null)
watch([() => props.session, () => props.token, () => props.market], () => { selectedPosition.value = null }, { flush: 'sync' })
const historyRevision = ref(0)
const proof = ref<PositionAttribution[]>([])
const sourceError = ref('')
const sourceLoading = ref(false)
const sourceRetry = ref(0)
watch([tab, () => props.account, () => props.session, () => props.token, sourceRetry], async ([active, account, session, token], _, cleanup) => {
  proof.value = []
  sourceError.value = ''
  sourceLoading.value = false
  if (active !== 'positions' || !account?.positions.length || !session || !token || props.market !== 'futures') return
  const controller = new AbortController()
  cleanup(() => controller.abort())
  sourceLoading.value = true
  try {
    const result = await getPositionSources(token, controller.signal)
    if (controller.signal.aborted) return
    if (result.environment !== session.environment || !Array.isArray(result.positions)) throw Error('返回的来源记录与当前账户环境不一致。')
    proof.value = result.positions
  } catch (cause) {
    if (!controller.signal.aborted) sourceError.value = cause instanceof Error ? cause.message : '读取来源失败。'
  } finally {
    if (!controller.signal.aborted) sourceLoading.value = false
  }
}, { immediate: true })
const positions = computed(() => {
  const byLeg = new Map(proof.value.map(row => [row.symbol + ':' + row.positionSide, row]))
  return (props.account?.positions ?? []).map(position => {
    const origin = byLeg.get(position.symbol + ':' + position.positionSide)
    const matches = origin?.quantity === position.quantity && origin.entryPrice === position.entryPrice
      && origin.updateTime === position.updateTime
    const roi = marginReturn(Number(position.unrealizedPnl), Number(position.positionInitialMargin))
    return { ...position, roi, origin: matches ? origin : undefined }
  })
})
function directionLabel(position: Position) {
  return position.positionSide === 'LONG' || (position.positionSide === 'BOTH' && Number(position.quantity) > 0) ? '多仓' : '空仓'
}
function refresh() {
  historyRevision.value++
  emit('refresh')
}
</script>

<template>
  <section class="panel account-card" :aria-busy="loading">
    <div class="ledger-heading">
      <div class="section-title">
        <div class="title-icon"><Wallet /></div>
        <h2>{{ market === 'futures' ? '合约账户' : '现货账户' }}</h2>
      </div>
      <button v-if="session" class="btn small" :disabled="loading" @click="refresh">
        <Refresh />
        {{ loading ? '更新中…' : '刷新账户' }}
      </button>
    </div>
    <div v-if="!session" class="empty-state">
      <span class="empty-icon"><Lock /></span>
      <strong>连接账户以查看{{ market === 'futures' ? '持仓与余额' : '现货余额' }}</strong>
      <button class="text-button" @click="emit('connect')">连接账户</button>
    </div>
    <template v-else>
      <div v-if="market === 'futures'" class="account-tabs" role="group" aria-label="合约账户视图">
        <button type="button" :class="{ active: tab === 'positions' }" :aria-pressed="tab === 'positions'" @click="tab = 'positions'">
          当前持仓
        </button>
        <button type="button" :class="{ active: tab === 'balances' }" :aria-pressed="tab === 'balances'" @click="tab = 'balances'">账户余额</button>
        <button type="button" :class="{ active: tab === 'history' }" :aria-pressed="tab === 'history'" @click="tab = 'history'">仓位历史</button>
      </div>
      <FuturesPositionHistory v-if="market === 'futures' && tab === 'history'" :environment="session.environment"
        :token="token" :revision="historyRevision" />
      <p v-else-if="error" class="notice error" role="alert">{{ error }}</p>
      <div v-else-if="tab === 'positions'" class="table-scroll" tabindex="0" aria-label="当前合约持仓">
        <table>
          <thead>
            <tr>
              <th>合约</th>
              <th>持仓来源</th>
              <th>持仓方向</th>
              <th class="numeric">数量</th>
              <th class="numeric">开仓均价</th>
              <th class="numeric">标记价格</th>
              <th class="numeric">未实现盈亏</th>
              <th class="numeric" title="未实现盈亏 ÷ 仓位初始保证金">收益率</th>
              <th scope="col" class="position-action">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="position in positions"
              :key="position.symbol + position.positionSide"
            >
              <td><strong>{{ position.symbol }}</strong></td>
              <td>
                <span v-if="sourceLoading" class="source-loading">正在核对…</span>
                <TradeSource v-else :sources="position.origin?.sources ?? []" :complete="position.origin?.complete ?? false" :entries="entries" />
              </td>
              <td>{{ directionLabel(position) }}</td>
              <td class="numeric">{{ formatNumber(Math.abs(Number(position.quantity))) }}</td>
              <td class="numeric">{{ formatNumber(Number(position.entryPrice)) }}</td>
              <td class="numeric">{{ formatNumber(Number(position.markPrice)) }}</td>
              <td
                class="numeric pnl-cell"
                :class="{
                  gain: Number(position.unrealizedPnl) > 0,
                  loss: Number(position.unrealizedPnl) < 0,
                }"
              >
                {{ formatAmount(Number(position.unrealizedPnl)) }}
                <small>{{ position.marginAsset }}</small>
              </td>
              <td class="numeric pnl-cell" :class="{ gain: (position.roi ?? 0) > 0, loss: (position.roi ?? 0) < 0 }"
                :title="position.roi === null ? '暂未取得仓位初始保证金' : undefined">
                {{ formatReturnRate(position.roi) }}
              </td>
              <td class="position-action">
                <button type="button" class="btn small" :aria-label="'平仓 ' + position.symbol + ' ' + directionLabel(position)"
                  :disabled="loading || !token" @click="selectedPosition = position">平仓</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!account?.positions.length" class="blank-row">
          {{ loading ? '正在读取持仓…' : '暂无 U 本位合约持仓' }}
        </p>
        <p v-if="sourceError" class="notice warning" role="status">持仓来源核对失败。{{ sourceError }}
          <button type="button" class="text-button" @click="sourceRetry++">重试</button>
        </p>
      </div>
      <div v-else class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>资产</th>
              <th class="numeric">{{ market === 'spot' ? '可用余额' : '钱包余额' }}</th>
              <th class="numeric">{{ market === 'spot' ? '冻结金额' : '可用余额' }}</th>
            </tr>
          </thead>
          <tbody v-if="market === 'spot'">
            <tr v-for="balance in spotAccount?.balances" :key="balance.asset">
              <td>
                <strong>{{ balance.asset }}</strong>
              </td>
              <td class="numeric">{{ balance.free }}</td>
              <td class="numeric">{{ balance.locked }}</td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr v-for="balance in account?.balances" :key="balance.asset">
              <td>
                <strong>{{ balance.asset }}</strong>
              </td>
              <td class="numeric">{{ balance.walletBalance }}</td>
              <td class="numeric">{{ balance.availableBalance }}</td>
            </tr>
          </tbody>
        </table>
        <p
          v-if="!(market === 'spot' ? spotAccount?.balances.length : account?.balances.length)"
          class="blank-row"
        >
          {{ loading ? '正在读取余额…' : '暂无资产余额' }}
        </p>
      </div>
      <div v-if="tab !== 'history' && fetchedAt" class="ledger-footer">
        最近读取 {{ formatTradeTime(fetchedAt) }} UTC+8
      </div>
      <PositionCloseDialog v-if="market === 'futures'" :key="session.environment + ':' + session.id"
        :session="session" :token="token" :position="selectedPosition" @close="selectedPosition = null" @refresh="refresh" />
    </template>
  </section>
</template>

<style scoped>
.source-loading { font-size: 12px; color: var(--muted); }
.position-action { text-align: right; }
@media (max-width: 760px) {
  .position-action { position: sticky; right: 0; box-shadow: -1px 0 var(--line); }
  td.position-action { background: #fff; }
}
.table-scroll .notice { margin-inline: 16px; }
</style>
