<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { DataAnalysis, Search, Refresh, Tickets, TrendCharts } from '@element-plus/icons-vue'
import { getQuote, getSpotQuote, type BoundSession, type CopyConfig, type Environment } from '../futures'
import { subscribeMarketQuote } from '../market-stream'
import { useTradingAccount } from '../useTradingAccount'
import { useFuturesLeverage } from '../useFuturesLeverage'
import type { LeadPortfolio } from '../portfolios'
import { formatNumber, formatTradeTime } from '../trades'
import { isAppLeverage, MIN_LEVERAGE } from '../../shared/leverage.js'
import OrderTicket from './OrderTicket.vue'
import AccountOverview from './AccountOverview.vue'
import PositionPnlEstimate from './PositionPnlEstimate.vue'
import CopyTrading from './CopyTrading.vue'

const props = defineProps<{
  market: 'spot' | 'futures'
  environment: Environment
  session: BoundSession | null
  token: string
  entries: LeadPortfolio[]
}>()
const futuresTab = defineModel<'copy' | 'manual'>('futuresTab', { required: true })
const copyDraft = defineModel<CopyConfig | null>('copyDraft', { required: true })
const emit = defineEmits<{ connect: []; edit: [] }>()
const symbol = defineModel<string>('symbol', { required: true })
const symbolInput = ref(symbol.value)
const symbolError = ref('')
const price = ref('')
const markPrice = ref('')
const quoteSource = ref<Environment | ''>('')
const lastQuote = ref(0)
const lastTradeTime = ref(0)
const quoteError = ref('')
const loading = ref(false)
const refresh = ref(0)
const futures = computed(() => props.market === 'futures')
const manual = computed(() => !futures.value || futuresTab.value === 'manual')
const manualVisited = ref(manual.value)
watch(manual, selected => { if (selected) manualVisited.value = true })
const pageVisible = ref(!document.hidden)
const activeSession = computed(() => props.session?.environment === props.environment ? props.session : null)
const orderTicket = useTemplateRef('orderTicket')
const pnlDraft = ref<{ entry: string; margin: string; leverage: number } | null>(null)
const { info: leverageInfo, publicMaxLeverage, error: leverageError, loading: leverageLoading, refresh: refreshLeverage } =
  useFuturesLeverage(() => futures.value && (manual.value || pnlDraft.value) ? symbol.value : '',
    () => activeSession.value, () => props.token, () => props.environment)
const currentLeverage = computed(() => leverageInfo.value?.leverage ?? undefined)
const symbolMaxLeverage = computed(() => leverageInfo.value?.symbolMaxLeverage ?? publicMaxLeverage.value)
const orderMaxLeverage = computed(() => leverageInfo.value?.maxLeverage ?? symbolMaxLeverage.value)

function freshPrice() {
  return quoteSource.value === props.environment && lastTradeTime.value > 0
    && Math.abs(Date.now() - lastTradeTime.value) < 60_000 ? price.value : ''
}

function openPnl() {
  const defaults = manual.value ? orderTicket.value?.pnlDefaults() : undefined
  const leverage = defaults?.leverage ?? currentLeverage.value
  pnlDraft.value = {
    entry: defaults?.entry || freshPrice(),
    margin: defaults?.margin ?? '',
    leverage: leverage != null && isAppLeverage(leverage, symbolMaxLeverage.value) ? leverage : MIN_LEVERAGE,
  }
}

watch(symbol, () => { pnlDraft.value = null })
const { account, spotAccount, fetchedAt, loading: loadingAccount, error: accountError, funds, refreshAccount } =
  useTradingAccount(() => props.market, () => activeSession.value, () => props.token)
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
  [symbol, refresh, pageVisible, () => props.environment, () => props.market],
  ([pair, , visible, selected, market], _, cleanUp) => {
    price.value = ''
    markPrice.value = ''
    lastQuote.value = 0
    lastTradeTime.value = 0
    quoteSource.value = ''
    quoteError.value = ''
    if (!visible) return
    const read = market === 'futures' ? getQuote : getSpotQuote
    cleanUp(subscribeMarketQuote(market, selected, pair, signal => read(pair, signal, selected),
      quote => {
        price.value = quote.price
        markPrice.value = quote.mark
        lastQuote.value = market === 'futures' ? quote.markTime : quote.priceTime
        lastTradeTime.value = quote.priceTime
        quoteSource.value = selected
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
            ? '查看 U 本位合约行情、持仓与余额，选择手动下单或跟单交易。'
            : '查看现货行情与余额，按 USDT 金额市价买入。'
        }}
      </p>
    </div>
  </header>
  <div class="trading-grid" :class="{ 'futures-workspace': futures, 'spot-workspace': !futures }">
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
              {{ futures ? '永续合约' : '现货' }} · 实盘
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
      </div>
    </section>
    <div :class="futures ? 'panel futures-actions' : 'spot-actions'">
      <template v-if="futures">
        <div class="ledger-heading">
          <div class="section-title"><Tickets /><h2>合约下单</h2></div>
          <div class="order-heading-actions">
            <button type="button" class="btn small" aria-haspopup="dialog" @click="openPnl">
              <DataAnalysis aria-hidden="true" /> 盈亏试算
            </button>
            <span class="env live">实盘</span>
          </div>
        </div>
        <nav class="trade-tabs order-tabs" aria-label="合约交易方式">
          <button type="button" :aria-pressed="!manual" @click="futuresTab = 'copy'">跟单交易</button>
          <button type="button" :aria-pressed="manual" @click="futuresTab = 'manual'">手动交易</button>
        </nav>
      </template>
      <div :role="futures ? 'region' : undefined" :aria-label="futures ? '合约下单表单' : undefined">
        <CopyTrading v-if="!manual" :entries="entries" :session="activeSession" :token="token"
          :funds="funds" v-model:draft="copyDraft" @connect="emit('connect')" @edit="emit('edit')" @refresh="refreshAccount" />
        <OrderTicket v-if="manualVisited" v-show="manual"
          ref="orderTicket"
          :active="manual"
          :market="market"
          :environment="environment"
          :symbol="symbol"
          :price="price"
          :quote-time="orderQuoteTime"
          :quote-environment="quoteError ? '' : quoteSource"
          :session="activeSession"
          :token="token"
          :funds="funds"
          :positions="account?.positions ?? []"
          :current-leverage="currentLeverage"
          :max-leverage="orderMaxLeverage"
          :leverage-error="leverageError"
          :leverage-loading="leverageLoading"
          @connect="emit('connect')"
          @refresh="refreshAccount"
          @refresh-leverage="refreshLeverage"
          @ordered="refreshAccount"
        />
      </div>
    </div>
  </div>
  <PositionPnlEstimate
    v-if="futures && pnlDraft"
    :symbol="symbol"
    :initial-entry="pnlDraft.entry"
    :initial-margin="pnlDraft.margin"
    :initial-leverage="pnlDraft.leverage"
    :max-leverage="symbolMaxLeverage"
    :latest-price="freshPrice()"
    @close="pnlDraft = null"
  />
  <AccountOverview
    :market="market"
    :symbol="symbol"
    :entries="entries"
    :token="token"
    :session="activeSession"
    :account="account"
    :spot-account="spotAccount"
    :loading="loadingAccount"
    :error="accountError"
    :fetched-at="fetchedAt"
    @connect="emit('connect')"
    @refresh="refreshAccount"
  />
</template>
