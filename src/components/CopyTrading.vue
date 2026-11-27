<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowDown, CircleCheck, Refresh, Tickets } from '@element-plus/icons-vue'
import { COPY_LEVERAGE_TIERS, isAppLeverage, isCopyLeverageOverrides } from '../../shared/leverage.js'
import { getCopyEquity, getCopyStatus, updateCopyStatus, type BoundSession, type CopyConfig, type CopyStatus } from '../futures'
import type { OpeningFunds } from '../opening-funds'
import type { LeadPortfolio } from '../portfolios'
import { formatNumber, formatTradeTime } from '../trades'
import WorkspaceDialog from './WorkspaceDialog.vue'
import CopyLeverageControl from './CopyLeverageControl.vue'
import OpeningBalance from './OpeningBalance.vue'

const props = defineProps<{ entries: LeadPortfolio[]; session: BoundSession | null; token: string; funds: OpeningFunds }>()
const savedDraft = defineModel<CopyConfig | null>('draft', { required: true })
const emit = defineEmits<{ connect: []; edit: []; refresh: [] }>()
function copyPlan(plan: CopyConfig): CopyConfig {
  const leverage = plan.leverage !== null && typeof plan.leverage === 'object' ? { ...plan.leverage } : plan.leverage
  return { ...plan, leverage, portfolioIds: [...plan.portfolioIds], manualPositionPolicy: plan.manualPositionPolicy ?? 'skip' }
}
const draft = ref<CopyConfig>(savedDraft.value ? copyPlan(savedDraft.value) : {
  portfolioIds: props.entries.slice(0, 1).map(entry => entry.id), sizingMode: 'margin', amount: 0, leverage: 'max', repeat: 'fixed',
  maxEntries: 2, maxPositions: 2, stopLoss: 5, manualPositionPolicy: 'skip',
})
const status = ref<CopyStatus | null>(null)
const statusError = ref('')
const actionError = ref('')
const busy = ref(false)
const checking = ref(false)
const preview = ref<CopyConfig | null>(null)
const eventsOpen = ref(false)
const advancedSettings = ref<HTMLDetailsElement | null>(null)
const equity = ref<Awaited<ReturnType<typeof getCopyEquity>> | null>(null)
const equityLoading = ref(false)
const equityError = ref('')
const locked = computed(() => Boolean(status.value?.enabled || status.value?.pending || status.value?.positions.length))
const managedConfig = computed(() => locked.value ? status.value?.config : null)
const synchronized = computed(() => Boolean(status.value && !statusError.value))
const fixed = computed(() => draft.value.repeat === 'fixed')
const config = computed<CopyConfig>(() => ({ ...draft.value, maxEntries: fixed.value ? draft.value.maxEntries : 1 }))
const portfolios = computed(() => {
  const extra = draft.value.portfolioIds.filter(id => !props.entries.some(entry => entry.id === id))
  return [...props.entries, ...extra.map(id => ({ id, name: id }))]
})
const estimate = computed(() => sizeEstimate(draft.value))
const previewEstimate = computed(() => preview.value ? sizeEstimate(preview.value) : null)
function leverageTierSummary(overrides: CopyConfig['leverage'] | undefined) {
  if (!overrides || typeof overrides !== 'object') return ''
  return COPY_LEVERAGE_TIERS.filter(tier => overrides[tier] !== undefined)
    .map(tier => '最高 ' + tier + '× 用 ' + overrides[tier] + '×').join(' · ')
}
const previewTierSummary = computed(() => leverageTierSummary(preview.value?.leverage))
const managedTierSummary = computed(() => leverageTierSummary(managedConfig.value?.leverage))
const percentMode = computed(() => draft.value.sizingMode === 'equityPercent')
const legacyMode = computed(() => draft.value.sizingMode === 'notional' || status.value?.config?.sizingMode === 'notional')
const amountInput = computed({
  get: () => draft.value.amount || '',
  set: (value: number | string) => { draft.value.amount = Number(value) },
})
const legacyLeverage = computed(() => draft.value.sizingMode === 'notional' && draft.value.leverage === null)
const awaitingEquity = computed(() => !!props.session && preview.value?.sizingMode === 'equityPercent' && !equity.value)
const fundingIssue = computed(() => checkFunding(estimate.value.margin))
const previewFundingIssue = computed(() => checkFunding(previewEstimate.value?.margin ?? null))
const positionCount = computed(() => status.value?.positions.length ?? 0)
const stateLabel = computed(() => {
  if (!props.session) return '访客预览'
  if (!synchronized.value) return statusError.value ? '状态待核实' : '正在读取'
  if (status.value?.enabled) return '跟单中'
  if (locked.value) return '已暂停新开仓'
  return status.value?.config ? '已暂停' : '未启动'
})
let controller: AbortController | undefined
let equityController: AbortController | undefined
let timer: number | undefined
const lastAmount: Partial<Record<CopyConfig['sizingMode'], number>> = {}

