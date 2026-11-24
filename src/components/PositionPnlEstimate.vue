<script setup lang="ts">
import { computed, ref } from 'vue'
import { linearPnl } from '../pnl'
import { formatNumber } from '../trades'

const props = defineProps<{ symbol: string; markPrice: string }>()
const direction = ref<'LONG' | 'SHORT'>('LONG')
const entry = ref('')
const quantity = ref('')
const target = ref('')
const estimate = computed(() =>
  linearPnl(
    direction.value,
    Number(entry.value),
    Number(target.value || props.markPrice),
    Number(quantity.value),
  ),
)
</script>

<template>
  <details class="pnl-estimate">
    <summary>合约盈亏试算</summary>
    <div class="estimate-fields">
      <label class="field">
        <span>持仓方向</span>
        <select v-model="direction">
          <option value="LONG">多仓</option>
          <option value="SHORT">空仓</option>
        </select>
      </label>
      <label class="field">
        <span>数量（{{ symbol.slice(0, -4) }}）</span>
        <input v-model.trim="quantity" inputmode="decimal" placeholder="0.00" />
      </label>
      <label class="field">
        <span>开仓均价（USDT）</span>
        <input v-model.trim="entry" inputmode="decimal" placeholder="0.00" />
      </label>
      <label class="field">
        <span>估算价格（USDT）</span>
        <input v-model.trim="target" inputmode="decimal" :placeholder="markPrice || '输入目标价'" />
      </label>
    </div>
    <div class="estimated-result">
      <span>预估毛盈亏</span>
      <strong
        :class="{ gain: estimate != null && estimate > 0, loss: estimate != null && estimate < 0 }"
      >
        {{ estimate != null && estimate > 0 ? '+' : '' }}{{ formatNumber(estimate) }} USDT
      </strong>
    </div>
    <p class="ticket-hint">估算价格留空时取标记价格。结果未计入手续费和资金费。</p>
  </details>
</template>
