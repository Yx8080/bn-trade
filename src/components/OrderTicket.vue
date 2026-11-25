<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { Tickets } from '@element-plus/icons-vue'
import {
  buySpot,
  createClientOrderId,
  FuturesError,
  getFuturesPositionMode,
  getManualOrderSize,
  lookupOrder,
  lookupSpotOrder,
  submitOrder,
  type BoundSession,
  type Environment,
  type FuturesPositionMode,
  type OrderInput,
  type OrderResult,
  type ManualOrderSize,
  type ManualSizingMode,
  type Position,
  type SpotBuyInput,
} from '../futures'
import type { OpeningFunds } from '../opening-funds'
import { estimateOpeningMargin, manualOpeningDirection, type ManualDirection } from '../manual-opening'
import { formatNumber } from '../trades'
import WorkspaceDialog from './WorkspaceDialog.vue'
import LeverageControl from './LeverageControl.vue'
import OpeningBalance from './OpeningBalance.vue'
import { isAppLeverage } from '../../shared/leverage.js'
import { useFuturesLeverage } from '../useFuturesLeverage'
import { pendingOrderKey, readPending, writePending, type PendingOrder } from './pendingOrder'

const props = defineProps<{
  market: 'spot' | 'futures'
  environment: Environment
  symbol: string
  price: string
  quoteTime: number
  quoteEnvironment: string
  session: BoundSession | null
  token: string
  funds: OpeningFunds
  positions: Position[]
  active: boolean
}>()
const emit = defineEmits<{ connect: []; ordered: []; refresh: [] }>()
const futures = computed(() => props.market === 'futures')
const mode = ref<FuturesPositionMode | null>(null)
const modeError = ref('')
const modeRefresh = ref(0)
function refreshModeOnReturn() {
  if (!document.hidden && futures.value && props.active && props.session) modeRefresh.value++
}
onMounted(() => document.addEventListener('visibilitychange', refreshModeOnReturn))
watch([() => futures.value && props.active, () => props.session, () => props.token, () => props.environment, modeRefresh],
  async ([active, session, token, environment], _, cleanup) => {
    mode.value = null
    modeError.value = ''
    if (!active || !session) return
    if (!token || session.environment !== environment) {
      modeError.value = '请重新连接当前环境的账户。'
      return
    }
    const controller = new AbortController()
    cleanup(() => controller.abort())
    try {
      const current = await getFuturesPositionMode(token, environment, controller.signal)
      if (!controller.signal.aborted) mode.value = current
    } catch (cause) {
      if (!controller.signal.aborted) modeError.value = cause instanceof Error ? cause.message : '暂时无法读取币安账户持仓模式。'
    }
  }, { immediate: true })
const type = ref<OrderInput['type']>('MARKET')
const quantity = ref('')
const limitSizeMode = ref<ManualSizingMode | 'quantity'>('margin')
const sizeMode = computed(() => type.value === 'LIMIT' ? limitSizeMode.value : 'margin')
const marginAmount = ref('')
const equityPercent = ref('1')
const limit = ref('')
const leverage = ref<number | null>(null)
const leverageExpanded = ref(false)
const leveragePanelId = useId()
const { info: tiers, error: leverageError, loading: leverageLoading, refresh: refreshLeverage } =
  useFuturesLeverage(() => futures.value ? props.symbol : '', () => props.session, () => props.token)
const currentLeverage = computed(() => tiers.value?.leverage ?? undefined)
const maxLeverage = computed(() => tiers.value?.maxLeverage ?? tiers.value?.symbolMaxLeverage)
const effectiveLeverage = computed(() => leverage.value ?? currentLeverage.value)
const failure = ref('')
const inFlight = ref(false)
const key = pendingOrderKey(props.session?.id, props.environment, props.market)
const pending = ref<PendingOrder | null>(props.session ? readPending(key) : null)
const result = ref<OrderResult>()
const forgetOpen = ref(false)
type Preview = { kind: 'futures'; input: OrderInput; direction: ManualDirection; accountLeverage?: number; sizing?: ManualOrderSize; percent?: string }
  | { kind: 'spot'; input: SpotBuyInput }
const preview = ref<Preview | null>(null)
const previewPrice = ref('')
const previewLeverage = computed(() => preview.value?.kind === 'futures'
  ? preview.value.input.leverage ?? preview.value.accountLeverage : undefined)