function portfolioName(id: string) {
  return props.entries.find(entry => entry.id === id)?.name || id
}
function sizeEstimate(plan: CopyConfig) {
  if (!validMoney(plan.amount)) return { margin: null, notional: null }
  const leverage = isAppLeverage(plan.leverage) ? plan.leverage : null
  if (plan.sizingMode === 'notional') return { notional: plan.amount, margin: leverage ? plan.amount / leverage : null }
  const margin = plan.sizingMode === 'margin' ? plan.amount
    : equity.value && plan.amount <= 100 ? equity.value.equity * (plan.amount / 100) : null
  return { margin, notional: margin != null && leverage ? margin * leverage : null }
}
function checkFunding(margin: number | null) {
  if (!props.session) return ''
  const { available, state } = props.funds
  if (state !== 'ready' || available === null) return '读取合约可用余额后可启动跟单。'
  if (available <= 0) return '当前没有可用于开仓的 USDT。'
  if (margin !== null && Number(margin.toFixed(8)) > available) {
    return '每笔预计保证金超过当前可用余额。'
  }
  return ''
}
function setSizingMode(mode: CopyConfig['sizingMode']) {
  if (draft.value.sizingMode === mode) return
  lastAmount[draft.value.sizingMode] = draft.value.amount
  draft.value.sizingMode = mode
  draft.value.amount = lastAmount[mode] ?? (mode === 'equityPercent' ? 1 : 0)
}
function refreshFunds() {
  emit('refresh')
  if (percentMode.value) void refreshEquity()
}
async function refreshEquity() {
  equityController?.abort()
  equity.value = null
  equityLoading.value = false
  equityError.value = ''
  if (!props.token || !props.session || !percentMode.value) return
  const current = new AbortController()
  equityController = current
  equityLoading.value = true
  try {
    const snapshot = await getCopyEquity(props.token, current.signal)
    if (current.signal.aborted) return
    if (!Number.isFinite(snapshot.equity) || snapshot.equity <= 0) throw Error('账户总权益须大于零才能按比例跟单。')
    equity.value = snapshot
  } catch (cause) {
    if (!current.signal.aborted) equityError.value = cause instanceof Error ? cause.message : '读取账户总权益失败。'
  } finally {
    if (!current.signal.aborted) equityLoading.value = false
  }
}
watch([percentMode, () => props.token], refreshEquity, { immediate: true })
watch(draft, (next, previous) => {
  // Form controls edit fields in place. A server refresh replaces the entire plan.
  if (next !== previous) return
  savedDraft.value = copyPlan(next)
  actionError.value = ''
}, { deep: true, flush: 'sync' })
watch(() => props.entries, (entries, previous) => {
  if (locked.value || busy.value) return
  const removed = previous.filter(old => !entries.some(entry => old.id === entry.id))
  if (removed.some(entry => draft.value.portfolioIds.includes(entry.id))) {
    draft.value.portfolioIds = draft.value.portfolioIds.filter(id => !removed.some(entry => entry.id === id))
  }
})
function applyStatus(result: CopyStatus) {
  status.value = result
  statusError.value = ''
  if (locked.value) {
    savedDraft.value = null
  }
  if (result.config && (locked.value || !savedDraft.value)) draft.value = copyPlan(result.config)
}
function stopRequest() {
  window.clearTimeout(timer)
  controller?.abort()
}
async function refresh() {
  if (!props.session || busy.value) return
  stopRequest()
  const current = new AbortController()
  controller = current
  checking.value = true
  try {
    const result = await getCopyStatus(props.token, current.signal)
    if (!current.signal.aborted) applyStatus(result)
  } catch (cause) {
    if (!current.signal.aborted) statusError.value = cause instanceof Error ? cause.message : '读取跟单状态失败。'
  } finally {
    if (!current.signal.aborted) {
      checking.value = false
      timer = window.setTimeout(refresh, 5_000)
    }
  }
}
onMounted(refresh)
onUnmounted(() => {
  stopRequest()
  equityController?.abort()
})

