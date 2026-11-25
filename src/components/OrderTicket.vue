<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { Tickets } from '@element-plus/icons-vue'
import {
  buySpot,
  createClientOrderId,
  FuturesError,
  getManualOrderSize,
  lookupOrder,
  lookupSpotOrder,
  submitOrder,
  type BoundSession,
  type Environment,
  type OrderInput,
  type OrderResult,
  type ManualOrderSize,
  type ManualSizingMode,
  type Position,
  type SpotBuyInput,
} from '../futures'
import type { OpeningFunds } from '../opening-funds'
import { estimateOpeningMargin, type OpeningSize } from '../manual-opening'
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
const side = ref<OrderInput['side']>('BUY')
const position = ref<OrderInput['positionSide']>('BOTH')
const type = ref<OrderInput['type']>('MARKET')
const quantity = ref('')
const sizeMode = ref<ManualSizingMode | 'quantity'>('margin')
const marginAmount = ref('')
const equityPercent = ref('1')
const limit = ref('')
const reduce = ref(false)
const closing = computed(() => position.value === 'BOTH' ? reduce.value
  : position.value === 'LONG' ? side.value === 'SELL' : side.value === 'BUY')
const moneyMode = computed(() => futures.value && !closing.value && sizeMode.value !== 'quantity')
const leverage = ref<number | null>(null)
const { info: tiers, error: leverageError, loading: leverageLoading, refresh: refreshLeverage } =
  useFuturesLeverage(() => futures.value ? props.symbol : '', () => props.session, () => props.token)
const currentLeverage = computed(() => tiers.value?.leverage ?? undefined)
const maxLeverage = computed(() => tiers.value?.maxLeverage ?? tiers.value?.symbolMaxLeverage)
const leverageHelp = computed(() => {
  if (!tiers.value) return leverageLoading.value ? '正在读取币安账户杠杆档位…'
    : props.session ? '可手动填写倍数，提交时由币安确认。' : '连接账户后可读取该交易对的币安杠杆上限。'
  const limits = [props.symbol + ' 的币安最高杠杆 ' + tiers.value.symbolMaxLeverage + ' 倍']
  if (tiers.value.maxLeverage) limits.push('当前持仓档位上限 ' + tiers.value.maxLeverage + ' 倍')
  if (currentLeverage.value) limits.push('留空沿用当前 ' + currentLeverage.value + ' 倍')
  return limits.join('，') + '。可用倍数以币安最终确认为准。调整杠杆也会影响该交易对的已有持仓。'
})
watch(() => props.symbol, () => { leverage.value = null })
const failure = ref('')
const inFlight = ref(false)
const key = pendingOrderKey(props.session?.id, props.environment, props.market)
const pending = ref<PendingOrder | null>(props.session ? readPending(key) : null)
const result = ref<OrderResult>()
const forgetOpen = ref(false)
type Preview = { kind: 'futures'; input: OrderInput; accountLeverage?: number; closing: boolean; sizing?: ManualOrderSize; percent?: string }
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
const opening = computed(() => futures.value && !closing.value)
const awaitingFunds = computed(() => opening.value && !!props.session &&
  (props.funds.state !== 'ready' || props.funds.available == null))
const openingAmount = computed(() => sizeMode.value === 'margin' ? marginAmount.value
  : sizeMode.value === 'equityPercent' ? equityPercent.value : quantity.value)