const previewNotional = computed(() => preview.value?.kind === 'futures'
  ? Number(preview.value.input.quantity) * Number(preview.value.input.price ?? previewPrice.value) : 0)
const base = computed(() => props.symbol.slice(0, -4))
const positive = (text: string) =>
  /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(text) && Number(text) > 0
const awaitingFunds = computed(() => props.funds.state !== 'ready' || props.funds.available == null)
const openingAmount = computed(() => sizeMode.value === 'margin' ? marginAmount.value
  : sizeMode.value === 'equityPercent' ? equityPercent.value : quantity.value)
const orderPrice = computed(() => Number(type.value === 'LIMIT' ? limit.value : props.price))
function selectMargin(amount: number) {
  marginAmount.value = Number.isFinite(amount) && amount > 0 ? amount.toFixed(8).replace(/\.?0+$/, '') : ''
}
function openingMarginFor(direction: ManualDirection) {
  if (!mode.value || !props.session || awaitingFunds.value || sizeMode.value === 'equityPercent' || !positive(openingAmount.value)) return null
  const size = sizeMode.value === 'margin' ? { margin: Number(marginAmount.value) } : { quantity: Number(quantity.value) }
  return estimateOpeningMargin(size, { symbol: props.symbol, ...manualOpeningDirection(mode.value, direction) },
    props.positions, orderPrice.value, effectiveLeverage.value)
}
function insufficientFunds(margin: number | null) {
  const available = props.funds.available
  if (margin == null || margin === 0 || available == null || margin <= available + Math.abs(available) * Number.EPSILON * 4) return ''
  return '预计开仓需 ' + formatNumber(margin) + ' USDT 保证金，超过可用余额。'
}
const inputIssue = computed(() => {
  if (!futures.value || !props.session) return ''
  if (type.value === 'LIMIT' && limit.value && !positive(limit.value)) return '请输入大于 0 的限价。'
  if (leverage.value != null && !isAppLeverage(leverage.value, maxLeverage.value))
    return maxLeverage.value ? '杠杆倍数须为 1 至 ' + maxLeverage.value + ' 的整数。' : '杠杆倍数须为正整数。'
  if (sizeMode.value === 'equityPercent')
    return equityPercent.value && (!positive(equityPercent.value) || Number(equityPercent.value) > 100) ? '请输入大于 0 且不超过 100 的比例。' : ''
  if (openingAmount.value && !positive(openingAmount.value)) return sizeMode.value === 'margin' ? '请输入大于 0 的保证金。' : '请输入大于 0 的合约数量。'
  return ''
})
function directionIssue(direction: ManualDirection) {
  if (!futures.value || !props.session || !mode.value) return ''
  if (awaitingFunds.value || !positive(openingAmount.value)) return ''
  const margin = openingMarginFor(direction)
  if (!effectiveLeverage.value && !leverageLoading.value && (sizeMode.value !== 'quantity' || margin !== 0))
    return '请填写合约杠杆倍数，以核对开仓所需保证金。'
  return insufficientFunds(margin)
}
const formIssue = computed(() => {
  if (inputIssue.value) return inputIssue.value
  const long = directionIssue('LONG')
  const short = directionIssue('SHORT')
  if (long && short) return long === short ? long : '多仓和空仓均无法按当前金额开仓。'
  if (futures.value && props.session && !canUseQuote.value && positive(openingAmount.value))
    return '请刷新当前交易环境的行情后预览。'
  return ''
})
const previewTime = ref(0)
let mounted = true
const calculating = ref(false)
let sizeRequest: AbortController | undefined
function cancelSizeRequest() {
  sizeRequest?.abort()
  sizeRequest = undefined
  calculating.value = false
}
function invalidatePreview() {
  cancelSizeRequest()
  preview.value = null
}
watch([() => props.symbol, () => props.environment, () => props.market], () => {
  leverage.value = null
  leverageExpanded.value = false
  quantity.value = ''
  limit.value = ''
}, { flush: 'sync' })
watch([mode, type, leverage, limit, sizeMode, marginAmount, equityPercent, quantity,
  () => props.session, () => props.token, () => props.symbol, () => props.market, () => props.environment], () => {
  invalidatePreview()
  failure.value = ''
}, { flush: 'sync' })
watch([currentLeverage, maxLeverage], invalidatePreview, { flush: 'sync' })
watch(() => props.active, active => {
  if (!active) {
    invalidatePreview()
    leverageExpanded.value = false
    forgetOpen.value = false
  }
}, { flush: 'sync' })
onUnmounted(() => {
  document.removeEventListener('visibilitychange', refreshModeOnReturn)
  cancelSizeRequest()
  mounted = false
})

