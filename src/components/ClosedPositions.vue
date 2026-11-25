<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Finished, Refresh } from '@element-plus/icons-vue'
import type { LeadPortfolio } from '../portfolios'
import { fetchClosedPositions, formatNumber, formatTradeAmount, formatTradeTime, type ClosedPosition } from '../trades'

const props = defineProps<{ entries: LeadPortfolio[]; updatedAtById: Record<string, number> }>()
const emit = defineEmits<{ quote: [symbol: string] }>()
const selected = ref(props.entries[0]?.id ?? '')
const page = ref(1)
const refresh = ref(0)
const lastResult = ref<{ id: string; page: number; pages: number; rows: ClosedPosition[]; updatedAt: number }>()
const portfolioResult = computed(() => lastResult.value?.id === selected.value ? lastResult.value : undefined)
const currentResult = computed(() => portfolioResult.value?.page === page.value ? portfolioResult.value : undefined)
const rows = computed(() => currentResult.value?.rows ?? [])
const loading = ref(false)
const error = ref('')

function choosePortfolio(event: Event) {
  selected.value = (event.target as HTMLSelectElement).value
  page.value = 1
}

const observedChanges = new Map<string, number>()
watch([selected, () => props.updatedAtById[selected.value]], ([id, changedAt], [previousId]) => {
  if (!changedAt || observedChanges.get(id) === changedAt) return
  observedChanges.set(id, changedAt)
  if (id === previousId && page.value === 1) refresh.value++
}, { immediate: true })

watch([selected, page, refresh], async ([id, number], _, onCleanup) => {
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  error.value = ''
  loading.value = Boolean(id)
  if (!id) return
  try {
    const result = await fetchClosedPositions(id, number, controller.signal)
    if (controller.signal.aborted) return
    const pages = Math.max(1, Math.ceil(result.total / result.pageSize))
    if (number > pages) page.value = pages
    else lastResult.value = { id, page: number, pages, rows: result.rows, updatedAt: Date.now() }
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '暂时无法读取本地平仓记录。'
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}, { immediate: true })
</script>

<template>
  <section class="panel" aria-label="已平仓位" :aria-busy="loading">
    <div class="ledger-heading">
      <div class="section-title">
        <div class="title-icon"><Finished /></div>
        <h2>已平仓位</h2>
      </div>
      <button class="btn small" :disabled="loading || !selected" @click="refresh++">
        <Refresh />{{ loading ? '读取中' : error ? '重试' : '刷新' }}
      </button>
    </div>
    <div class="position-controls">
      <label v-if="entries.length" class="field">
        <span>带单组合</span>
        <select :value="selected" @change="choosePortfolio">
          <option v-for="entry in entries" :key="entry.id" :value="entry.id">{{ entry.name || entry.id }}</option>
        </select>
      </label>
      <p>列表读取本地记录。监控到对应的平仓成交时，才从币安披露中补入缺少的仓位或字段。</p>
    </div>
    <p v-if="error" class="notice error" role="alert">
      {{ error }}
      <span v-if="currentResult">显示 {{ formatTradeTime(currentResult.updatedAt) }} 更新的数据。</span>
    </p>
    <div v-if="!error || currentResult" class="table-scroll">
      <table>
        <thead><tr>
          <th>交易对</th><th>持仓方向</th><th class="numeric">整仓盈亏</th><th class="numeric">收益率</th>
          <th class="numeric">开仓均价</th><th class="numeric">平仓均价</th><th class="numeric">平仓数量</th><th>平仓时间（UTC+8）</th>
        </tr></thead>
        <tbody>
          <tr v-for="row in rows" :key="row.positionId">
            <td>
              <button v-if="row.symbol.endsWith('USDT')" class="text-button" @click="emit('quote', row.symbol)">{{ row.symbol }}</button>
              <strong v-else>{{ row.symbol }}</strong>
            </td>
            <td>{{ row.side === 'Long' ? '多仓' : row.side === 'Short' ? '空仓' : row.side || '—' }}</td>
            <td class="numeric pnl-cell" :class="{ gain: (row.closingPnl ?? 0) > 0, loss: (row.closingPnl ?? 0) < 0 }">
              {{ row.closingPnl == null ? '未披露' : (row.closingPnl > 0 ? '+' : '') + formatTradeAmount(row.closingPnl) }}
              <small v-if="row.closingPnl != null">{{ row.asset }}</small>
            </td>
            <td class="numeric">{{ row.roi == null ? '—' : formatNumber(row.roi * 100) + '%' }}</td>
            <td class="numeric">{{ formatTradeAmount(row.avgCost) }}</td>
            <td class="numeric">{{ formatTradeAmount(row.avgClosePrice) }}</td>
            <td class="numeric">{{ formatNumber(row.closedVolume) }}</td>
            <td class="time-cell">{{ row.closed == null ? '—' : formatTradeTime(row.closed) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!rows.length" class="blank-row" role="status">
        {{ !selected ? '添加带单组合后可查看仓位。' : loading && !currentResult ? '正在读取本地记录…' : '本地尚未记录这个组合的整仓平仓披露。' }}
      </p>
    </div>
    <div v-if="portfolioResult" class="ledger-footer">
      <button class="text-button" :disabled="loading || page <= 1" @click="page--">上一页</button>
      <span>第 {{ page }} / {{ portfolioResult.pages }} 页</span>
      <button class="text-button" :disabled="loading || page >= portfolioResult.pages" @click="page++">下一页</button>
    </div>
  </section>
</template>

<style scoped>
.position-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 12px 20px; padding: 0 22px 17px; }
.position-controls label { min-width: min(220px, 100%); }
.position-controls p { color: var(--muted, #53675c); font-size: 14px; }
</style>
