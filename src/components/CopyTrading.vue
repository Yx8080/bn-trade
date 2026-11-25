<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Refresh, Tickets } from '@element-plus/icons-vue'
import { isAppLeverage } from '../../shared/leverage.js'
import { getCopyEquity, getCopyStatus, updateCopyStatus, type BoundSession, type CopyConfig, type CopyStatus, type Environment } from '../futures'
import type { OpeningFunds } from '../opening-funds'
import type { LeadPortfolio } from '../portfolios'
import { formatNumber, formatTradeTime } from '../trades'
import WorkspaceDialog from './WorkspaceDialog.vue'
import CopyLeverageControl from './CopyLeverageControl.vue'
import OpeningBalance from './OpeningBalance.vue'

const props = defineProps<{ entries: LeadPortfolio[]; environment: Environment; session: BoundSession | null; token: string; funds: OpeningFunds }>()
const savedDraft = defineModel<CopyConfig | null>('draft', { required: true })
const emit = defineEmits<{ connect: []; edit: []; refresh: [] }>()
function copyPlan(plan: CopyConfig): CopyConfig {
  return { ...plan, portfolioIds: [...plan.portfolioIds] }
}
const draft = ref<CopyConfig>(savedDraft.value ? copyPlan(savedDraft.value) : {
  portfolioIds: props.entries.slice(0, 1).map(entry => entry.id), sizingMode: 'margin', amount: 0, leverage: 1, repeat: 'fixed',
  maxEntries: 2, maxPositions: 2, stopLoss: 5,
})
const status = ref<CopyStatus | null>(null)
const statusError = ref('')
const actionError = ref('')
const busy = ref(false)
const checking = ref(false)
const preview = ref<CopyConfig | null>(null)
const equity = ref<Awaited<ReturnType<typeof getCopyEquity>> | null>(null)
const equityLoading = ref(false)
const equityError = ref('')
const locked = computed(() => Boolean(status.value?.enabled || status.value?.pending || status.value?.positions.length))
const synchronized = computed(() => Boolean(status.value && !statusError.value))
const accountLabel = computed(() => props.environment === 'live' ? '实盘' : '测试网')
const fixed = computed(() => draft.value.repeat === 'fixed')
const config = computed<CopyConfig>(() => ({ ...draft.value, maxEntries: fixed.value ? draft.value.maxEntries : 1 }))
const portfolios = computed(() => {
  const extra = draft.value.portfolioIds.filter(id => !props.entries.some(entry => entry.id === id))
  return [...props.entries, ...extra.map(id => ({ id, name: id }))]
})
const estimate = computed(() => sizeEstimate(draft.value))
const previewEstimate = computed(() => preview.value ? sizeEstimate(preview.value) : null)
const percentMode = computed(() => draft.value.sizingMode === 'equityPercent')
const amountInput = computed({
  get: () => draft.value.amount || '',
  set: (value: number | string) => { draft.value.amount = Number(value) },
})
const legacyLeverage = computed(() => locked.value && !isAppLeverage(draft.value.leverage))
const awaitingEquity = computed(() => !!props.session && preview.value?.sizingMode === 'equityPercent' && !equity.value)
const fundingIssue = computed(() => checkFunding(estimate.value.margin))
const previewFundingIssue = computed(() => checkFunding(previewEstimate.value?.margin ?? null))
const positionCount = computed(() => status.value?.positions.length ?? 0)
const stateLabel = computed(() => {
  if (!props.session) return '访客预览'
  if (!synchronized.value) return statusError.value ? '状态待核实' : '正在读取'
  if (status.value?.enabled) return '跟单中'
  if (locked.value) return '已暂停开仓'
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
  const leverage = isAppLeverage(plan.leverage) || legacyLeverage.value ? plan.leverage : null
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
function prepare() {
  actionError.value = ''
  const plan = config.value
  if (!plan.portfolioIds.length || plan.portfolioIds.some(id => !/^\d{1,30}$/.test(id))) {
    actionError.value = '请至少勾选一个有效的带单组合。'
  } else if (!legacyLeverage.value && !isAppLeverage(plan.leverage)) {
    actionError.value = '杠杆倍数须为正整数。'
  } else if (!validMoney(plan.amount) || !validMoney(plan.stopLoss)) {
    actionError.value = '每笔投入和止损金额须大于零，最多支持 8 位小数。'
  } else if (plan.sizingMode === 'equityPercent' && plan.amount > 100) {
    actionError.value = '每笔保证金占总权益的比例最多为 100%。'
  } else if (fundingIssue.value) {
    actionError.value = fundingIssue.value
  } else if (![plan.maxEntries, plan.maxPositions].every(n => Number.isInteger(n) && n >= 1 && n <= 100)) {
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
    && left.sizingMode === right.sizingMode && left.amount === right.amount
    && left.stopLoss === right.stopLoss && left.leverage === right.leverage
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
    <div class="futures-form-panel">
      <form aria-label="跟单设置" class="ticket-form" @submit.prevent="prepare">
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
          <fieldset class="copy-choice-group">
            <legend>每笔开仓方式</legend>
            <div class="copy-choices">
              <label class="copy-choice">
                <input type="radio" name="copy-sizing" value="margin" :checked="draft.sizingMode === 'margin'" @change="setSizingMode('margin')" />固定保证金
              </label>
              <label class="copy-choice">
                <input type="radio" name="copy-sizing" value="equityPercent" :checked="percentMode" @change="setSizingMode('equityPercent')" />按总权益百分比
              </label>
              <label v-if="status?.config?.sizingMode === 'notional'" class="copy-choice">
                <input type="radio" name="copy-sizing" value="notional" :checked="draft.sizingMode === 'notional'" @change="setSizingMode('notional')" />原策略合约价值
              </label>
            </div>
          </fieldset>
        </fieldset>
        <OpeningBalance :funds="funds" :shortcuts="draft.sizingMode === 'margin' && !locked && !busy"
          @select="draft.amount = $event" @refresh="refreshFunds" @connect="emit('connect')">
          <label class="field">
            <span>{{ percentMode ? '每笔保证金占总权益（%）' : draft.sizingMode === 'margin' ? '每笔初始保证金（USDT）' : '每笔合约价值（USDT）' }}</span>
            <input v-model.number="amountInput" type="number" step="0.00000001" min="0.00000001"
              :max="percentMode ? 100 : undefined" :disabled="locked || busy" :aria-describedby="session && funds.state === 'ready' && fundingIssue ? 'copy-funding-issue' : undefined"
              :placeholder="percentMode ? '输入总权益比例' : draft.sizingMode === 'margin' ? '输入每笔保证金' : '输入合约价值'" required />
          </label>
        </OpeningBalance>
        <p v-if="session && funds.state === 'ready' && fundingIssue" id="copy-funding-issue" class="notice warning" role="status">{{ fundingIssue }}</p>
        <CopyLeverageControl v-model="draft.leverage" :disabled="locked || busy" :notional="estimate.notional"
          :session="session" :token="token" />
        <fieldset class="copy-fields" :disabled="locked || busy">
          <p v-if="percentMode || estimate.notional != null" class="margin-hint" aria-live="polite">
            <span v-if="percentMode">每笔开仓或加仓时，按当时的合约账户总权益（含未实现盈亏）重新计算保证金。</span>
            <span v-if="percentMode && equity">当前总权益 {{ formatNumber(equity.equity) }} USDT。</span>
            <span v-if="estimate.margin != null && estimate.notional != null">预计初始保证金 <strong>{{ formatNumber(estimate.margin) }} USDT</strong> × {{ draft.leverage }} 倍杠杆，合约价值约 <strong>{{ formatNumber(estimate.notional) }} USDT</strong>，未计手续费。</span>
            <span v-else-if="percentMode && !session">连接账户后可预估每笔保证金与合约价值。</span>
            <span v-else-if="draft.sizingMode === 'notional' && draft.leverage == null">原策略按每笔合约价值下单，实际初始保证金取决于交易对的杠杆倍数。</span>
          </p>
          <p v-if="percentMode && equityError" class="notice warning" role="status">{{ equityError }} <button type="button" class="text-button" @click="refreshEquity">重试</button></p>
          <fieldset class="copy-choice-group">
            <legend>带单员再次同向开仓时</legend>
            <div class="copy-choices">
              <label class="copy-choice">
                <input v-model="draft.repeat" name="copy-repeat" type="radio" value="first" />只跟首笔
              </label>
              <label class="copy-choice">
                <input v-model="draft.repeat" name="copy-repeat" type="radio" value="fixed" />按相同规则加仓
              </label>
            </div>
          </fieldset>
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
          <label class="field">
            <span>单仓止损金额（USDT）</span>
            <input v-model.number="draft.stopLoss" type="number" step="0.00000001" min="0.00000001" required />
            <small>服务端按标记价格检查整仓浮亏，触及阈值后市价平仓。跳价、滑点或服务中断可能使实际亏损超过设定金额。</small>
          </label>
        </fieldset>
        <p class="ticket-hint">启动后仅跟随新成交。同一交易对由先开仓的组合独立管理，持仓期间跳过其他组合在该交易对的信号。该组合首次减仓或平仓时，跟单仓位整仓退出。请使用单向持仓模式，并为策略单独保留交易对。</p>
        <p v-if="locked" class="ticket-hint">{{ status?.enabled ? '策略运行中。暂停开仓后，待跟单仓位和待核实订单全部结清即可更改设置。' : '仓位或订单仍在管理中。可按原设置恢复跟单，结清后可修改参数。' }}</p>
        <p v-if="actionError" class="notice error" role="alert">{{ actionError }}</p>
        <button v-if="status?.enabled" type="button" class="btn" :disabled="busy || !synchronized" @click="submit('pause')">
          {{ busy ? '处理中…' : '暂停新开仓' }}
        </button>
        <button v-else type="submit" class="btn primary" :disabled="busy || !validMoney(draft.amount) || !draft.portfolioIds.length || !!fundingIssue || (!!session && !synchronized)">
          {{ busy ? '处理中…' : '预览跟单设置' }}
        </button>
        <p v-if="status?.enabled || locked" class="ticket-hint">暂停后，服务端继续处理已有跟单仓位的止损和跟随平仓。</p>
      </form>
    </div>
    <section class="copy-status">
      <div class="ledger-heading">
        <div class="section-title"><Tickets /><h2>执行状态</h2></div>
        <button v-if="session" class="btn small" :disabled="checking || busy" @click="refresh"><Refresh />刷新</button>
      </div>
      <div class="copy-status-body">
        <div class="copy-state"><strong>{{ stateLabel }}</strong><span>{{ session ? session.name + ' · ' + accountLabel : '连接账户后可启动跟单' }}</span></div>
        <p v-if="statusError || status?.error" class="notice warning" role="status">{{ statusError || status?.error }}</p>
        <template v-if="status">
          <p v-if="status.pending" class="notice warning" role="status">订单待核实 · {{ portfolioName(status.pending.portfolioId) }} · {{ status.pending.symbol }} · {{ status.pending.clientOrderId }}</p>
          <p v-if="status.lastCheck" class="ticket-hint">服务端最近检查 {{ formatTradeTime(status.lastCheck) }} UTC+8</p>
          <h3>跟单持仓 <span>{{ positionCount }}</span></h3>
          <div v-if="positionCount" class="table-scroll">
            <table><thead><tr><th>交易对 / 方向</th><th>带单组合</th><th class="numeric">数量</th><th class="numeric">开仓均价</th><th class="numeric">开仓次数</th></tr></thead>
              <tbody><tr v-for="row in status.positions" :key="row.symbol">
                <td>{{ row.symbol }} · {{ row.direction === 'LONG' ? '多' : '空' }}</td>
                <td>{{ portfolioName(row.portfolioId) }}</td>
                <td class="numeric">{{ formatNumber(row.quantity) }}</td><td class="numeric">{{ formatNumber(row.entryPrice) }}</td><td class="numeric">{{ row.entries }}</td>
              </tr></tbody>
            </table>
          </div>
          <p v-else class="ticket-hint">暂无跟单持仓。</p>
          <h3>执行记录</h3>
          <ul v-if="status.events.length" class="copy-events">
            <li v-for="(event, i) in status.events" :key="i"><time>{{ formatTradeTime(event.time) }}</time> {{ event.message }}</li>
          </ul>
          <p v-else class="ticket-hint">暂无执行记录。</p>
        </template>
      </div>
    </section>
    <WorkspaceDialog v-if="preview" :title="session ? '确认启动' + accountLabel + '跟单' : '跟单设置预览'" @close="preview = null">
      <dl class="order-review">
        <div><dt>执行账户</dt><dd>{{ accountLabel }} · {{ session ? 'UID ' + session.uid : '尚未连接' }}</dd></div>
        <div><dt>跟单对象（{{ preview.portfolioIds.length }}）</dt><dd>
          <span v-for="id in preview.portfolioIds" :key="id" class="review-portfolio">{{ portfolioName(id) }}
            <small v-if="portfolioName(id) !== id" class="review-id">{{ id }}</small></span>
        </dd></div>
        <div><dt>每笔开仓方式</dt><dd>{{ preview.sizingMode === 'equityPercent' ? '总权益的 ' + formatNumber(preview.amount) + '% 作保证金' :
          preview.sizingMode === 'margin' ? '固定保证金 ' + formatNumber(preview.amount) + ' USDT' : '固定合约价值 ' + formatNumber(preview.amount) + ' USDT' }}</dd></div>
        <div v-if="session"><dt>当前合约可用余额</dt><dd>{{ funds.state === 'ready' ? formatNumber(funds.available) + ' USDT' : '待读取' }}</dd></div>
        <div v-if="preview.sizingMode === 'equityPercent' && equity"><dt>当前合约账户总权益</dt><dd>{{ formatNumber(equity.equity) }} USDT
          <small class="review-id">{{ formatTradeTime(equity.time) }} UTC+8</small></dd></div>
        <div><dt>跟单杠杆</dt><dd>{{ preview.leverage ? preview.leverage + ' 倍' : '沿用交易对当前杠杆' }}</dd></div>
        <div v-if="previewEstimate?.margin != null"><dt>每笔预计初始保证金</dt><dd>约 {{ formatNumber(previewEstimate.margin) }} USDT</dd></div>
        <div v-if="previewEstimate?.notional != null"><dt>每笔预计合约价值</dt><dd>约 {{ formatNumber(previewEstimate.notional) }} USDT</dd></div>
        <div><dt>同向加仓</dt><dd>{{ preview.repeat === 'first' ? '只跟首笔' : '按相同规则加仓，最多开仓 ' + preview.maxEntries + ' 次（含首笔）' }}</dd></div>
        <div><dt>同时持仓上限</dt><dd>{{ preview.maxPositions }} 个交易对</dd></div>
        <div><dt>单仓止损</dt><dd>浮亏 {{ formatNumber(preview.stopLoss) }} USDT 时触发</dd></div>
      </dl>
      <p v-if="preview.sizingMode === 'equityPercent'" class="dialog-description">每次开仓或加仓使用当时的账户总权益重新计算。{{ !session ? '连接账户后可查看金额估算。' : '' }}</p>
      <p v-if="preview.sizingMode === 'equityPercent' && equityLoading" class="ticket-hint" role="status">正在读取账户总权益…</p>
      <p v-if="preview.sizingMode === 'equityPercent' && equityError" class="notice error" role="alert">{{ equityError }} <button type="button" class="text-button" @click="refreshEquity">重试</button></p>
      <p v-if="previewFundingIssue" class="notice warning" role="status">{{ previewFundingIssue }}</p>
      <p class="dialog-description">{{ session ? '确认后服务端将自动执行新信号，关闭页面后继续运行。' : '连接账户后需再次预览并确认启动。' }}</p>
      <div class="dialog-actions">
        <button class="btn" @click="preview = null">返回修改</button>
        <button v-if="session" class="btn primary" :disabled="busy || !synchronized || status?.enabled || awaitingEquity || !!previewFundingIssue" @click="submit('start')">确认启动{{ accountLabel }}跟单</button>
        <button v-else class="btn primary" @click="connectForStart">连接账户</button>
      </div>
    </WorkspaceDialog>
  </div>
</template>

<style scoped>
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
.copy-status { min-width: 0; border-top: 1px solid var(--line); }
.copy-status-body { display: grid; gap: 10px; padding: 0 20px 20px; }
.copy-state { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; padding: 14px; background: #eff5ef; border-radius: 8px; }
.copy-state span, .copy-events time { font-size: 12px; color: var(--muted); }
.copy-status h3 { margin: 8px 0 0; font-size: 14px; }
.copy-status h3 span { margin-left: 5px; color: var(--muted); }
.copy-events { list-style: none; padding: 0; margin: 0; max-height: 320px; overflow: auto; }
.copy-events li { padding: 8px 0; border-top: 1px solid var(--line); font-size: 13px; overflow-wrap: anywhere; }
.copy-events time { display: block; margin-bottom: 3px; }
.copy-status table { min-width: 360px; }
@media (max-width: 480px) { .copy-status-body { padding-inline: 14px; } }
</style>