function setPending(value: PendingOrder | null) {
  pending.value = value
  writePending(key, value)
}

function quoteIsFresh() {
  return positive(props.price) && props.quoteTime > 0 && props.quoteEnvironment === props.environment &&
    Math.abs(Date.now() - props.quoteTime) < 60_000
}
const canUseQuote = ref(false)
watch([() => props.quoteTime, () => props.price, () => props.quoteEnvironment, () => props.environment], (_, __, cleanup) => {
  canUseQuote.value = quoteIsFresh()
  if (!canUseQuote.value) return
  const timer = setTimeout(() => { canUseQuote.value = false }, Math.max(0, props.quoteTime + 60_000 - Date.now()))
  cleanup(() => clearTimeout(timer))
}, { immediate: true })
function limitPriceFromQuote() {
  if (futures.value && type.value === 'LIMIT' && quoteIsFresh()) limit.value = props.price
}

function checkQuote() {
  if (props.session?.environment !== props.environment || !quoteIsFresh()) {
    failure.value = '请刷新当前账户环境的行情后再下单。'
    return false
  }
  return true
}
function canPreviewDirection(direction: ManualDirection) {
  if (!futures.value || !props.active || preview.value || inFlight.value || calculating.value || pending.value) return false
  if (!props.session) return true
  if (!mode.value || awaitingFunds.value || inputIssue.value || directionIssue(direction) || !canUseQuote.value) return false
  if (type.value === 'LIMIT' && !positive(limit.value)) return false
  if (!positive(openingAmount.value)) return false
  if (sizeMode.value === 'quantity') return openingMarginFor(direction) != null
  return isAppLeverage(effectiveLeverage.value, maxLeverage.value)
}
function beginPreview() {
  if (!props.active || preview.value || calculating.value || inFlight.value || pending.value) return
  failure.value = ''
  result.value = undefined
  if (!props.session) {
    emit('connect')
    return
  }
  if (!checkQuote()) return
  previewTime.value = Date.now()
  previewPrice.value = props.price
  return { symbol: props.symbol, clientOrderId: createClientOrderId(), environment: props.session.environment }
}
function prepare() {
  if (futures.value) return
  const shared = beginPreview()
  if (!shared) return
  if (!positive(quantity.value)) {
    failure.value = '请输入大于零的买入金额。'
    return
  }
  preview.value = { kind: 'spot', input: { ...shared, quoteOrderQty: quantity.value } }
}

