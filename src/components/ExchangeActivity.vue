<script setup lang="ts">
import { ref, watch } from 'vue'
import { getOtherTrades, type OtherTrades } from '../futures'
import { formatNumber, formatTradeTime } from '../trades'

const props = defineProps<{ token: string; revision: number }>()
const market = ref<'futures' | 'spot'>('futures')
const symbol = ref('BTCUSDT')
const input = ref(symbol.value)
const retry = ref(0)
const data = ref<OtherTrades | null>(null)
const loading = ref(false)
const error = ref('')
const symbolError = ref('')

function search() {
  const next = input.value.trim().toUpperCase()
  if (!/^[\p{Lu}\p{Lo}\p{Nd}]{2,32}$/u.test(next)) {
    symbolError.value = '请输入交易对，例如 ETHUSDT 或 ETHBTC。'
    return
  }
  symbolError.value = ''
  input.value = next
  if (next === symbol.value) retry.value++
  else symbol.value = next
}
watch([() => props.token, market, symbol, () => props.revision, retry], async ([token, selected, pair], _, onCleanup) => {
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  data.value = null
  error.value = ''
  loading.value = true
  try {
    const result = await getOtherTrades(token, selected, pair, controller.signal)
    if (controller.signal.aborted) return
    if (result.market !== selected || result.symbol !== pair) throw Error('返回的交易对与当前查询不一致，请重试。')
    data.value = result
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '读取交易所记录失败。'
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}, { immediate: true })
</script>

<template>
  <section class="panel exchange-activity" aria-label="交易所账户参考" :aria-busy="loading">
    <div class="ledger-heading"><h2>交易所账户参考</h2><span class="env">仅供查看</span></div>
    <p class="exchange-note">这里的账户数据独立于平台盈亏。成交列表仅展示未关联平台订单的交易所成交。</p>
    <div class="exchange-tools">
      <nav class="trade-tabs" aria-label="交易所市场">
        <button type="button" :aria-pressed="market === 'futures'" @click="market = 'futures'">合约</button>
        <button type="button" :aria-pressed="market === 'spot'" @click="market = 'spot'">现货</button>
      </nav>
      <form class="exchange-search" @submit.prevent="search">
        <label class="field"><span>成交交易对</span><input v-model="input" spellcheck="false" required /></label>
        <button type="submit" class="btn">查询</button>
      </form>
    </div>
    <p v-if="symbolError" class="notice error" role="alert">{{ symbolError }}</p>
    <p v-if="error" class="notice warning" role="status">{{ error }} <button type="button" class="text-button" @click="retry++">重新读取</button></p>
    <p v-if="loading" class="exchange-note" role="status">正在读取交易所账户数据…</p>
    <template v-if="data">
      <template v-if="market === 'futures'">
        <h3>交易所合约账户持仓</h3>
        <p class="exchange-note">按交易所账户展示全部持仓，可能同时包含平台与其他来源的交易。</p>
        <div v-if="data.positions.length" class="table-scroll"><table>
          <thead><tr><th>交易对</th><th>方向</th><th class="numeric">持仓数量</th><th class="numeric">开仓均价</th>
            <th class="numeric">标记价格</th><th class="numeric">浮动盈亏</th></tr></thead>
          <tbody><tr v-for="row in data.positions" :key="row.symbol + row.positionSide">
            <td>{{ row.symbol }}</td><td>{{ row.positionSide === 'SHORT' || Number(row.quantity) < 0 ? '空' : '多' }}</td>
            <td class="numeric">{{ formatNumber(Math.abs(Number(row.quantity))) }}</td>
            <td class="numeric">{{ formatNumber(Number(row.entryPrice)) }}</td><td class="numeric">{{ formatNumber(Number(row.markPrice)) }}</td>
            <td class="numeric">{{ formatNumber(Number(row.unrealizedPnl)) }} {{ row.marginAsset }}</td>
          </tr></tbody>
        </table></div>
        <p v-else class="exchange-note">当前合约账户无持仓。</p>
      </template>
      <template v-else>
        <h3>交易所现货账户余额</h3>
        <p class="exchange-note">资产代码由币安提供。理财余额可能带有 LD 前缀，例如 LDUSDC。每行数量均以该行资产为单位。</p>
        <div v-if="data.balances.length" class="table-scroll"><table>
          <thead><tr><th>资产代码</th><th class="numeric">可用数量</th><th class="numeric">冻结数量</th></tr></thead>
          <tbody><tr v-for="row in data.balances" :key="row.asset"><td>{{ row.asset }}</td>
            <td class="numeric">{{ formatNumber(Number(row.free)) }}</td><td class="numeric">{{ formatNumber(Number(row.locked)) }}</td>
          </tr></tbody>
        </table></div>
        <p v-else class="exchange-note">账户暂无非零现货余额。</p>
      </template>
      <h3>{{ symbol }} 的其他交易所成交</h3>
      <p class="exchange-note">{{ market === 'futures' ? '从该合约近 7 天内最近 100 笔成交中筛选' : '从该交易对最近 100 笔成交中筛选' }}，已排除可确认的平台订单。</p>
      <div v-if="data.trades.length" class="table-scroll"><table>
        <thead><tr><th>成交时间（UTC+8）</th><th>币安订单号</th><th>来源</th><th>方向</th><th class="numeric">成交数量</th><th class="numeric">成交价格</th>
          <th v-if="market === 'futures'" class="numeric">已实现盈亏</th><th class="numeric">手续费</th></tr></thead>
        <tbody><tr v-for="row in data.trades" :key="row.id">
          <td>{{ formatTradeTime(row.time) }}</td><td>{{ row.orderId }}</td>
          <td>{{ row.source === 'unverified' ? '归属待核实' : '交易所直接成交' }}</td>
          <td>{{ row.side === 'BUY' ? '买入' : '卖出' }}{{ row.positionSide === 'LONG' ? ' · 多' : row.positionSide === 'SHORT' ? ' · 空' : '' }}</td>
          <td class="numeric">{{ formatNumber(Number(row.quantity)) }}</td><td class="numeric">{{ formatNumber(Number(row.price)) }}</td>
          <td v-if="market === 'futures'" class="numeric">{{ row.realizedPnl == null ? '—' : formatNumber(Number(row.realizedPnl)) + ' ' + (row.marginAsset ?? '') }}</td>
          <td class="numeric">{{ formatNumber(Number(row.commission)) }} {{ row.commissionAsset }}</td>
        </tr></tbody>
      </table></div>
      <p v-else class="exchange-note">该交易对近期无交易所直接成交。</p>
    </template>
  </section>
</template>

<style scoped>
.exchange-activity { margin-top: 18px; padding-bottom: 6px; overflow: hidden; }
.exchange-activity h3 { font-size: 14px; margin: 15px 20px 8px; }
.exchange-tools { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; margin: 12px 20px; }
.exchange-tools .trade-tabs { margin: 0; }
.exchange-search { display: flex; align-items: end; gap: 6px; }
.exchange-search .field { max-width: 155px; }
.exchange-note { font-size: 12px; line-height: 1.65; margin: 0 20px 10px; color: var(--muted); }
.exchange-activity .notice { margin-inline: 20px; }
</style>
