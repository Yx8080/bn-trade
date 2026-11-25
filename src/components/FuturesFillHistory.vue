<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getFuturesFills, type FuturesFills, type PositionSource } from '../futures'
import type { LeadPortfolio } from '../portfolios'
import { formatNumber, formatTradeTime } from '../trades'
import TradeSource from './TradeSource.vue'

const props = defineProps<{ token: string; entries: LeadPortfolio[]; revision: number }>()
const symbol = defineModel<string>('symbol', { required: true })
const input = ref(symbol.value)
const inputError = ref('')
const refresh = ref(0)
const data = ref<FuturesFills | null>(null)
const loading = ref(false)
const error = ref('')
const page = ref(1)
const pageSize = 10
const pageCount = computed(() => Math.max(1, Math.ceil((data.value?.trades.length ?? 0) / pageSize)))
const rows = computed(() => data.value?.trades.slice((page.value - 1) * pageSize, page.value * pageSize) ?? [])
const kinds: Record<FuturesFills['trades'][number]['source'], PositionSource['kind']> = {
  manual: 'manual', copy: 'copy', untracked: 'external', unverified: 'unknown',
}

function search() {
  const pair = input.value.trim().toUpperCase()
  if (!/^[\p{Lu}\p{Lo}\p{Nd}]{2,32}$/u.test(pair)) {
    inputError.value = '请输入完整的合约交易对，例如 BTCUSDT。'
    return
  }
  inputError.value = ''
  input.value = pair
  page.value = 1
  if (symbol.value === pair) refresh.value++
  else symbol.value = pair
}
watch([symbol, () => props.token, refresh, () => props.revision], async ([pair, token], previous, cleanup) => {
  const controller = new AbortController()
  cleanup(() => controller.abort())
  if (pair !== previous?.[0] || token !== previous?.[1]) {
    input.value = pair
    inputError.value = ''
    page.value = 1
    data.value = null
  }
  error.value = ''
  loading.value = true
  try {
    const result = await getFuturesFills(token, pair, controller.signal)
    if (controller.signal.aborted) return
    if (result.market !== 'futures' || result.symbol !== pair || !Array.isArray(result.trades)
      || result.limit !== 100 || result.windowDays !== 7) throw Error('成交记录与当前查询不一致，请重新查询。')
    data.value = result
    page.value = Math.min(page.value, pageCount.value)
  } catch (cause) {
    if (controller.signal.aborted) return
    data.value = null
    error.value = cause instanceof Error ? cause.message : '读取成交记录失败。'
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}, { immediate: true })
</script>

<template>
  <section class="fill-history" aria-label="合约成交记录" :aria-busy="loading">
    <div class="fill-tools">
      <form class="fill-search" @submit.prevent="search">
        <label class="field"><span>成交交易对</span>
          <input v-model="input" placeholder="BTCUSDT" required spellcheck="false" autocapitalize="characters" />
        </label>
        <button type="submit" class="btn small">查询</button>
      </form>
      <p class="fill-coverage">{{ symbol }} · 近 7 天内最近 100 笔成交</p>
    </div>
    <p v-if="inputError" class="notice error" role="alert">{{ inputError }}</p>
    <p v-if="error" class="notice warning" role="status">{{ error }}
      <button type="button" class="text-button" @click="refresh++">重新读取</button>
    </p>
    <p v-else-if="!data" class="blank-row" role="status">正在读取 {{ symbol }} 成交记录…</p>
    <template v-else>
      <div v-if="rows.length" class="table-scroll" tabindex="0" aria-label="合约成交明细">
        <table>
          <thead><tr>
            <th scope="col">成交时间（UTC+8）</th><th scope="col">合约</th><th scope="col">来源</th>
            <th scope="col">方向</th><th scope="col" class="numeric">成交数量</th><th scope="col" class="numeric">成交价格</th><th scope="col">币安订单号</th>
          </tr></thead>
          <tbody><tr v-for="row in rows" :key="row.id">
            <td>{{ formatTradeTime(row.time) }}</td><td><strong>{{ row.symbol }}</strong></td>
            <td><TradeSource :sources="[{ kind: kinds[row.source], portfolioId: row.portfolioId }]" :complete="row.source !== 'unverified'" :entries="entries" /></td>
            <td>{{ row.side === 'BUY' ? '买入' : '卖出' }}{{ row.positionSide === 'LONG' ? ' · 多仓' : row.positionSide === 'SHORT' ? ' · 空仓' : '' }}</td>
            <td class="numeric">{{ formatNumber(Number(row.quantity)) }}</td>
            <td class="numeric">{{ formatNumber(Number(row.price)) }}</td><td>{{ row.orderId }}</td>
          </tr></tbody>
        </table>
      </div>
      <p v-else class="blank-row">近 7 天没有 {{ symbol }} 的成交记录。</p>
      <div v-if="rows.length" class="ledger-footer">
        <span>{{ data.atLimit ? '已显示最近 ' + data.limit + ' 笔' : '共 ' + data.trades.length + ' 笔' }}</span>
        <div v-if="pageCount > 1" class="fill-pages" role="group" aria-label="成交记录分页">
          <button type="button" class="btn small" :disabled="page === 1" @click="page--">上一页</button>
          <span aria-live="polite">{{ page }} / {{ pageCount }}</span>
          <button type="button" class="btn small" :disabled="page === pageCount" @click="page++">下一页</button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.fill-tools { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 8px 18px; padding: 14px 21px; }
.fill-search, .fill-pages { display: flex; align-items: end; gap: 8px; }
.fill-search .field { max-width: 155px; }
.fill-search .btn { min-height: 38px; }
.fill-coverage { margin: 0; color: var(--muted); font-size: 12px; }
.fill-history .notice { margin-inline: 20px; }
.fill-pages { align-items: center; }
.fill-history table { min-width: 760px; }
@media (max-width: 600px) { .fill-tools { padding-inline: 15px; } }
</style>