async function previewDirection(direction: ManualDirection) {
  if (!futures.value) return
  const shared = beginPreview()
  if (!shared || !mode.value || !canPreviewDirection(direction)) return
  const action = manualOpeningDirection(mode.value, direction)
  const amount = openingAmount.value
  const multiple = effectiveLeverage.value
  let sizing: ManualOrderSize | undefined
  if (sizeMode.value !== 'quantity') {
    if (!multiple) return
    const controller = new AbortController()
    sizeRequest = controller
    calculating.value = true
    try {
      sizing = await getManualOrderSize(props.token, {
        symbol: shared.symbol, environment: shared.environment, side: action.side, positionSide: action.positionSide,
        type: type.value, mode: sizeMode.value, amount, leverage: String(multiple),
        price: type.value === 'LIMIT' ? limit.value : previewPrice.value,
      }, controller.signal)
      if (controller.signal.aborted) return
      if (sizing.symbol !== shared.symbol || sizing.environment !== shared.environment || !positive(sizing.quantity) || !positive(sizing.margin))
        throw Error('无法确认该交易对的开仓金额或数量。')
      const margin = estimateOpeningMargin({ margin: Number(sizing.margin) }, { symbol: shared.symbol, ...action },
        props.positions, orderPrice.value, multiple)
      const issue = insufficientFunds(margin)
      if (issue) throw Error(issue)
    } catch (cause) {
      if (!controller.signal.aborted) {
        failure.value = cause instanceof Error ? cause.message : '计算开仓数量失败。'
        if (cause instanceof FuturesError && cause.code === 'INSUFFICIENT_AVAILABLE_MARGIN') emit('refresh')
      }
      return
    } finally {
      if (sizeRequest === controller) { sizeRequest = undefined; calculating.value = false }
    }
  }
  if (!canPreviewDirection(direction) || !checkQuote()) return
  preview.value = {
    kind: 'futures', direction, accountLeverage: currentLeverage.value,
    sizing, percent: sizing && sizeMode.value === 'equityPercent' ? amount : undefined,
    input: {
      ...shared, ...action, type: type.value, quantity: sizing?.quantity ?? quantity.value,
      ...(sizing || leverage.value != null ? { leverage: multiple } : {}),
      ...(type.value === 'LIMIT' ? { price: limit.value } : {}),
    },
  }
}
async function confirm() {
  const order = preview.value
  if (!props.active || !order || !props.session || inFlight.value || pending.value) return
  preview.value = null
  if (!checkQuote()) return
  if (Date.now() - previewTime.value > 60_000 || order.input.symbol !== props.symbol || order.input.environment !== props.session.environment) {
    failure.value = '订单预览已过期，请重新核对。'
    return
  }
  if (order.kind === 'futures') {
    const required = estimateOpeningMargin({ quantity: Number(order.input.quantity) }, order.input,
      props.positions, Number(order.input.price ?? props.price), order.input.leverage ?? order.accountLeverage)
    const issue = insufficientFunds(required)
    if (props.funds.state !== 'ready' || props.funds.available == null || required == null || issue) {
      failure.value = issue || '请重新读取账户余额及订单数据后预览。'
      return
    }
  }
  inFlight.value = true
  setPending({ symbol: order.input.symbol, clientOrderId: order.input.clientOrderId })
  try {
    const ack =
      order.kind === 'spot'
        ? await buySpot(props.token, order.input)
        : await submitOrder(props.token, order.input)
    if (!mounted) return
    result.value = ack
    setPending(null)
    emit('ordered')
  } catch (cause) {
    if (!mounted) return
    if (cause instanceof FuturesError && cause.code !== 'ORDER_UNKNOWN') setPending(null)
    failure.value = cause instanceof Error ? cause.message : '订单响应未收到，请按订单编号查询。'
  } finally {
    inFlight.value = false
    if (mounted && order.kind === 'futures') refreshLeverage()
  }
}
async function reconcile() {
  if (!pending.value || inFlight.value) return
  inFlight.value = true
  failure.value = ''
  try {
    const { symbol, clientOrderId } = pending.value
    const lookup = futures.value ? lookupOrder : lookupSpotOrder
    const ack = await lookup(props.token, symbol, clientOrderId)
    if (!mounted) return
    result.value = ack
    setPending(null)
    emit('ordered')
  } catch (cause) {
    if (mounted) failure.value = cause instanceof Error ? cause.message : '暂未查到订单。'
  } finally {
    inFlight.value = false
  }
}
function forget() {
  setPending(null)
  failure.value = ''
  forgetOpen.value = false
}
function positionName(value: string) {
  return value === 'LONG' ? '双向 · 多仓' : value === 'SHORT' ? '双向 · 空仓' : '单向持仓'
}
</script>

