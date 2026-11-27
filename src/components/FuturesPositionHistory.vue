<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getFuturesPositionHistory, type Environment, type FuturesPositionHistory } from '../futures'
import { formatReturnRate } from '../pnl'
import { formatAmount, formatNumber, formatTradeTime } from '../trades'

const props = defineProps<{ token: string; environment: Environment; revision: number }>()
const data = ref<FuturesPositionHistory | null>(null)
const error = ref('')
const retry = ref(0)
const page = ref(1)
const pageSizes = [10, 20, 50]
const pageSize = ref(pageSizes[0])
const pageCount = computed(() => Math.max(1, Math.ceil((data.value?.rows.length ?? 0) / pageSize.value)))
const rows = computed(() => data.value?.rows.slice((page.value - 1) * pageSize.value, page.value * pageSize.value) ?? [])
const incomplete = computed(() => data.value?.rows.some(row => row.openedAt === null))
const amount = (value: string | null) => value === null ? null : Number(value)

watch([() => props.token, () => props.environment, () => props.revision, retry], async ([token, environment], _, cleanup) => {
  data.value = null
  error.value = ''
  page.value = 1
  const controller = new AbortController()
  cleanup(() => controller.abort())
  try {
    const result = await getFuturesPositionHistory(token, environment, controller.signal)
    if (controller.signal.aborted) return
    if (result.environment !== environment || !Array.isArray(result.rows)) throw Error('返回的仓位历史与当前账户环境不一致。')
    data.value = result
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '读取仓位历史失败。'
  }
}, { immediate: true })
</script>

<template>
  <section class="position-history" aria-label="合约仓位历史" :aria-busy="!data && !error">
    <div class="history-info">
      <span>最近 7 天完全平仓 · 所有交易对</span>
      <span v-if="data">截至 {{ formatTradeTime(data.asOf) }} UTC+8</span>
    </div>
    <p v-if="error" class="notice warning" role="status">
      {{ error }} <button type="button" class="text-button" @click="retry++">重新读取</button>
    </p>
    <p v-else-if="!data" class="blank-row" role="status">正在读取账户成交并核对仓位…</p>
    <template v-else>
      <p v-if="incomplete" class="notice warning" role="status">部分仓位的开仓成交超出币安可查询的历史范围，相关汇总显示为「—」。</p>
      <div v-if="rows.length" class="table-scroll" tabindex="0" aria-label="完全平仓明细">
        <table>
          <thead><tr>
            <th scope="col">合约</th><th scope="col">方向</th><th scope="col" class="numeric">已实现盈亏</th>
            <th scope="col" class="numeric">收益率（估算）</th>
            <th scope="col" class="numeric">开仓均价</th><th scope="col" class="numeric">平仓均价</th>
            <th scope="col" class="numeric">已平仓量</th><th scope="col">开仓时间</th><th scope="col">平仓时间</th>
          </tr></thead>
          <tbody><tr v-for="row in rows" :key="row.id">
            <td><strong>{{ row.symbol }}</strong></td>
            <td>{{ row.direction === 'LONG' ? '多仓' : '空仓' }}</td>
            <td class="numeric pnl-cell" :class="{ gain: Number(row.realizedPnl) > 0, loss: Number(row.realizedPnl) < 0 }">
              {{ formatAmount(amount(row.realizedPnl)) }} <small v-if="row.realizedPnl !== null && row.asset">{{ row.asset }}</small>
            </td>
            <td class="numeric pnl-cell" :class="{ gain: (row.roi ?? 0) > 0, loss: (row.roi ?? 0) < 0 }"
              :title="row.roiLeverage == null ? '缺少可用于估算的杠杆或开仓成交' : `按当前 ${row.roiLeverage} 倍杠杆估算`">
              {{ formatReturnRate(row.roi) }}
            </td>
            <td class="numeric">{{ formatNumber(amount(row.avgEntryPrice)) }}</td>
            <td class="numeric">{{ formatNumber(amount(row.avgClosePrice)) }}</td>
            <td class="numeric">{{ formatNumber(amount(row.closedQuantity)) }}</td>
            <td>{{ row.openedAt === null ? '—' : formatTradeTime(row.openedAt) }}</td>
            <td>{{ formatTradeTime(row.closedAt) }}</td>
          </tr></tbody>
        </table>
      </div>
      <p v-else class="blank-row">最近 7 天没有完全平仓的仓位。</p>
      <div v-if="rows.length" class="ledger-footer history-footer">
        <span>共 {{ data.rows.length }} 个仓位 · 收益率按当前杠杆估算，手续费和资金费另计</span>
        <div class="history-pages" role="group" aria-label="仓位历史分页">
          <label class="history-page-size">
            <span>每页</span>
            <select v-model="pageSize" aria-label="每页条数" @change="page = 1">
              <option v-for="size in pageSizes" :key="size" :value="size">{{ size }} 条</option>
            </select>
          </label>
          <button type="button" class="btn small" :disabled="page === 1" @click="page--">上一页</button>
          <span aria-live="polite">{{ page }} / {{ pageCount }}</span>
          <button type="button" class="btn small" :disabled="page === pageCount" @click="page++">下一页</button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.history-info { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 18px; padding: 14px 21px; color: var(--muted); font-size: 12px; }
.position-history .notice { margin-inline: 20px; }
.position-history table { min-width: 1000px; }
.history-footer { flex-wrap: wrap; gap: 8px; }
.history-pages { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.history-page-size { display: flex; align-items: center; gap: 6px; }
.history-page-size select { min-height: 30px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); font: inherit; }
@media (max-width: 600px) { .history-info { padding-inline: 15px; } }
</style>