const orderPrice = computed(() => Number(type.value === 'LIMIT' ? limit.value : props.price))
function selectMargin(amount: number) {
  marginAmount.value = amount.toFixed(8).replace(/\.?0+$/, '')
}
function estimate(size: OpeningSize) {
  return estimateOpeningMargin(size, { symbol: props.symbol, side: side.value, positionSide: position.value },
    props.positions, orderPrice.value, leverage.value ?? currentLeverage.value)
}
function insufficientFunds(margin: number | null) {
  const available = props.funds.available
  if (margin == null || margin === 0 || available == null || margin <= available + Math.abs(available) * Number.EPSILON * 4) return ''
  return '预计开仓需 ' + formatNumber(margin) + ' USDT 保证金，超过可用余额。'
}
const sizeIssue = computed(() => {
  if (!opening.value || !props.session) return ''
  if (sizeMode.value === 'equityPercent') {
    return equityPercent.value && (!positive(equityPercent.value) || Number(equityPercent.value) > 100)
      ? '请输入大于 0 且不超过 100 的比例。' : ''
  }
  const fixed = sizeMode.value === 'margin'
  const value = openingAmount.value
  if (!value) return ''
  if (!positive(value)) return fixed ? '请输入大于 0 的保证金。' : '请输入大于 0 的合约数量。'
  const margin = estimate(fixed ? { margin: Number(value) } : { quantity: Number(value) })
  if (margin == null && !fixed && orderPrice.value > 0 && !leverageLoading.value && !(leverage.value ?? currentLeverage.value))
    return '请填写合约杠杆倍数，以核对开仓所需保证金。'
  return insufficientFunds(margin)
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
watch([side, position, type, reduce, leverage, limit, sizeMode, marginAmount, equityPercent, () => props.symbol], cancelSizeRequest, { flush: 'sync' })
watch(() => props.active, active => {
  if (!active) {
    cancelSizeRequest()
    preview.value = null
    forgetOpen.value = false
  }
}, { flush: 'sync' })
onUnmounted(() => {
  cancelSizeRequest()
  mounted = false
})

function setPending(value: PendingOrder | null) {
  pending.value = value
  writePending(key, value)
}
function checkQuote() {
  if (
    !props.price ||
    !props.quoteTime ||
    props.quoteEnvironment !== props.session?.environment ||
    Math.abs(Date.now() - props.quoteTime) > 60_000
  ) {
    failure.value = '请刷新当前账户环境的行情后再下单。'
    return false
  }
  return true
}
async function prepare() {
  if (!props.active) return
  failure.value = ''
  result.value = undefined
  if (!props.session) {
    emit('connect')
    return
  }
  if (awaitingFunds.value || sizeIssue.value) return
  const setLeverage = futures.value && !closing.value && leverage.value != null
  if (setLeverage && !isAppLeverage(leverage.value, maxLeverage.value)) {
    failure.value = maxLeverage.value ? '杠杆倍数须为 1 至 ' + maxLeverage.value + ' 的整数。' : '杠杆倍数须为正整数。'
    return
  }
  if (inFlight.value || calculating.value || pending.value || !checkQuote()) return
  const amount = openingAmount.value
  if (
    !positive(moneyMode.value ? amount : quantity.value) ||
    (futures.value && type.value === 'LIMIT' && !positive(limit.value))
  ) {
    failure.value = '请填写大于零的十进制数量或金额，并检查限价。'
    return
  }
  const shared = {
    symbol: props.symbol,
    clientOrderId: createClientOrderId(),
    environment: props.session.environment,
  }
  previewTime.value = Date.now()
  previewPrice.value = props.price
  let sizing: ManualOrderSize | undefined
  const multiple = leverage.value ?? currentLeverage.value
  if (moneyMode.value && sizeMode.value !== 'quantity') {
    if (!multiple || !isAppLeverage(multiple, maxLeverage.value)) {
      failure.value = '请填写有效的合约杠杆倍数，以便换算下单数量。'
      return
    }
    const controller = new AbortController()
    sizeRequest = controller
    calculating.value = true
    try {
      sizing = await getManualOrderSize(props.token, { symbol: shared.symbol, environment: shared.environment,
        side: side.value, positionSide: position.value,
        type: type.value, mode: sizeMode.value, amount, leverage: String(multiple),
        price: type.value === 'LIMIT' ? limit.value : previewPrice.value }, controller.signal)
      if (controller.signal.aborted) return
      if (sizing.symbol !== shared.symbol || sizing.environment !== shared.environment || !positive(sizing.quantity))
        throw Error('无法确认该交易对的下单数量。')
      const issue = insufficientFunds(estimate({ margin: Number(sizing.margin) }))
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
  if (opening.value && (awaitingFunds.value || sizeIssue.value)) return
  if (opening.value && sizeMode.value === 'quantity' && estimate({ quantity: Number(quantity.value) }) == null) {
    failure.value = '请先确认交易对价格和杠杆倍数，以核对所需保证金。'
    return
  }
  preview.value = futures.value
    ? {
        kind: 'futures',
        accountLeverage: currentLeverage.value,
        sizing, percent: sizing && sizeMode.value === 'equityPercent' ? amount : undefined,
        closing: closing.value,
        input: {
          ...shared,
          side: side.value,
          positionSide: position.value,
          type: type.value,
          quantity: sizing?.quantity ?? quantity.value,
          ...(sizing || setLeverage ? { leverage: multiple } : {}),
          ...(type.value === 'LIMIT' ? { price: limit.value } : {}),
          ...(position.value === 'BOTH' && reduce.value ? { reduceOnly: true } : {}),
        },
      }
    : { kind: 'spot', input: { ...shared, quoteOrderQty: quantity.value } }
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
  if (order.kind === 'futures' && !order.closing) {
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
    <form class="ticket-form" @submit.prevent="prepare">
      <div v-if="futures" class="segmented" aria-label="订单方向">
        <button
          type="button"
          :aria-pressed="side === 'BUY'"
          :class="{ buy: side === 'BUY' }"
          @click="side = 'BUY'"
        >
          买入
        </button>
        <button
          type="button"
          :aria-pressed="side === 'SELL'"
          :class="{ sell: side === 'SELL' }"
          @click="side = 'SELL'"
        >
          卖出
        </button>
      </div>
      <div v-if="futures" class="two-fields">
        <label class="field">
          <span>订单类型</span>
          <select v-model="type">
            <option value="MARKET">市价单</option>
            <option value="LIMIT">限价单（GTC）</option>
          </select>
        </label>
        <label class="field">
          <span>账户持仓模式</span>
          <select v-model="position">
            <option value="BOTH">单向持仓</option>
            <option value="LONG">双向 · 多仓</option>
            <option value="SHORT">双向 · 空仓</option>
          </select>
        </label>
      </div>
      <label v-if="opening" class="field">
        <span>开仓方式</span>
        <select v-model="sizeMode">
          <option value="margin">固定保证金</option>
          <option value="equityPercent">按总权益百分比</option>
          <option value="quantity">直接输入合约数量</option>
        </select>
      </label>
      <OpeningBalance v-if="opening" :funds="funds" :shortcuts="sizeMode === 'margin'"
        @select="selectMargin" @refresh="emit('refresh')" @connect="emit('connect')">
        <label class="field">
          <span>{{ sizeMode === 'margin' ? '本单保证金' : sizeMode === 'equityPercent' ? '占合约总权益比例' : '下单数量' }}</span>
          <span class="input-unit">
            <input v-if="sizeMode === 'margin'" v-model.trim="marginAmount" inputmode="decimal" placeholder="输入保证金"
              :required="!!session" :aria-invalid="!!sizeIssue" :aria-describedby="sizeIssue ? 'manual-size-issue' : undefined" />
            <input v-else-if="sizeMode === 'equityPercent'" v-model.trim="equityPercent" inputmode="decimal" placeholder="输入比例"
              :required="!!session" :aria-invalid="!!sizeIssue" :aria-describedby="sizeIssue ? 'manual-size-issue' : undefined" />
            <input v-else v-model.trim="quantity" inputmode="decimal" placeholder="输入合约数量"
              :required="!!session" :aria-invalid="!!sizeIssue" :aria-describedby="sizeIssue ? 'manual-size-issue' : undefined" />
            <b>{{ sizeMode === 'margin' ? 'USDT' : sizeMode === 'equityPercent' ? '%' : base }}</b>
          </span>
          <small v-if="sizeMode === 'equityPercent'">以预览时的合约总权益计算保证金，含未实现盈亏。</small>
        </label>
        <p v-if="sizeIssue" id="manual-size-issue" class="sizing-error" role="status">{{ sizeIssue }}</p>
      </OpeningBalance>
      <label v-else class="field">
        <span>{{ futures ? '下单数量' : '买入金额' }}</span>
        <span class="input-unit">
          <input
            v-model.trim="quantity"
            inputmode="decimal"
            placeholder="0.00"
            :required="!!session"
          />
          <b>{{ futures ? base : 'USDT' }}</b>
        </span>
      </label>
      <label v-if="futures && closing" class="field">
        <span>合约杠杆倍数</span>
        <input disabled :value="currentLeverage ? '平仓沿用当前 ' + currentLeverage + ' 倍' : '平仓沿用账户当前杠杆'" />
      </label>
      <LeverageControl v-else-if="futures" v-model="leverage" label="合约杠杆倍数" :max="maxLeverage"
        :fallback="currentLeverage" :placeholder="currentLeverage ? String(currentLeverage) : '沿用'"
        :description="leverageHelp" />
      <p v-if="futures && leverageError" class="notice warning" role="status">{{ leverageError }}
        <button type="button" class="text-button" @click="refreshLeverage">重读杠杆档位</button>
      </p>
      <label v-if="futures && type === 'LIMIT'" class="field">
        <span>限价</span>
        <span class="input-unit">
          <input
            v-model.trim="limit"
            inputmode="decimal"
            placeholder="0.00"
            :required="!!session"
          />
          <b>USDT</b>
        </span>
      </label>
      <label v-if="futures && position === 'BOTH'" class="checkbox">
        <input v-model="reduce" type="checkbox" aria-describedby="reduce-help" />
        仅减仓
      </label>
      <p v-if="futures && position === 'BOTH'" id="reduce-help" class="ticket-hint">
        勾选后，{{ side === 'BUY' ? '买入只平空仓' : '卖出只平多仓' }}。
        例如已有 0.02 {{ base }} {{ side === 'BUY' ? '空仓' : '多仓' }}，{{ side === 'BUY' ? '买入' : '卖出' }}
        0.01 {{ base }} 成交后，原仓剩余 0.01 {{ base }}。没有对应持仓时，订单无法成交。关闭仅减仓后，超出原仓的成交数量可能开出反向仓位。
      </p>
      <p v-else-if="futures" class="ticket-hint">
        双向模式按持仓侧区分开平。当前订单将{{ position === 'LONG'
          ? (side === 'BUY' ? '开多或加多仓' : '平多仓')
          : (side === 'SELL' ? '开空或加空仓' : '平空仓') }}。
      </p>
      <p v-if="!futures" class="ticket-hint">
        以可用 USDT 购买 {{ base }}，实际成交数量由撮合价格决定。
      </p>
      <button type="submit" class="btn primary submit-order"
        :disabled="inFlight || calculating || !!pending || awaitingFunds || !!sizeIssue || (!!session && opening && !openingAmount)">
        {{ !session ? '连接账户后下单' : calculating ? '正在计算数量…' : inFlight ? '正在处理…' : '预览订单' }}
      </button>
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
              {{ preview.input.side === 'BUY' ? '买入' : '卖出' }} ·
              {{ positionName(preview.input.positionSide)
              }}{{ preview.input.reduceOnly ? ' · 仅减仓' : '' }}
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
          <div v-if="previewLeverage && !preview.closing">
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
.sizing-error {
  margin: 0;
  color: #943f2d;
  font-size: 12px;
  line-height: 1.5;
}
.field input[aria-invalid='true'] { border-color: #b55e47; }
</style>