<template>
  <section class="ticket-card" :class="futures ? 'futures-form-panel' : 'panel'">
    <div v-if="!futures" class="ledger-heading">
      <div class="section-title">
        <div class="title-icon"><Tickets /></div>
        <h2>市价买入</h2>
      </div>
      <span class="env" :class="{ live: environment === 'live' }">
        {{ environment === 'live' ? '实盘' : '测试网' }}
      </span>
    </div>
    <form class="ticket-form" :aria-busy="inFlight || calculating" :aria-describedby="formIssue ? leveragePanelId + '-issue' : undefined" @submit.prevent="prepare">
      <template v-if="futures">
        <div class="manual-toolbar">
          <span v-if="session && !modeError" class="position-mode" role="status">
            {{ mode === 'hedge' ? '双向持仓' : mode === 'oneWay' ? '单向持仓' : '读取持仓模式中…' }}
          </span>
          <button type="button" class="setting-chip leverage-chip"
            :aria-expanded="leverageExpanded" :aria-controls="leveragePanelId"
            :aria-label="effectiveLeverage == null ? '合约杠杆，沿用账户设置' : '合约杠杆 ' + effectiveLeverage + ' 倍'" @click="leverageExpanded = !leverageExpanded">
            {{ effectiveLeverage != null ? effectiveLeverage + '×' : '账户杠杆' }}
            <span class="chip-caret" aria-hidden="true"></span>
          </button>
          <span class="ticket-symbol">{{ symbol }}</span>
        </div>
        <p v-if="modeError" class="notice warning" role="status">
          持仓模式读取失败。{{ modeError }}
          <button type="button" class="text-button" @click="modeRefresh++">重试</button>
        </p>
        <div v-show="leverageExpanded" :id="leveragePanelId" class="leverage-panel">
          <LeverageControl v-model="leverage" label="合约杠杆倍数" :max="maxLeverage"
            :fallback="currentLeverage" :placeholder="currentLeverage ? String(currentLeverage) : '沿用'" />
          <p v-if="leverageLoading" class="ticket-hint" role="status">正在读取账户杠杆…</p>
        </div>
        <p v-if="leverageError" class="notice warning" role="status">{{ leverageError }}
          <button type="button" class="text-button" @click="refreshLeverage">重读杠杆档位</button>
        </p>

        <div class="manual-order-types" role="group" aria-label="订单类型">
          <button type="button" :aria-pressed="type === 'LIMIT'" @click="type = 'LIMIT'">限价</button>
          <button type="button" :aria-pressed="type === 'MARKET'" @click="type = 'MARKET'">市价</button>
          <span v-if="type === 'LIMIT'" class="time-in-force" title="订单持续有效，直至成交或取消">有效期 GTC</span>
        </div>
        <div v-if="type === 'LIMIT'" class="limit-row">
          <label class="field">
            <span>委托价格</span>
            <span class="input-unit"><input v-model.trim="limit" inputmode="decimal" placeholder="输入限价" :required="!!session" /><b>USDT</b></span>
          </label>
          <button type="button" class="btn quote-fill" :disabled="!canUseQuote" @click="limitPriceFromQuote">最新价</button>
        </div>
        <div v-else class="market-execution"><span>委托价格</span><span>按市场价格成交</span></div>
        <OpeningBalance :funds="funds" :slider="sizeMode === 'margin'"
          :selected-amount="Number(marginAmount)" @select="selectMargin" @refresh="emit('refresh')" @connect="emit('connect')">
          <div class="field amount-field">
            <div class="amount-heading">
              <label :for="leveragePanelId + '-amount'">{{ sizeMode === 'margin' ? '本单保证金' : sizeMode === 'equityPercent' ? '占总权益比例' : '委托数量' }}</label>
              <select v-if="type === 'LIMIT'" v-model="limitSizeMode" class="sizing-select" aria-label="开仓方式">
                <option value="margin">固定保证金</option>
                <option value="equityPercent">按总权益百分比</option>
                <option value="quantity">合约数量</option>
              </select>
            </div>
            <span class="input-unit">
              <input v-if="sizeMode === 'margin'" :id="leveragePanelId + '-amount'" v-model.trim="marginAmount" inputmode="decimal" placeholder="输入保证金" />
              <input v-else-if="sizeMode === 'equityPercent'" :id="leveragePanelId + '-amount'" v-model.trim="equityPercent" inputmode="decimal" placeholder="输入比例" />
              <input v-else :id="leveragePanelId + '-amount'" v-model.trim="quantity" inputmode="decimal" placeholder="输入数量" />
              <b>{{ sizeMode === 'margin' ? 'USDT' : sizeMode === 'equityPercent' ? '%' : base }}</b>
            </span>
          </div>
        </OpeningBalance>
        <p v-if="formIssue" :id="leveragePanelId + '-issue'" class="sizing-error" role="status">{{ formIssue }}</p>
        <p v-else-if="calculating" class="ticket-hint" role="status">正在计算下单数量…</p>
        <div class="direction-actions">
          <div v-for="direction in (['LONG', 'SHORT'] as const)" :key="direction" class="direction-action">
            <button type="button" class="btn direction-button" :class="direction === 'LONG' ? 'buy' : 'sell'"
              :disabled="!canPreviewDirection(direction)" @click="previewDirection(direction)">
              预览开{{ direction === 'LONG' ? '多' : '空' }}
            </button>
            <span v-if="openingMarginFor(direction) != null" class="action-estimate">
              预计保证金 <strong>{{ formatNumber(openingMarginFor(direction)) }} USDT</strong>
            </span>
            <small v-if="!formIssue && directionIssue(direction)" class="sizing-error">{{ directionIssue(direction) }}</small>
          </div>
        </div>
      </template>
      <template v-else>
        <label class="field">
          <span>买入金额</span>
          <span class="input-unit"><input v-model.trim="quantity" inputmode="decimal" placeholder="0.00" :required="!!session" /><b>USDT</b></span>
        </label>
        <p class="ticket-hint">以可用 USDT 购买 {{ base }}，实际成交数量由撮合价格决定。</p>
        <button type="submit" class="btn primary submit-order" :disabled="inFlight || calculating || !!pending">
          {{ !session ? '连接账户后下单' : inFlight ? '正在处理…' : '预览订单' }}
        </button>
      </template>
    </form>
    <div v-if="pending && !inFlight" class="receipt warning" role="status">
      <strong>订单状态待核实</strong>
      <p>{{ pending.symbol }} · {{ pending.clientOrderId }}</p>
      <button type="button" class="text-button" @click="reconcile">查询原订单</button>
      <button type="button" class="text-button muted" @click="forgetOpen = true">
        已在币安核实
      </button>
    </div>
    <p v-if="failure" class="notice error" role="alert">{{ failure }}</p>
    <div v-if="result" class="receipt" role="status">
      <strong>交易所订单回执 · {{ result.status }}</strong>
      <p>{{ result.symbol }} · 订单号 {{ result.orderId }}</p>
      <p>
        已成交 {{ formatNumber(Number(result.executedQty)) }} · 成交均价
        {{ Number(result.avgPrice) > 0 ? formatNumber(Number(result.avgPrice)) : '—' }}
      </p>
    </div>
    <WorkspaceDialog
      v-if="preview && session"
      :title="session.environment === 'live' ? '确认提交实盘订单' : '确认提交测试网订单'"
      @close="preview = null"
    >
      <dl class="order-review">
        <div>
          <dt>交易账户</dt>
          <dd>UID {{ session.uid }} · {{ session.environment === 'live' ? '实盘' : '测试网' }}</dd>
        </div>
        <div>
          <dt>交易对</dt>
          <dd>{{ preview.input.symbol }} · {{ futures ? 'U 本位永续' : '现货' }}</dd>
        </div>
        <template v-if="preview.kind === 'futures'">
          <div v-if="preview.percent && preview.sizing"><dt>合约账户总权益 × 下单比例</dt>
            <dd>{{ formatNumber(preview.sizing.equity) }} USDT × {{ preview.percent }}%</dd></div>
          <div v-if="preview.sizing"><dt>目标初始保证金</dt><dd>{{ formatNumber(Number(preview.sizing.margin)) }} USDT</dd></div>
          <div>
            <dt>方向 / 持仓</dt>
            <dd>
              开{{ preview.direction === 'LONG' ? '多' : '空' }}
              · {{ preview.input.side === 'BUY' ? '买入' : '卖出' }} ·
              {{ positionName(preview.input.positionSide) }}
            </dd>
          </div>
          <div>
            <dt>订单类型</dt>
            <dd>{{ preview.input.type === 'LIMIT' ? '限价单（GTC）' : '市价单' }}</dd>
          </div>
          <div>
            <dt>数量</dt>
            <dd>{{ preview.input.quantity }} {{ base }}</dd>
          </div>
          <div v-if="preview.input.price">
            <dt>限价</dt>
            <dd>{{ preview.input.price }} USDT</dd>
          </div>
          <div>
            <dt>订单合约价值</dt>
            <dd>约 {{ formatNumber(previewNotional) }} USDT</dd>
          </div>
          <div>
            <dt>合约杠杆</dt>
            <dd>{{ preview.input.leverage ? '设为 ' + preview.input.leverage + ' 倍'
              : preview.accountLeverage ? '沿用当前 ' + preview.accountLeverage + ' 倍' : '沿用交易对当前杠杆' }}</dd>
          </div>
          <div v-if="previewLeverage">
            <dt>按全额开仓估算保证金</dt>
            <dd>约 {{ formatNumber(previewNotional / previewLeverage) }} USDT</dd>
          </div>
        </template>
        <div v-else>
          <dt>市价买入金额</dt>
          <dd>{{ preview.input.quoteOrderQty }} USDT</dd>
        </div>
        <div>
          <dt>市场参考价</dt>
          <dd>{{ formatNumber(Number(previewPrice)) }} USDT</dd>
        </div>
      </dl>
      <p v-if="preview.kind === 'futures' && preview.input.leverage" class="ticket-hint">
        币安先调整 {{ preview.input.symbol }} 的杠杆，再提交订单。该设置也适用于账户在此交易对的已有仓位。
      </p>
      <div class="dialog-actions">
        <button type="button" class="btn" @click="preview = null">返回修改</button>
        <button type="button" class="btn primary" @click="confirm">
          {{ session.environment === 'live' ? '确认实盘下单' : '确认测试网下单' }}
        </button>
      </div>
    </WorkspaceDialog>
    <WorkspaceDialog v-if="forgetOpen" title="结束订单核实" @close="forgetOpen = false">
      <p class="dialog-description">
        请先在币安订单记录中核实 {{ pending?.clientOrderId }}。继续后会清除此笔订单的待查提醒。
      </p>
      <div class="dialog-actions">
        <button class="btn" @click="forgetOpen = false">返回</button>
        <button class="btn primary" @click="forget">已核实，清除提醒</button>
      </div>
    </WorkspaceDialog>
  </section>
