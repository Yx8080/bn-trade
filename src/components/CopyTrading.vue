<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Operation, Refresh, Tickets } from '@element-plus/icons-vue'
import { getCopyStatus, updateCopyStatus, type CopyConfig, type CopyStatus, type FuturesSession } from '../futures'
import type { LeadPortfolio } from '../portfolios'
import { formatNumber, formatTradeTime } from '../trades'
import WorkspaceDialog from './WorkspaceDialog.vue'

const props = defineProps<{ entries: LeadPortfolio[]; session: FuturesSession | null; token: string }>()
const savedDraft = defineModel<CopyConfig | null>('draft', { required: true })
const emit = defineEmits<{ connect: []; edit: [] }>()
const draft = ref<CopyConfig>({ ...(savedDraft.value ?? {
  portfolioId: props.entries[0]?.id ?? '', amount: 100, repeat: 'fixed',
  maxEntries: 2, maxPositions: 2, stopLoss: 5,
}) })
const status = ref<CopyStatus | null>(null)
const statusError = ref('')
const actionError = ref('')
const busy = ref(false)
const checking = ref(false)
const preview = ref<CopyConfig | null>(null)
const locked = computed(() => Boolean(status.value?.enabled || status.value?.pending || status.value?.positions.length))
const synchronized = computed(() => Boolean(status.value && !statusError.value))
const accountLabel = computed(() => props.session?.environment === 'live' ? '实盘' : '测试网')
const fixed = computed(() => draft.value.repeat === 'fixed')
const config = computed<CopyConfig>(() => ({ ...draft.value, maxEntries: fixed.value ? draft.value.maxEntries : 1 }))
const externalId = computed(() => draft.value.portfolioId && !props.entries.some(entry => entry.id === draft.value.portfolioId))
const positionCount = computed(() => status.value?.positions.length ?? 0)
const stateLabel = computed(() => {
  if (!props.session) return '访客预览'
  if (!synchronized.value) return statusError.value ? '状态待核实' : '正在读取'
  if (status.value?.enabled) return '跟单中'
  if (locked.value) return '已暂停开仓'
  return status.value?.config ? '已暂停' : '未启动'
})
let dirty = Boolean(savedDraft.value)
let controller: AbortController | undefined
let timer: number | undefined

