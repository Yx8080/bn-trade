<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Search, Refresh, TrendCharts } from '@element-plus/icons-vue'
import { getQuote, getSpotQuote, type CopyConfig, type FuturesSession } from '../futures'
import { subscribeMarketQuote } from '../market-stream'
import type { LeadPortfolio } from '../portfolios'
import { formatNumber, formatTradeTime } from '../trades'
import OrderTicket from './OrderTicket.vue'
import AccountOverview from './AccountOverview.vue'
import PositionPnlEstimate from './PositionPnlEstimate.vue'
import CopyTrading from './CopyTrading.vue'

const props = defineProps<{
  market: 'spot' | 'futures'
  session: FuturesSession | null
  token: string
  initialSymbol: string
  entries: LeadPortfolio[]
}>()
const futuresTab = defineModel<'copy' | 'manual'>('futuresTab', { required: true })
const copyDraft = defineModel<CopyConfig | null>('copyDraft', { required: true })
const emit = defineEmits<{ connect: []; edit: [] }>()
const symbol = ref(props.initialSymbol)
const symbolInput = ref(symbol.value)
const symbolError = ref('')
const price = ref('')
const markPrice = ref('')
const environment = ref('')
const lastQuote = ref(0)
const lastTradeTime = ref(0)
const quoteError = ref('')
const loading = ref(false)
const refresh = ref(0)
const accountRefresh = ref(0)
const futures = computed(() => props.market === 'futures')
const manual = computed(() => !futures.value || futuresTab.value === 'manual')
const pageVisible = ref(!document.hidden)
const quoteEnvironment = computed(() => props.session?.environment ?? 'live')
const orderQuoteTime = computed(() => futures.value ? Math.min(lastQuote.value, lastTradeTime.value) : lastTradeTime.value)
const visibility = () => { pageVisible.value = !document.hidden }
onMounted(() => document.addEventListener('visibilitychange', visibility))
onUnmounted(() => document.removeEventListener('visibilitychange', visibility))
const base = computed(() => symbol.value.slice(0, -4))
function selectSymbol(value: string) {
  const clean = value.trim().toUpperCase()
  if (!/^[\p{Lu}\p{Lo}\p{Nd}]{1,28}USDT$/u.test(clean)) {
    symbolError.value = '请输入 USDT 交易对，例如 BTCUSDT。'
    return
  }
  symbolError.value = ''
  symbolInput.value = clean
  if (symbol.value === clean) refresh.value++
  symbol.value = clean
}
watch(
  [symbol, refresh, manual, pageVisible, quoteEnvironment, () => props.market],
  ([pair, , manualView, visible, accountEnvironment, market], _, cleanUp) => {
    price.value = ''
    markPrice.value = ''
    lastQuote.value = 0
    lastTradeTime.value = 0
    environment.value = ''
    quoteError.value = ''
    if (!manualView || !visible) return
    const read = market === 'futures' ? getQuote : getSpotQuote
    cleanUp(subscribeMarketQuote(market, accountEnvironment, pair, signal => read(pair, signal, accountEnvironment),
      quote => {
        price.value = quote.price
        markPrice.value = quote.mark
        lastQuote.value = market === 'futures' ? quote.markTime : quote.priceTime
        lastTradeTime.value = quote.priceTime
        environment.value = accountEnvironment
        if (Date.now() - orderQuoteTime.value < 60_000) quoteError.value = ''
      },
      message => { quoteError.value = message },
      busy => { loading.value = busy },
    ))
  },
  { immediate: true },
)
</script>

<template>
  <header class="page-heading">
    <div>
      <h1>{{ futures ? '合约交易' : '现货买入' }}</h1>
      <p>
        {{
          futures
            ? (manual ? '查看 U 本位合约行情、持仓盈亏与账户余额。' : '按带单员的新成交，在当前账户执行 U 本位合约跟单。')
            : '查看现货行情与余额，按 USDT 金额市价买入。'
        }}
      </p>
    </div>
  </header>
  <nav v-if="futures" class="trade-tabs" aria-label="合约交易方式">
    <button type="button" :aria-pressed="!manual" @click="futuresTab = 'copy'">跟单交易</button>
    <button type="button" :aria-pressed="manual" @click="futuresTab = 'manual'">手动交易</button>
  </nav>
  <CopyTrading v-if="!manual" :entries="entries" :session="session" :token="token"
    v-model:draft="copyDraft" @connect="emit('connect')" @edit="emit('edit')" />
  <div v-else class="trading-grid">
    <section class="panel market-card">
      <div class="ledger-heading">
        <div class="section-title">
          <div class="title-icon"><TrendCharts /></div>
          <h2>市场行情</h2>
        </div>
        <button
          class="icon-button"
          title="刷新行情"
          aria-label="刷新行情"
          :disabled="loading"
          @click="refresh++"
        >
          <Refresh />
        </button>
      </div>
      <div class="market-body">
        <form class="symbol-search" @submit.prevent="selectSymbol(symbolInput)">
          <label class="field">
            <span>USDT 交易对</span>
            <input v-model="symbolInput" placeholder="BTCUSDT" spellcheck="false" required />
          </label>
          <button class="btn" type="submit">
            <Search />
            查询
          </button>
        </form>
        <div class="symbol-picks">
          <button
            v-for="coin in ['BTC', 'ETH', 'SOL', 'BNB']"
            :key="coin"
            type="button"
            :class="{ picked: coin === base }"
            @click="selectSymbol(coin + 'USDT')"
          >
            {{ coin }}
          </button>
        </div>
        <p v-if="symbolError" class="notice error" role="alert">{{ symbolError }}</p>
        <div class="quote-board">
          <div class="quote-title">
            <strong>
              {{ base }}
              <small>/ USDT</small>
            </strong>
            <span>
              {{ futures ? '永续合约' : '现货'
              }}{{ environment ? (environment === 'live' ? ' · 实盘' : ' · 测试网') : '' }}
            </span>
          </div>
          <div class="quote-label">最新价格</div>
          <div class="quote-price">
            {{ price ? formatNumber(Number(price)) : '—' }}
            <small>USDT</small>
          </div>
          <div v-if="futures" class="quote-mark">
            标记价格
            <strong>{{ markPrice ? formatNumber(Number(markPrice)) : '—' }}</strong>
          </div>
          <div v-if="futures && lastTradeTime" class="quote-time">最新价更新时间 {{ formatTradeTime(lastTradeTime) }} UTC+8</div>
          <div class="quote-time">
            {{
              lastQuote
                ? (futures ? '标记价时间 ' : '最新报价时间 ') + formatTradeTime(lastQuote) + ' UTC+8'
                : loading
                  ? '正在获取行情…'
                  : '等待行情'
            }}
          </div>
        </div>
        <p v-if="quoteError" class="notice error" role="status">{{ quoteError }}</p>
        <PositionPnlEstimate
          v-if="futures"
          :key="symbol"
          :symbol="symbol"
          :mark-price="quoteError ? '' : markPrice"
        />
      </div>
    </section>
    <OrderTicket
      :market="market"
      :symbol="symbol"
      :price="price"
      :quote-time="orderQuoteTime"
      :quote-environment="quoteError ? '' : environment"
      :session="session"
      :token="token"
      @connect="emit('connect')"
      @ordered="accountRefresh++"
    />
  </div>
  <AccountOverview
    v-if="manual"
    :market="market"
    :session="session"
    :token="token"
    :revision="accountRefresh"
    @connect="emit('connect')"
  />
</template>