</template>

<style scoped>
.manual-toolbar, .amount-heading { display: flex; align-items: center; gap: 8px; }
.manual-toolbar { flex-wrap: wrap; }
.position-mode { color: var(--muted); font-size: 12px; }
.ticket-symbol { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--muted); }
.setting-chip {
  min-height: 30px;
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #f3f6f3;
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.leverage-chip { display: inline-flex; align-items: center; gap: 8px; }
.chip-caret { width: 6px; height: 6px; border: solid currentColor; border-width: 0 1.5px 1.5px 0; transform: translateY(-1px) rotate(45deg); }
.leverage-chip[aria-expanded='true'] .chip-caret { transform: translateY(1px) rotate(225deg); }
.leverage-panel { background: #f7f9f7; border: 1px solid var(--line); border-radius: 7px; padding: 10px 12px; }
.manual-order-types { display: flex; align-items: center; gap: 20px; border-bottom: 1px solid var(--line); }
.manual-order-types button {
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 5px 1px 8px;
  margin-bottom: -1px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}
.manual-order-types button[aria-pressed='true'] { border-bottom-color: var(--green); color: var(--green); }
.time-in-force { margin-left: auto; font-size: 12px; color: var(--muted); }
.limit-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 8px; }
.market-execution { display: flex; align-items: baseline; justify-content: space-between; font-size: 12px; color: var(--muted); }
.amount-heading { justify-content: space-between; flex-wrap: wrap; }
.amount-heading .sizing-select { width: auto; height: 26px; padding: 0 4px; border-color: transparent; color: var(--green); font-size: 12px; font-weight: 600; cursor: pointer; }
.amount-heading .sizing-select:hover { background: #f1f6f1; }
.direction-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.direction-action { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.direction-button { width: 100%; min-height: 40px; color: white; }
.direction-button.buy { background: var(--green); border-color: var(--green); }
.direction-button.sell { background: #a4463b; border-color: #a4463b; }
.direction-button.buy:hover:not(:disabled) { background: #104e3d; border-color: #104e3d; }
.direction-button.sell:hover:not(:disabled) { background: #87392f; border-color: #87392f; }
.action-estimate { font-size: 12px; color: var(--muted); }
.action-estimate strong { color: var(--ink); font-variant-numeric: tabular-nums; }
.sizing-error {
  margin: 0;
  color: #943f2d;
  font-size: 12px;
  line-height: 1.5;
}
</style>
