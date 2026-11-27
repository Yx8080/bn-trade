<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { isAppLeverage } from '../../shared/leverage.js'
import { linearPnlFromMargin } from '../pnl'
import { formatAmount, numericValue } from '../trades'
import LeverageControl from './LeverageControl.vue'
import WorkspaceDialog from './WorkspaceDialog.vue'

const props = defineProps<{
  symbol: string
  initialEntry: string
  initialMargin: string
  initialLeverage: number
  maxLeverage?: number
  latestPrice: string
}>()
const emit = defineEmits<{ close: [] }>()
const direction = ref<'LONG' | 'SHORT'>('LONG')
const entry = ref<string | null>(props.initialEntry || null)
const target = ref('')
const margin = ref(props.initialMargin)
const leverage = ref<number | null>(props.initialLeverage)
watch(() => props.latestPrice, price => {
  if (price && entry.value === null) entry.value = price
})

function invalidAmount(value: string | null) {
  return Boolean(value) && (numericValue(value) ?? 0) <= 0
}

const invalidLeverage = computed(() => leverage.value !== null && !isAppLeverage(leverage.value, props.maxLeverage))
const estimate = computed(() => {
  if (invalidLeverage.value) return null
  return linearPnlFromMargin(
    direction.value,
    numericValue(entry.value) ?? 0,
    numericValue(target.value) ?? 0,
    numericValue(margin.value) ?? 0,
    leverage.value ?? 0,
  )
})
const issue = computed(() => {
  if (invalidLeverage.value) return props.maxLeverage
    ? '杠杆倍数须为 1 至 ' + props.maxLeverage + ' 的整数。'
    : '请输入正整数杠杆倍数。'
  if (invalidAmount(entry.value) || invalidAmount(target.value) || invalidAmount(margin.value)) {
    return '价格和保证金须大于 0。'
  }
  if (!estimate.value && entry.value && target.value && margin.value && leverage.value) return '数值超出可试算范围。'
  return ''
})
const resultTone = computed(() => {
  const pnl = estimate.value?.pnl ?? 0
  return { gain: pnl > 0, loss: pnl < 0 }
})
const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', signDisplay: 'exceptZero', maximumFractionDigits: 0 })
</script>

<template>
  <WorkspaceDialog class="pnl-dialog" title="合约盈亏试算" @close="emit('close')">
    <div class="pnl-body">
      <p class="pnl-market"><strong>{{ symbol }}</strong><span>U 本位合约</span></p>
      <div class="pnl-directions" role="group" aria-label="交易方向">
        <button type="button" :aria-pressed="direction === 'LONG'" @click="direction = 'LONG'">做多</button>
        <button type="button" :aria-pressed="direction === 'SHORT'" @click="direction = 'SHORT'">做空</button>
      </div>
      <LeverageControl v-model="leverage" label="杠杆倍数" :max="maxLeverage" require-max />
      <div class="two-fields pnl-prices">
        <label class="field">
          <span>开仓价格</span>
          <span class="input-unit">
            <input v-model.trim="entry" inputmode="decimal" placeholder="输入开仓价"
              :autofocus="!initialEntry" :aria-invalid="invalidAmount(entry) || undefined" />
            <b>USDT</b>
          </span>
        </label>
        <label class="field">
          <span>目标平仓价</span>
          <span class="input-unit">
            <input v-model.trim="target" inputmode="decimal" placeholder="输入目标价"
              :autofocus="Boolean(initialEntry)" :aria-invalid="invalidAmount(target) || undefined" />
            <b>USDT</b>
          </span>
        </label>
      </div>
      <label class="field">
        <span>保证金</span>
        <span class="input-unit">
          <input v-model.trim="margin" inputmode="decimal" placeholder="输入计划投入的金额"
            :aria-invalid="invalidAmount(margin) || undefined" />
          <b>USDT</b>
        </span>
      </label>
      <p v-if="issue" class="pnl-issue" role="status">{{ issue }}</p>
      <dl class="pnl-results" aria-live="polite" aria-atomic="true">
        <div>
          <dt>预估盈亏</dt>
          <dd :class="resultTone">{{ estimate ? formatAmount(estimate.pnl, true) + ' USDT' : '—' }}</dd>
        </div>
        <div>
          <dt>预估盈亏率</dt>
          <dd :class="resultTone">{{ estimate ? percent.format(estimate.roi) : '—' }}</dd>
        </div>
      </dl>
      <p class="ticket-hint">按目标价全数平仓估算，未计手续费、资金费及强平。</p>
    </div>
  </WorkspaceDialog>
</template>

<style scoped>
.pnl-body { display: grid; gap: 14px; }
.pnl-market { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
.pnl-market strong { color: var(--ink); overflow-wrap: anywhere; }
.pnl-market span { flex-shrink: 0; }
.pnl-directions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: #f4f6f5;
}
.pnl-directions button {
  min-height: 34px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-weight: 650;
}
.pnl-directions button:hover { background: #e8eeea; }
.pnl-directions button[aria-pressed='true'] { color: #fff; background: var(--green); }
.pnl-directions button:last-child[aria-pressed='true'] { background: #a34236; }
.pnl-body .input-unit input { padding-right: 54px; }
.pnl-body input[aria-invalid='true'] { border-color: #ab493e; }
.pnl-issue { color: #943f2d; font-size: 12px; }
.pnl-results {
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: #f4f7f5;
}
.pnl-results div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
}
.pnl-results div + div { border-top: 1px solid var(--line); }
.pnl-results dt { flex-shrink: 0; color: var(--muted); font-size: 13px; }
.pnl-results dd {
  font-size: 17px;
  font-weight: 680;
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow-wrap: anywhere;
}
@media (max-width: 420px) {
  .pnl-dialog { max-height: calc(100dvh - 24px); }
  .pnl-body { gap: 12px; }
  .pnl-prices { grid-template-columns: minmax(0, 1fr); }
}
</style>
