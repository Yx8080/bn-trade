<script setup lang="ts">
import { computed, onUnmounted, ref, useId, watch } from 'vue'
import { closePosition, createClientOrderId, FuturesError, getClosePositionRules, lookupOrder,
  type ClosePositionRules, type FuturesSession, type OrderResult, type Position } from '../futures'
import { closePercentQuantity, closeQuantityIssue, closeQuantityPercent } from '../position-close'
import { pendingOrderKey, readPending, writePending, type PendingOrder } from './pendingOrder'
import WorkspaceDialog from './WorkspaceDialog.vue'

const props = defineProps<{ position: Position | null; session: FuturesSession; token: string }>()
const emit = defineEmits<{ close: []; refresh: [] }>()
const whole = ref(true)
const amount = ref('')
const percentId = useId()
const chosenPercent = ref<string | null>(null)
const retry = ref(0)
const rules = ref<ClosePositionRules>()
const rulesError = ref('')
const failure = ref('')
const changed = ref(false)
const submitting = ref(false)
const verificationDelayed = ref(false)
const receipt = ref<OrderResult | null>(null)
const key = computed(() => pendingOrderKey(props.session.id, props.session.environment, 'futures-close'))
const pending = ref<PendingOrder | null>(readPending(key.value))
const verificationStatus = computed(() => {
  if (!props.token) return '重新连接币安账户后将自动继续核实。'
  return verificationDelayed.value ? '暂未核实平仓结果，系统会自动重试。' : '正在向币安核实平仓结果…'
})
let active = true
onUnmounted(() => { active = false })

const available = computed(() => props.position?.quantity.replace(/^-/, '') ?? '')
const direction = computed(() => props.position?.quantity.startsWith('-') ? 'SHORT' : 'LONG')
const sideLabel = computed(() => direction.value === 'LONG' ? '平多' : '平空')
const quantity = computed(() => whole.value ? available.value : amount.value)
const percentInput = computed(() => chosenPercent.value ?? closeQuantityPercent(amount.value, available.value))
const percentIssue = computed(() => !whole.value && !!chosenPercent.value && !/^(?:[1-9]\d?|100)$/.test(chosenPercent.value))
const sizeIssue = computed(() => rules.value ? closeQuantityIssue(quantity.value, available.value, rules.value) : '')
const valid = computed(() => props.position && rules.value && !sizeIssue.value && !changed.value &&
  !submitting.value && !pending.value && !!props.token &&
  (props.position.positionSide === 'BOTH' || props.position.positionSide === direction.value))

watch(() => props.position, () => {
  whole.value = true
  amount.value = ''
  chosenPercent.value = null
  changed.value = false
  if (!pending.value) failure.value = ''
}, { flush: 'sync' })

watch([() => props.position, () => props.token, key, retry], async ([position, token], _, cleanup) => {
  rules.value = undefined
  rulesError.value = ''
  if (!position || !token || pending.value) return
  const controller = new AbortController()
  cleanup(() => controller.abort())
  try {
    const data = await getClosePositionRules(token, position.symbol, props.session.environment, controller.signal)
    if (!controller.signal.aborted) rules.value = data
  } catch (e) {
    if (!controller.signal.aborted) rulesError.value = e instanceof Error ? e.message : '暂时无法读取数量规则。'
  }
}, { immediate: true })

function setPending(order: PendingOrder | null) {
  writePending(key.value, order)
  pending.value = order
}
function setPercent(text: string) {
  chosenPercent.value = text.trim()
  amount.value = rules.value && !percentIssue.value
    ? closePercentQuantity(available.value, Number(chosenPercent.value), rules.value.stepSize) : ''
}
function editQuantity(event: Event) {
  chosenPercent.value = null
  amount.value = (event.target as HTMLInputElement).value.trim()
}
function close() {
  if (!submitting.value) emit('close')
}
function record(data: OrderResult) {
  const fillChanged = receipt.value?.executedQty !== data.executedQty
  const final = ['FILLED', 'EXPIRED', 'CANCELED', 'REJECTED', 'EXPIRED_IN_MATCH'].includes(data.status)
  receipt.value = data
  if (final) setPending(null)
  if (final || fillChanged) emit('refresh')
}