function portfolioName(id: string) {
  return props.entries.find(entry => entry.id === id)?.name || id
}
function markEdited() {
  dirty = true
  savedDraft.value = { ...draft.value }
  actionError.value = ''
}
watch(() => props.entries, (entries, previous) => {
  if (locked.value || busy.value) return
  const added = entries.find(entry => !previous.some(old => old.id === entry.id))
  if (added || !entries.some(entry => entry.id === draft.value.portfolioId)) {
    draft.value.portfolioId = added?.id ?? entries[0]?.id ?? ''
    markEdited()
  }
})
function applyStatus(result: CopyStatus) {
  status.value = result
  statusError.value = ''
  if (locked.value) {
    dirty = false
    savedDraft.value = null
  }
  if (result.config && (locked.value || !dirty)) draft.value = { ...result.config }
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
onUnmounted(stopRequest)

function validMoney(value: number) {
  return Number.isFinite(value) && value > 0 && Number(value.toFixed(8)) === value
    && Number.isSafeInteger(Math.round(value * 1e8))
}
function prepare() {
  actionError.value = ''
  const plan = config.value
  if (!/^\d{1,30}$/.test(plan.portfolioId)) {
    actionError.value = '请选择有效的带单组合，组合 ID 应为不超过 30 位的数字。'
  } else if (!validMoney(plan.amount) || !validMoney(plan.stopLoss)) {
    actionError.value = '跟单金额和止损金额须大于零，最多支持 8 位小数。'
  } else if (![plan.maxEntries, plan.maxPositions].every(n => Number.isInteger(n) && n >= 1 && n <= 100)) {
    actionError.value = '开仓次数和同时持仓数须为 1 至 100 的整数。'
  } else if (!busy.value && !status.value?.enabled) {
    preview.value = { ...plan }
  }
}
function connectForStart() {
  savedDraft.value = { ...draft.value }
  preview.value = null
  emit('connect')
}
function matchesConfig(left: CopyConfig, right: CopyConfig | null) {
  return right != null && (Object.keys(left) as (keyof CopyConfig)[]).every(key => left[key] === right[key])
}
async function submit(action: 'start' | 'pause') {
  const session = props.session
  if (!session || busy.value || !synchronized.value) return
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
    dirty = false
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
  <div class="trading-grid copy-grid">
    <section class="panel">
      <div class="ledger-heading">
        <div class="section-title"><Operation /><h2>跟单设置</h2></div>
        <span v-if="session" class="env" :class="{ live: session.environment === 'live' }">{{ accountLabel }}</span>
      </div>
      <form class="ticket-form" @submit.prevent="prepare" @input="markEdited" @change="markEdited">
        <div class="copy-picker">
          <label class="field">
            <span>带单组合</span>
            <select v-model="draft.portfolioId" :disabled="locked || busy" required>
              <option v-if="!entries.length && !externalId" value="">请先添加组合</option>
              <option v-if="externalId" :value="draft.portfolioId">{{ draft.portfolioId }}</option>
              <option v-for="entry in entries" :key="entry.id" :value="entry.id">{{ entry.name || entry.id }}</option>
            </select>
          </label>
          <button type="button" class="btn" @click="emit('edit')">添加组合</button>
        </div>
        <fieldset class="copy-fields" :disabled="locked || busy">
          <label class="field">
            <span>每次开仓名义金额（USDT）</span>
            <input v-model.number="draft.amount" type="number" step="0.00000001" min="0.00000001" required />
            <small>每次下单的合约价值。实际占用保证金取决于账户杠杆。</small>
          </label>
          <label class="field">
            <span>带单员再次同向开仓时</span>
            <select v-model="draft.repeat">
              <option value="first">只跟首笔</option><option value="fixed">按固定金额加仓</option>
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
              <small>按交易对计数</small>
            </label>
          </div>
          <label class="field">
            <span>单仓止损金额（USDT）</span>
            <input v-model.number="draft.stopLoss" type="number" step="0.00000001" min="0.00000001" required />
            <small>服务端按标记价格检查整仓浮亏，触及阈值后市价平仓。跳价、滑点或服务中断可能使实际亏损超过设定金额。</small>
          </label>
        </fieldset>
        <p class="ticket-hint">每个账户环境可跟一个组合。使用单向持仓模式，跟单交易对请留给策略独立管理。启动后仅跟随新成交。带单员首次减仓或平仓时，策略对应的跟单仓位将整仓退出。</p>
        <p v-if="locked" class="ticket-hint">{{ status?.enabled ? '策略运行中。暂停开仓后，待跟单仓位和待核实订单全部结清即可更改设置。' : '仓位或订单仍在管理中。可按原设置恢复跟单，结清后可修改参数。' }}</p>
        <p v-if="actionError" class="notice error" role="alert">{{ actionError }}</p>
        <button v-if="status?.enabled" type="button" class="btn" :disabled="busy || !synchronized" @click="submit('pause')">
          {{ busy ? '处理中…' : '暂停新开仓' }}
        </button>
        <button v-else type="submit" class="btn primary" :disabled="busy || !draft.portfolioId || (!!session && !synchronized)">
          {{ busy ? '处理中…' : '预览跟单设置' }}
        </button>
        <p v-if="status?.enabled || locked" class="ticket-hint">暂停后，服务端继续处理已有跟单仓位的止损和跟随平仓。</p>
      </form>
    </section>
    <section class="panel copy-status">
      <div class="ledger-heading">
        <div class="section-title"><Tickets /><h2>执行状态</h2></div>
        <button v-if="session" class="btn small" :disabled="checking || busy" @click="refresh"><Refresh />刷新</button>
      </div>
      <div class="copy-status-body">
        <div class="copy-state"><strong>{{ stateLabel }}</strong><span>{{ session ? session.name + ' · ' + accountLabel : '连接账户后可启动跟单' }}</span></div>
        <p v-if="statusError || status?.error" class="notice warning" role="status">{{ statusError || status?.error }}</p>
        <template v-if="status">
          <p v-if="status.pending" class="notice warning" role="status">订单待核实 · {{ status.pending.symbol }} · {{ status.pending.clientOrderId }}</p>
          <p v-if="status.lastCheck" class="ticket-hint">服务端最近检查 {{ formatTradeTime(status.lastCheck) }} UTC+8</p>
          <h3>跟单持仓 <span>{{ positionCount }}</span></h3>
          <div v-if="positionCount" class="table-scroll">
            <table><thead><tr><th>交易对 / 方向</th><th class="numeric">数量</th><th class="numeric">开仓均价</th><th class="numeric">开仓次数</th></tr></thead>
              <tbody><tr v-for="row in status.positions" :key="row.symbol">
                <td>{{ row.symbol }} · {{ row.direction === 'LONG' ? '多' : '空' }}</td>
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
        <div><dt>执行账户</dt><dd>{{ session ? session.name + ' · ' + accountLabel : '访客 · 尚未连接' }}
          <small v-if="session && session.id !== session.name" class="review-id">{{ session.id }}</small></dd></div>
        <div><dt>带单组合</dt><dd>{{ portfolioName(preview.portfolioId) }}
          <small v-if="portfolioName(preview.portfolioId) !== preview.portfolioId" class="review-id">{{ preview.portfolioId }}</small></dd></div>
        <div><dt>每次名义金额</dt><dd>{{ formatNumber(preview.amount) }} USDT</dd></div>
        <div><dt>同向加仓</dt><dd>{{ preview.repeat === 'first' ? '只跟首笔' : '每次固定金额，最多开仓 ' + preview.maxEntries + ' 次（含首笔）' }}</dd></div>
        <div><dt>同时持仓上限</dt><dd>{{ preview.maxPositions }} 个交易对</dd></div>
        <div><dt>单仓止损</dt><dd>浮亏 {{ formatNumber(preview.stopLoss) }} USDT 时触发</dd></div>
      </dl>
      <p class="dialog-description">{{ session ? '确认后服务端将自动执行新信号，关闭页面后继续运行。' : '连接账户后需再次预览并确认启动。' }}</p>
      <div class="dialog-actions">
        <button class="btn" @click="preview = null">返回修改</button>
        <button v-if="session" class="btn primary" :disabled="busy || !synchronized || status?.enabled" @click="submit('start')">确认启动{{ accountLabel }}跟单</button>
        <button v-else class="btn primary" @click="connectForStart">连接账户</button>
      </div>
    </WorkspaceDialog>
  </div>
</template>

<style scoped>
.copy-picker { display: flex; align-items: end; gap: 8px; }
.copy-picker .field { flex: 1; }
.review-id { display: block; color: var(--muted); font-size: 11px; }
.copy-fields { display: grid; gap: 13px; min-width: 0; border: 0; padding: 0; margin: 0; }
.copy-fields .field small { color: var(--muted); font-size: 12px; line-height: 1.55; font-weight: 400; }
.copy-status { min-width: 0; }
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
