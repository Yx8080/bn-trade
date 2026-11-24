<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { Tickets } from '@element-plus/icons-vue'
import {
  buySpot,
  createClientOrderId,
  FuturesError,
  lookupOrder,
  lookupSpotOrder,
  submitOrder,
  type FuturesSession,
  type OrderInput,
  type OrderResult,
  type SpotBuyInput,
} from '../futures'
import { formatNumber } from '../trades'
import WorkspaceDialog from './WorkspaceDialog.vue'
import { readPending, writePending, type PendingOrder } from './pendingOrder'

const props = defineProps<{
  market: 'spot' | 'futures'
  symbol: string
  price: string
  quoteTime: number
  quoteEnvironment: string
  session: FuturesSession | null
  token: string
}>()
const emit = defineEmits<{ connect: []; ordered: [] }>()
const futures = computed(() => props.market === 'futures')
const side = ref<OrderInput['side']>('BUY')
const position = ref<OrderInput['positionSide']>('BOTH')
const type = ref<OrderInput['type']>('MARKET')
const quantity = ref('')
const limit = ref('')
const reduce = ref(false)
const failure = ref('')
const inFlight = ref(false)
const key =
  'bn-trade:pending:' +
  JSON.stringify([props.session?.id, props.session?.environment, props.market])
const pending = ref<PendingOrder | null>(props.session ? readPending(key) : null)
const result = ref<OrderResult>()
const forgetOpen = ref(false)
type Preview = { kind: 'futures'; input: OrderInput } | { kind: 'spot'; input: SpotBuyInput }
const preview = ref<Preview | null>(null)
const base = computed(() => props.symbol.slice(0, -4))
const positive = (text: string) =>
  /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text)) && Number(text) > 0
const previewTime = ref(0)
let mounted = true
onUnmounted(() => {
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
function prepare() {
  failure.value = ''
  result.value = undefined
  if (!props.session) {
    emit('connect')
    return
  }
  if (inFlight.value || pending.value || !checkQuote()) return
  if (
    !positive(quantity.value) ||
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
  preview.value = futures.value
    ? {
        kind: 'futures',
        input: {
          ...shared,
          side: side.value,
          positionSide: position.value,
          type: type.value,
          quantity: quantity.value,
          ...(type.value === 'LIMIT' ? { price: limit.value } : {}),
          ...(position.value === 'BOTH' && reduce.value ? { reduceOnly: true } : {}),
        },
      }
    : { kind: 'spot', input: { ...shared, quoteOrderQty: quantity.value } }
}
async function confirm() {
  const order = preview.value
  if (!order || !props.session || inFlight.value || pending.value) return
  preview.value = null
  if (!checkQuote()) return
  if (Date.now() - previewTime.value > 60_000 || order.input.symbol !== props.symbol) {
    failure.value = '订单预览已过期，请重新核对。'
    return
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
  <section class="panel ticket-card">
    <div class="ledger-heading">
      <div class="section-title">
        <div class="title-icon"><Tickets /></div>
        <h2>{{ futures ? '合约下单' : '市价买入' }}</h2>
      </div>
      <span v-if="session" class="env" :class="{ live: session.environment === 'live' }">
        {{ session.environment === 'live' ? '实盘' : '测试网' }}
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
      <label class="field">
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
      <button type="submit" class="btn primary submit-order" :disabled="inFlight || !!pending">
        {{ !session ? '连接账户后下单' : inFlight ? '正在处理…' : '预览订单' }}
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
          <dd>{{ session.name }} · {{ session.environment === 'live' ? '实盘' : '测试网' }}</dd>
        </div>
        <div>
          <dt>交易对</dt>
          <dd>{{ preview.input.symbol }} · {{ futures ? 'U 本位永续' : '现货' }}</dd>
        </div>
        <template v-if="preview.kind === 'futures'">
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
            <dt>预估名义金额</dt>
            <dd>
              {{
                formatNumber(Number(preview.input.quantity) * Number(preview.input.price ?? price))
              }}
              USDT
            </dd>
          </div>
        </template>
        <div v-else>
          <dt>市价买入金额</dt>
          <dd>{{ preview.input.quoteOrderQty }} USDT</dd>
        </div>
        <div>
          <dt>市场参考价</dt>
          <dd>{{ formatNumber(Number(price)) }} USDT</dd>
        </div>
      </dl>
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