function validMoney(value: number) {
  return Number.isFinite(value) && value > 0 && Number(value.toFixed(8)) === value
    && Number.isSafeInteger(Math.round(value * 1e8))
}
function revealAdvanced() {
  if (advancedSettings.value) advancedSettings.value.open = true
}
function prepare() {
  actionError.value = ''
  const plan = config.value
  if (!plan.portfolioIds.length || plan.portfolioIds.some(id => !/^\d{1,30}$/.test(id))) {
    actionError.value = '请至少勾选一个有效的带单组合。'
  } else if (plan.leverage !== 'max' && !(locked.value && legacyLeverage.value)
    && !isAppLeverage(plan.leverage) && !isCopyLeverageOverrides(plan.leverage)) {
    revealAdvanced()
    actionError.value = '请选择杠杆方式。自定义倍数须为对应档位范围内的正整数。'
  } else if (!validMoney(plan.amount) || !validMoney(plan.stopLoss)) {
    actionError.value = '每笔投入和止损金额须大于零，最多支持 8 位小数。'
  } else if (plan.sizingMode === 'equityPercent' && plan.amount > 100) {
    actionError.value = '每笔保证金占总权益的比例最多为 100%。'
  } else if (fundingIssue.value) {
    actionError.value = fundingIssue.value
  } else if (![plan.maxEntries, plan.maxPositions].every(n => Number.isInteger(n) && n >= 1 && n <= 100)) {
    revealAdvanced()
    actionError.value = '开仓次数和同时持仓数须为 1 至 100 的整数。'
  } else if (!busy.value && !status.value?.enabled) {
    preview.value = copyPlan(plan)
    if (percentMode.value && props.session) void refreshEquity()
  }
}
function connectForStart() {
  savedDraft.value = copyPlan(draft.value)
  preview.value = null
  emit('connect')
}
function matchesConfig(left: CopyConfig, right: CopyConfig | null) {
  return right != null && left.portfolioIds.length === right.portfolioIds.length
    && left.portfolioIds.every(id => right.portfolioIds.includes(id))
    && left.repeat === right.repeat && left.maxEntries === right.maxEntries && left.maxPositions === right.maxPositions
    && (left.manualPositionPolicy ?? 'skip') === (right.manualPositionPolicy ?? 'skip')
    && left.sizingMode === right.sizingMode && left.amount === right.amount
    && left.stopLoss === right.stopLoss && JSON.stringify(left.leverage) === JSON.stringify(right.leverage)
}
async function submit(action: 'start' | 'pause') {
  const session = props.session
  if (!session || busy.value || !synchronized.value || (action === 'start' && (awaitingEquity.value || previewFundingIssue.value))) return
  const plan = preview.value
  preview.value = null
  if (action === 'start' && (!plan || status.value?.enabled || (locked.value && !matchesConfig(plan, status.value?.config ?? null)))) {
    actionError.value = '跟单状态已更新，请核对当前设置后重新预览。'
    return
  }
  stopRequest()
  const current = new AbortController()
  controller = current
  checking.value = false
  busy.value = true
  actionError.value = ''
  try {
    const command = action === 'start' && plan
      ? { action: 'start' as const, environment: session.environment, config: plan }
      : { action: 'pause' as const, environment: session.environment }
    const result = await updateCopyStatus(props.token, command, current.signal)
    if (current.signal.aborted) return
    savedDraft.value = null
    applyStatus(result)
  } catch (cause) {
    if (current.signal.aborted) return
    actionError.value = cause instanceof Error ? cause.message : '跟单操作失败，请刷新状态。'
    statusError.value = '正在核对服务端跟单状态。'
  } finally {
    if (!current.signal.aborted) {
      busy.value = false
      if (statusError.value) void refresh()
      else timer = window.setTimeout(refresh, 5_000)
    }
  }
}
</script>