watch([pending, submitting, () => props.token], ([order, sending, token], _, cleanup) => {
  verificationDelayed.value = false
  if (!order || sending || !token) return
  const { symbol, clientOrderId } = order
  const controller = new AbortController()
  const { signal } = controller
  let timer: ReturnType<typeof setTimeout> | undefined
  let delay = 1_000
  cleanup(() => {
    controller.abort()
    clearTimeout(timer)
  })

  async function reconcile() {
    let wait = delay
    try {
      const data = await lookupOrder(token, symbol, clientOrderId, signal)
      if (signal.aborted) return
      if (data?.symbol !== symbol || data.clientOrderId !== clientOrderId || data.type !== 'MARKET' ||
        typeof data.status !== 'string' || typeof data.executedQty !== 'string' || typeof data.orderId !== 'string' ||
        (receipt.value && receipt.value.orderId !== data.orderId)) {
        throw Error('返回的订单信息与待核实的平仓单不一致。')
      }
      verificationDelayed.value = false
      record(data)
      if (!pending.value) {
        emit('close')
        return
      }
    } catch (e) {
      if (signal.aborted) return
      verificationDelayed.value = true
      if (e instanceof FuturesError && (e.status === 418 || e.status === 429)) wait = 60_000
    }
    delay = Math.min(wait * 2, 60_000)
    timer = setTimeout(reconcile, wait)
  }
  void reconcile()
}, { immediate: true })