<template>
  <div>
    <section v-if="session" class="copy-status" aria-label="执行状态">
      <div class="copy-state" :class="{ 'is-running': synchronized && status?.enabled }">
        <div class="copy-state-main">
          <h3 class="copy-state-title" aria-live="polite">
            <CircleCheck v-if="synchronized && status?.enabled" aria-hidden="true" />
            {{ stateLabel }}
          </h3>
          <p class="copy-state-meta">
            <span>{{ session.name }}</span>
            <time v-if="status?.lastCheck" :datetime="new Date(status.lastCheck).toISOString()">
              最近检查 {{ formatTradeTime(status.lastCheck) }} UTC+8
            </time>
          </p>
        </div>
        <div class="copy-state-actions">
          <button v-if="status?.enabled" type="button" class="btn small" :disabled="busy || !synchronized" @click="submit('pause')">
            {{ busy ? '处理中…' : '暂停新开仓' }}
          </button>
          <button v-else-if="locked" type="button" class="btn small primary" :disabled="busy || !synchronized || !!fundingIssue" @click="prepare">
            {{ busy ? '处理中…' : '恢复跟单' }}
          </button>
          <button type="button" class="btn small" aria-haspopup="dialog" :disabled="!status" @click="eventsOpen = true">
            <Tickets aria-hidden="true" />执行记录
          </button>
          <button type="button" class="icon-button" title="刷新执行状态" aria-label="刷新执行状态"
            :disabled="checking || busy" @click="refresh"><Refresh aria-hidden="true" /></button>
        </div>
      </div>
      <p v-if="statusError || status?.error" class="notice warning" role="status">{{ statusError || status?.error }}</p>
      <p v-if="status?.pending" class="notice warning" role="status">
        订单待核实 · {{ portfolioName(status.pending.portfolioId) }} · {{ status.pending.symbol }} · {{ status.pending.clientOrderId }}
      </p>
      <p v-if="locked && actionError" class="notice error" role="alert">{{ actionError }}</p>
      <template v-if="locked && !status?.enabled">
        <p class="ticket-hint">已有跟单仓位继续处理止损和跟随平仓，仓位和订单结清后可修改设置。</p>
        <p v-if="fundingIssue" class="notice warning" role="status">
          {{ fundingIssue }} <button type="button" class="text-button" @click="refreshFunds">刷新余额</button>
        </p>
      </template>
      <div v-if="managedConfig" class="copy-managed">
        <h3>策略设置</h3>
        <p class="copy-managed-leaders">
          <span>跟单对象</span><strong>{{ managedConfig.portfolioIds.map(portfolioName).join('、') }}</strong>
        </p>
        <dl class="copy-overview">
          <div><dt>跟单方式</dt><dd>{{ managedConfig.sizingMode === 'equityPercent' ? '定比跟单' : managedConfig.sizingMode === 'margin' ? '定额跟单' : '原策略合约价值' }}</dd></div>
          <div>
            <dt>{{ managedConfig.sizingMode === 'equityPercent' ? '每笔占总权益' : managedConfig.sizingMode === 'margin' ? '每笔保证金' : '每笔合约价值' }}</dt>
            <dd>{{ formatNumber(managedConfig.amount) }}{{ managedConfig.sizingMode === 'equityPercent' ? '%' : ' USDT' }}</dd>
          </div>
          <div><dt>单仓止损</dt><dd>{{ formatNumber(managedConfig.stopLoss) }} USDT</dd></div>
          <div>
            <dt>杠杆 · 持仓上限</dt>
            <dd>{{ managedConfig.leverage === 'max' ? '最高档' : typeof managedConfig.leverage === 'number' ? managedConfig.leverage + ' 倍' :
              managedConfig.leverage ? '自定义档位' : '沿用当前杠杆' }} · {{ managedConfig.maxPositions }} 仓</dd>
          </div>
        </dl>
        <details class="copy-policy">
          <summary>高级设置 <ArrowDown aria-hidden="true" /></summary>
          <dl class="copy-overview">
            <div><dt>已有仓位时</dt><dd>{{ managedConfig.manualPositionPolicy === 'add' ? '自动加仓' : '跳过' }}</dd></div>
            <div><dt>跟单开仓方式</dt><dd>{{ managedConfig.repeat === 'fixed' ? '自动加仓 · 最多 ' + managedConfig.maxEntries + ' 次' : '首笔' }}</dd></div>
            <div v-if="managedTierSummary" class="copy-tiers"><dt>自定义杠杆</dt><dd>{{ managedTierSummary }}</dd></div>
          </dl>
        </details>
      </div>
      <div v-if="locked && status" class="copy-positions">
        <h3>跟单持仓 <span>{{ positionCount }}</span></h3>
        <div v-if="positionCount" class="table-scroll">
          <table><thead><tr><th>交易对 / 方向</th><th>带单组合</th><th class="numeric">数量</th><th class="numeric">开仓均价</th><th class="numeric">开仓次数</th></tr></thead>
            <tbody><tr v-for="row in status.positions" :key="row.symbol + '/' + row.direction">
              <td>{{ row.symbol }} · {{ row.direction === 'LONG' ? '多' : '空' }}</td>
              <td>{{ portfolioName(row.portfolioId) }}</td>
              <td class="numeric">{{ formatNumber(row.quantity) }}</td><td class="numeric">{{ formatNumber(row.entryPrice) }}</td><td class="numeric">{{ row.entries }}</td>
            </tr></tbody>
          </table>
        </div>
        <p v-else class="ticket-hint">暂无跟单持仓。</p>
      </div>
    </section>
    <div v-if="!locked && (!session || status || statusError)" class="futures-form-panel">
      <form aria-label="跟单设置" class="ticket-form" @submit.prevent="prepare">
        <fieldset class="copy-mode-group" :disabled="locked || busy" aria-label="跟单方式">
          <div class="copy-modes">
            <label class="copy-mode">
              <input type="radio" name="copy-sizing" value="margin" :checked="draft.sizingMode === 'margin'" @change="setSizingMode('margin')" />
              <span>定额跟单</span>
            </label>
            <label class="copy-mode">
              <input type="radio" name="copy-sizing" value="equityPercent" :checked="percentMode" @change="setSizingMode('equityPercent')" />
              <span>定比跟单</span>
            </label>
            <label v-if="legacyMode" class="copy-mode">
              <input type="radio" name="copy-sizing" value="notional" :checked="draft.sizingMode === 'notional'" @change="setSizingMode('notional')" />
              <span>原策略合约价值</span>
            </label>
          </div>
          <p v-if="draft.sizingMode === 'notional'" class="ticket-hint">
            沿用原策略设置的每笔合约价值。
          </p>
        </fieldset>
        <fieldset class="copy-fields" :disabled="locked || busy">
          <fieldset class="copy-choice-group">
            <legend>跟单对象（可多选）</legend>
            <div class="copy-choices">
              <label v-for="entry in portfolios" :key="entry.id" class="copy-choice">
                <input v-model="draft.portfolioIds" type="checkbox" :value="entry.id" />
                <span>{{ entry.name || entry.id }}</span>
              </label>
              <button type="button" class="text-button" @click="emit('edit')">添加组合</button>
            </div>
            <small>已选 {{ draft.portfolioIds.length }} 个组合</small>
          </fieldset>
        </fieldset>
        <OpeningBalance :funds="funds" @refresh="refreshFunds" @connect="emit('connect')">
          <label class="field">
            <span>{{ percentMode ? '每笔保证金占总权益（%）' : draft.sizingMode === 'margin' ? '每笔初始保证金（USDT）' : '每笔合约价值（USDT）' }}</span>
            <input v-model.number="amountInput" type="number" step="0.00000001" min="0.00000001"
              :max="percentMode ? 100 : undefined" :disabled="locked || busy" :aria-describedby="session && funds.state === 'ready' && fundingIssue ? 'copy-funding-issue' : undefined"
              :placeholder="percentMode ? '输入总权益比例' : draft.sizingMode === 'margin' ? '输入每笔保证金' : '输入合约价值'" required />
          </label>
        </OpeningBalance>
        <p v-if="session && funds.state === 'ready' && fundingIssue" id="copy-funding-issue" class="notice warning" role="status">{{ fundingIssue }}</p>
        <p v-if="percentMode || estimate.margin != null || estimate.notional != null" class="margin-hint" aria-live="polite">
          <span v-if="percentMode && equity">当前总权益 {{ formatNumber(equity.equity) }} USDT。</span>
          <span v-if="estimate.margin != null && estimate.notional != null">初始保证金约 <strong>{{ formatNumber(estimate.margin) }} USDT</strong>，按设置倍数估算合约价值约 <strong>{{ formatNumber(estimate.notional) }} USDT</strong>，未计手续费。</span>
          <span v-else-if="estimate.margin != null && draft.leverage === 'max'">预计初始保证金 <strong>{{ formatNumber(estimate.margin) }} USDT</strong>，合约价值按开仓时的最高可用杠杆计算。</span>
          <span v-else-if="estimate.margin != null && typeof draft.leverage === 'object' && draft.leverage !== null">预计初始保证金 <strong>{{ formatNumber(estimate.margin) }} USDT</strong>，合约价值按匹配档位和可用杠杆计算。</span>
          <span v-else-if="percentMode && !session">连接账户后可预估每笔保证金与合约价值。</span>
          <span v-else-if="draft.sizingMode === 'notional' && draft.leverage == null">原策略按每笔合约价值下单，实际初始保证金取决于交易对的杠杆倍数。</span>
        </p>
        <p v-if="percentMode && equityError" class="notice warning" role="status">{{ equityError }} <button type="button" class="text-button" @click="refreshEquity">重试</button></p>
        <label class="field">
          <span>单仓止损金额（USDT）</span>
          <input v-model.number="draft.stopLoss" type="number" step="0.00000001" min="0.00000001" :disabled="locked || busy" required />
        </label>
        <details ref="advancedSettings" class="copy-advanced" @invalid.capture="revealAdvanced">
          <summary>
            <strong>高级设置</strong>
            <span class="copy-advanced-values">
              <template v-if="draft.leverage === 'max'">默认最高档</template>
              <template v-else-if="draft.leverage !== null && typeof draft.leverage === 'object'">自定义杠杆档位</template>
              <template v-else-if="draft.leverage != null">{{ draft.leverage }} 倍杠杆</template>
              <template v-else>{{ legacyLeverage ? '沿用交易对杠杆' : '杠杆待填写' }}</template>
              · 最多 {{ draft.maxPositions || '—' }} 仓
            </span>
            <ArrowDown class="copy-advanced-arrow" aria-hidden="true" />
          </summary>
          <div class="copy-advanced-body">
            <CopyLeverageControl v-model="draft.leverage" :disabled="locked || busy" :notional="estimate.notional"
              :session="session" :token="token" />
            <fieldset class="copy-fields" :disabled="locked || busy">
              <label class="field copy-setting">
                <span>已有仓位时</span>
                <select v-model="draft.manualPositionPolicy">
                  <option value="skip">跳过</option>
                  <option value="add">自动加仓</option>
                </select>
              </label>
              <label class="field copy-setting">
                <span>跟单开仓方式</span>
                <select v-model="draft.repeat">
                  <option value="first">首笔</option>
                  <option value="fixed">自动加仓</option>
                </select>
              </label>
              <div class="two-fields">
                <label class="field">
                  <span>单仓最多开仓次数</span>
                  <input v-if="fixed" v-model.number="draft.maxEntries" type="number" min="1" max="100" step="1" required />
                  <input v-else type="number" value="1" disabled />
                  <small>含首次开仓</small>
                </label>
                <label class="field">
                  <span>同时持仓上限</span>
                  <input v-model.number="draft.maxPositions" type="number" min="1" max="100" step="1" required />
                  <small>所有已选组合共用，按交易对计数</small>
                </label>
              </div>
            </fieldset>
          </div>
        </details>
        <p v-if="actionError" class="notice error" role="alert">{{ actionError }}</p>
        <button type="submit" class="btn primary" :disabled="busy || !validMoney(draft.amount) || !draft.portfolioIds.length || !!fundingIssue || (!!session && !synchronized)">
          {{ busy ? '处理中…' : '预览跟单设置' }}
        </button>
      </form>
    </div>
    <WorkspaceDialog v-if="eventsOpen" title="执行记录" @close="eventsOpen = false">
      <ul v-if="status?.events.length" class="copy-events" tabindex="0" aria-label="跟单执行记录">
        <li v-for="(event, i) in status.events" :key="i">
          <time :datetime="new Date(event.time).toISOString()">{{ formatTradeTime(event.time) }}</time>
          <span>{{ event.message }}</span>
        </li>
      </ul>
      <p v-else class="ticket-hint">暂无执行记录。</p>
    </WorkspaceDialog>
    <WorkspaceDialog v-if="preview" :title="session ? '确认启动实盘跟单' : '跟单设置预览'" @close="preview = null">
      <dl class="order-review">
        <div><dt>执行账户</dt><dd>实盘 · {{ session ? 'UID ' + session.uid : '尚未连接' }}</dd></div>
        <div><dt>跟单对象（{{ preview.portfolioIds.length }}）</dt><dd>
          <span v-for="id in preview.portfolioIds" :key="id" class="review-portfolio">{{ portfolioName(id) }}
            <small v-if="portfolioName(id) !== id" class="review-id">{{ id }}</small></span>
        </dd></div>
        <div><dt>跟单方式</dt><dd>{{ preview.sizingMode === 'equityPercent' ? '定比跟单 · 每笔使用总权益的 ' + formatNumber(preview.amount) + '% 作保证金' :
          preview.sizingMode === 'margin' ? '定额跟单 · 每笔保证金 ' + formatNumber(preview.amount) + ' USDT' : '原策略 · 每笔合约价值 ' + formatNumber(preview.amount) + ' USDT' }}</dd></div>
        <div v-if="session"><dt>当前合约可用余额</dt><dd>{{ funds.state === 'ready' ? formatNumber(funds.available) + ' USDT' : '待读取' }}</dd></div>
        <div v-if="preview.sizingMode === 'equityPercent' && equity"><dt>当前合约账户总权益</dt><dd>{{ formatNumber(equity.equity) }} USDT
          <small class="review-id">{{ formatTradeTime(equity.time) }} UTC+8</small></dd></div>
        <div><dt>杠杆</dt><dd>
          <template v-if="preview.leverage === 'max'">默认最高档</template>
          <template v-else-if="typeof preview.leverage === 'number'">目标 {{ preview.leverage }} 倍，可用上限较低时自动降低</template>
          <template v-else-if="preview.leverage">
            按交易对最高杠杆匹配，未设置的档位使用最高可用杠杆。
            <small v-if="previewTierSummary" class="review-id">{{ previewTierSummary }}，实际按可用上限封顶。</small>
          </template>
          <template v-else>沿用交易对当前杠杆</template>
        </dd></div>
        <div v-if="previewEstimate?.margin != null"><dt>每笔预计初始保证金</dt><dd>约 {{ formatNumber(previewEstimate.margin) }} USDT</dd></div>
        <div v-if="previewEstimate?.notional != null"><dt>每笔预计合约价值</dt><dd>约 {{ formatNumber(previewEstimate.notional) }} USDT
          <small v-if="preview.sizingMode !== 'notional'" class="review-id">按设置倍数估算</small></dd></div>
        <div><dt>已有仓位时</dt><dd>{{ preview.manualPositionPolicy === 'add' ? '自动加仓' : '跳过' }}
          <small v-if="preview.manualPositionPolicy === 'add'" class="review-id">仅对本平台手动开的同向仓位加仓，整个仓位共用杠杆。</small></dd></div>
        <div><dt>跟单开仓方式</dt><dd>{{ preview.repeat === 'first' ? '首笔' : '自动加仓，最多开仓 ' + preview.maxEntries + ' 次（含首笔）' }}</dd></div>
        <div><dt>同时持仓上限</dt><dd>{{ preview.maxPositions }} 个交易对</dd></div>
        <div><dt>单仓止损</dt><dd>跟单仓位浮亏 {{ formatNumber(preview.stopLoss) }} USDT 时触发</dd></div>
      </dl>
      <p v-if="preview.sizingMode === 'equityPercent'" class="dialog-description">每次开仓或加仓使用当时的账户总权益重新计算。{{ !session ? '连接账户后可查看金额估算。' : '' }}</p>
      <p v-if="preview.sizingMode === 'equityPercent' && equityLoading" class="ticket-hint" role="status">正在读取账户总权益…</p>
      <p v-if="preview.sizingMode === 'equityPercent' && equityError" class="notice error" role="alert">{{ equityError }} <button type="button" class="text-button" @click="refreshEquity">重试</button></p>
      <p v-if="previewFundingIssue" class="notice warning" role="status">{{ previewFundingIssue }}</p>
      <p class="dialog-description">{{ session ? '确认后服务端将自动执行新信号，关闭页面后继续运行。' : '连接账户后需再次预览并确认启动。' }}</p>
      <div class="dialog-actions">
        <button class="btn" @click="preview = null">返回修改</button>
        <button v-if="session" class="btn primary" :disabled="busy || !synchronized || status?.enabled || awaitingEquity || !!previewFundingIssue" @click="submit('start')">确认启动实盘跟单</button>
        <button v-else class="btn primary" @click="connectForStart">连接账户</button>
      </div>
    </WorkspaceDialog>
  </div>