async function submit() {
  const row = props.position
  if (!valid.value || !row) return
  const clientOrderId = createClientOrderId()
  const owner = key.value
  const input = { symbol: row.symbol, environment: props.session.environment, clientOrderId,
    positionSide: row.positionSide, direction: direction.value, quantity: quantity.value,
    expectedQuantity: available.value, expectedUpdateTime: row.updateTime } as const
  submitting.value = true
  failure.value = ''
  receipt.value = null
  setPending({ symbol: row.symbol, clientOrderId })
  try {
    const result = await closePosition(props.token, input)
    if (!active || owner !== key.value) return
    record(result)
    emit('close')
  } catch (e) {
    if (!active || owner !== key.value) return
    if (e instanceof FuturesError && e.code !== 'ORDER_UNKNOWN') {
      failure.value = e.message
      setPending(null)
      if (e.code === 'POSITION_CHANGED') {
        changed.value = true
        emit('refresh')
      }
    } else {
      emit('close')
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div v-if="pending && !submitting" class="receipt warning close-receipt" role="status">
    <strong>{{ pending.symbol }} · 平仓订单待核实</strong>
    <div>客户订单号 {{ pending.clientOrderId }}</div>
    <div v-if="receipt">{{ receipt.status }} · 已成交 {{ receipt.executedQty }}</div>
    <div>{{ verificationStatus }}</div>
  </div>
  <div v-else-if="receipt" class="receipt close-receipt" role="status">
    <strong>{{ receipt.symbol }} · 平仓回执</strong>
    <div>{{ receipt.status }} · 已成交 {{ receipt.executedQty }} · 订单号 {{ receipt.orderId }}</div>
    <button type="button" class="text-button" @click="receipt = null">收起</button>
  </div>
  <WorkspaceDialog v-if="position && pending && !submitting" title="上一笔平仓订单待核实" @close="close">
    <p class="dialog-description">{{ pending.symbol }} · 客户订单号 {{ pending.clientOrderId }}。</p>
    <p class="ticket-hint" role="status">{{ verificationStatus }}</p>
    <div class="dialog-actions">
      <button type="button" class="btn" @click="close">返回</button>
    </div>
  </WorkspaceDialog>
  <WorkspaceDialog v-if="position && (!pending || submitting)" title="市价平仓" @close="close">
    <div class="close-summary">
      <strong>{{ position.symbol }} · {{ sideLabel }}</strong>
      <span>{{ session.name }} · 实盘</span>
    </div>
    <div class="available-row"><span>可平仓位</span><strong>{{ available }} {{ rules?.baseAsset }}</strong></div>
    <div class="close-options" role="group" aria-label="平仓方式">
      <button type="button" :aria-pressed="whole" :disabled="submitting" @click="whole = true">全部平仓</button>
      <button type="button" :aria-pressed="!whole" :disabled="submitting" @click="whole = false">部分平仓</button>
    </div>
    <div v-if="!whole" class="partial-quantity">
      <label class="field"><span>平仓数量</span>
        <span class="input-unit"><input :value="amount" :disabled="submitting" inputmode="decimal" placeholder="输入数量" @input="editQuantity" /><b>{{ rules?.baseAsset }}</b></span>
      </label>
      <div class="field percent-field">
        <label :for="percentId">{{ chosenPercent === null && percentInput ? '仓位比例（约）' : '仓位比例' }}</label>
        <div class="close-presets">
          <span class="input-unit">
            <input :id="percentId" aria-label="仓位比例" :value="percentInput" :disabled="!rules || submitting" inputmode="numeric"
              placeholder="1–100" @input="setPercent(($event.target as HTMLInputElement).value)" /><b>%</b>
          </span>
          <button v-for="percent in [25, 50, 75]" :key="percent" type="button" class="btn"
            :aria-pressed="chosenPercent === String(percent)" :disabled="!rules || submitting" @click="setPercent(String(percent))">{{ percent }}%</button>
        </div>
      </div>
    </div>
    <p v-if="rulesError" class="notice warning" role="alert">{{ rulesError }}
      <button type="button" class="text-button" @click="retry++">重试</button>
    </p>
    <p v-else-if="!rules" class="ticket-hint" role="status">正在读取平仓数量规则…</p>
    <p v-else-if="percentIssue" class="notice warning" role="alert">请输入 1 至 100 的整数比例。</p>
    <p v-else-if="sizeIssue && quantity" class="notice warning" role="alert">{{ sizeIssue }}</p>
    <div v-else-if="whole" class="available-row"><span>本次市价平仓</span><strong>{{ quantity }} {{ rules.baseAsset }}</strong></div>
    <p v-if="failure" class="notice error" role="alert">{{ failure }}</p>
    <div class="dialog-actions">
      <button type="button" class="btn" :disabled="submitting" @click="close">{{ changed ? '返回持仓' : '取消' }}</button>
      <button type="button" class="btn primary" :disabled="!valid" @click="submit">{{ submitting ? '正在提交…' : '确认实盘平仓' }}</button>
    </div>
  </WorkspaceDialog>
</template>

<style scoped>
.close-summary, .available-row { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 6px 12px; }
.close-summary span, .available-row span { color: var(--muted); font-size: 13px; }
.available-row { margin: 14px 0; font-size: 14px; font-variant-numeric: tabular-nums; }
.close-options, .close-presets { display: grid; gap: 6px; }
.close-options { grid-template-columns: repeat(2, 1fr); background: #f1f4ef; border-radius: 7px; padding: 3px; }
.close-options button { min-height: 34px; color: var(--muted); border: 0; background: transparent; border-radius: 5px; font: inherit; font-size: 13px; }
.close-options button[aria-pressed="true"] { background: white; color: var(--green); font-weight: 650; box-shadow: 0 1px 4px #172e2e16; }
.partial-quantity { margin-top: 14px; }
.percent-field { margin-top: 10px; }
.close-presets { grid-template-columns: minmax(75px, 1.3fr) repeat(3, minmax(0, 1fr)); }
.close-presets input { width: 100%; padding-right: 24px; }
.close-presets .btn { min-width: 0; padding-inline: 4px; height: auto; }
.close-presets .btn[aria-pressed="true"] { color: var(--green); border-color: var(--green); }
.close-receipt { margin: 12px 21px; }
</style>