</template>

<style scoped>
.copy-mode-group { display: grid; gap: 7px; min-width: 0; padding: 0; margin: 0; border: 0; }
.copy-modes {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: #edf2ee;
}
.copy-mode { position: relative; flex: 1 0 auto; }
.copy-mode input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  opacity: 0;
}
.copy-mode span {
  display: grid;
  place-items: center;
  min-height: 36px;
  padding: 4px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.copy-mode input:checked + span {
  border-color: #abc7b7;
  color: var(--green);
  background: white;
  box-shadow: 0 1px 2px #153b3210;
}
.copy-mode input:not(:disabled):not(:checked) + span:hover { color: var(--green); background: #f7faf7; }
.copy-mode input:focus-visible + span { outline: 2px solid var(--green); outline-offset: -2px; }
.copy-mode input:disabled + span { cursor: default; }
.copy-advanced { min-width: 0; border: 1px solid var(--line); border-radius: 8px; }
.copy-advanced summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  font-size: 13px;
  list-style: none;
  cursor: pointer;
}
.copy-advanced summary::-webkit-details-marker { display: none; }
.copy-advanced summary:focus-visible { outline-offset: -2px; }
.copy-advanced-values { flex: 1; text-align: end; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.copy-advanced-arrow { flex: 0 0 14px; height: 14px; color: var(--green); }
.copy-advanced[open] .copy-advanced-arrow { transform: rotate(180deg); }
.copy-advanced-body { display: grid; gap: 13px; padding: 12px; border-top: 1px solid var(--line); }
.copy-advanced-body :deep(.copy-setting) { display: grid; grid-template-columns: minmax(7rem, 1fr) minmax(0, 2fr); align-items: center; gap: 8px; }
.copy-advanced-body :deep(.copy-setting select:disabled) { background: #f0f3f0; cursor: not-allowed; opacity: .55; }
.copy-choice-group { margin: 0; padding: 0; border: 0; min-width: 0; }
.copy-choice-group legend { margin-bottom: 6px; padding: 0; font-size: 12px; font-weight: 600; color: #4c6257; }
.copy-choices { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.copy-choice { display: inline-flex; align-items: center; max-width: 100%; gap: 7px; border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px; min-height: 36px; font-size: 13px; cursor: pointer; }
.copy-choice span { overflow-wrap: anywhere; }
.copy-choice:has(input:checked) { border-color: #80ad9c; background: #eff7f2; color: #185840; }
.copy-choice input { margin: 0; accent-color: var(--green); }
.copy-choice-group small { display: block; margin-top: 5px; font-size: 12px; color: var(--muted); }
.margin-hint { margin-top: -5px; font-size: 12px; line-height: 1.55; color: var(--muted); }
.margin-hint strong { color: var(--ink); }
.review-portfolio { display: block; }
.review-portfolio + .review-portfolio { margin-top: 5px; }
.review-id { display: block; color: var(--muted); font-size: 11px; }
.copy-fields { display: grid; gap: 13px; min-width: 0; border: 0; padding: 0; margin: 0; }
.copy-fields .field small { color: var(--muted); font-size: 12px; line-height: 1.55; font-weight: 400; }
.copy-status { display: grid; min-width: 0; gap: 12px; padding: 0 var(--order-gutter, 21px) 20px; }
.copy-status > .notice { margin: 0; }
.copy-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 14px;
  padding: 12px 14px;
  border-radius: 8px;
  background: #f2f5f2;
}
.copy-state.is-running { background: #edf5ee; }
.copy-state-main { min-width: 0; }
.copy-status h3 { margin: 0; font-size: 14px; }
.copy-state .copy-state-title { display: flex; align-items: center; gap: 6px; font-size: 16px; }
.copy-state-title svg { width: 16px; height: 16px; color: var(--green); }
.copy-state-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.copy-state-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.copy-state-actions .btn { padding-inline: 9px; }
.copy-state-actions .btn svg { width: 14px; height: 14px; }
.copy-managed { container-type: inline-size; display: grid; gap: 8px; padding-top: 3px; }
.copy-managed-leaders { display: flex; flex-wrap: wrap; gap: 2px 8px; font-size: 12px; overflow-wrap: anywhere; }
.copy-managed-leaders span, .copy-overview dt { color: var(--muted); }
.copy-overview {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px 9px;
}
.copy-overview dt { font-size: 12px; }
.copy-overview dd { margin-top: 3px; font-size: 13px; font-weight: 630; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.copy-policy summary {
  display: flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
  padding: 4px 0;
  color: var(--green);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
}
.copy-policy summary::-webkit-details-marker { display: none; }
.copy-policy summary svg { width: 13px; height: 13px; }
.copy-policy[open] summary svg { transform: rotate(180deg); }
.copy-policy .copy-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 5px; }
.copy-tiers { grid-column: 1 / -1; }
.copy-positions { display: grid; gap: 5px; padding-top: 11px; border-top: 1px solid var(--line); }
.copy-positions h3 span { margin-left: 3px; color: var(--muted); }
.copy-positions table { min-width: 360px; }
.copy-events {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: min(55dvh, 28rem);
  overflow: auto;
  overscroll-behavior: contain;
}
.copy-events li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: baseline;
  gap: 3px 12px;
  padding: 9px 4px 9px 0;
  border-top: 1px solid var(--line);
  font-size: 13px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.copy-events time { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
@container (max-width: 430px) {
  .copy-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 480px) {
  .copy-events li { grid-template-columns: minmax(0, 1fr); }
}
</style>
