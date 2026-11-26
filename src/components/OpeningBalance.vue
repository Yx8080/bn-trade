<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { amountFromBalance, type OpeningFunds } from '../opening-funds'
import { formatNumber, formatTradeTime } from '../trades'

const props = defineProps<{ funds: OpeningFunds; slider?: boolean; selectedAmount?: number | null }>()
const emit = defineEmits<{ select: [amount: number]; refresh: []; connect: [] }>()
const stops = [0, 25, 50, 75, 100]
const stopList = useId()
const percent = ref(0)
const sliderDisabled = computed(() => props.funds.state !== 'ready' || !amountFromBalance(props.funds.available ?? 0, 100))
watch([() => props.selectedAmount, () => props.funds.available], ([amount, available]) => {
  if (amount == null || !Number.isFinite(amount) || amount <= 0 || available == null || available <= 0) {
    percent.value = 0
  } else if (amountFromBalance(available, percent.value) !== amount) {
    percent.value = Math.min(100, Math.round(amount / available * 100))
  }
}, { immediate: true })
function selectPercent(event: Event) {
  if (sliderDisabled.value) return
  percent.value = (event.currentTarget as HTMLInputElement).valueAsNumber
  emit('select', amountFromBalance(props.funds.available ?? 0, percent.value))
}
</script>

<template>
  <div class="opening-budget">
    <slot />
    <div v-if="slider" class="funds-slider" :class="{ unavailable: sliderDisabled }" :style="{ '--share': percent + '%' }">
      <div class="funds-scale" aria-hidden="true">
        <i v-for="stop in stops" :key="stop" :class="{ filled: stop <= percent }" :style="{ left: stop + '%' }"></i>
        <span class="share-value">{{ percent }}%</span>
      </div>
      <input type="range" min="0" max="100" step="1" :list="stopList" :value="percent" :disabled="sliderDisabled"
        aria-label="使用可用余额的比例" :aria-valuetext="percent + '%'" @input="selectPercent" />
      <datalist :id="stopList"><option v-for="stop in stops" :key="stop" :value="stop"></option></datalist>
    </div>
    <div class="funds-summary">
      <span class="funds-value">可用余额
        <strong v-if="funds.available != null">{{ formatNumber(funds.available) }} USDT</strong>
        <span v-else-if="funds.state === 'disconnected'">—</span>
        <span v-else role="status">{{ funds.state === 'loading' ? '读取中…' : '读取失败' }}</span>
      </span>
      <button v-if="funds.state === 'disconnected'" type="button" class="text-button" @click="emit('connect')">连接账户</button>
      <div v-else class="funds-tools">
        <span v-if="funds.state === 'loading' && funds.updatedAt">更新中…</span>
        <time v-else-if="funds.updatedAt" :datetime="new Date(funds.updatedAt).toISOString()"
          :title="formatTradeTime(funds.updatedAt) + ' UTC+8'">{{ formatTradeTime(funds.updatedAt).slice(-8) }} 更新</time>
        <button type="button" class="funds-refresh" :disabled="funds.state === 'loading'" title="刷新可用余额"
          aria-label="刷新可用余额" @click="emit('refresh')"><Refresh /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.opening-budget {
  display: grid;
  gap: 7px;
  min-width: 0;
}
.funds-slider { position: relative; min-width: 0; }
.funds-scale {
  position: absolute; top: 50%; inset-inline: 7px; height: 2px; transform: translateY(-50%); pointer-events: none;
  background: linear-gradient(to right, var(--green) var(--share), #c5d3ca var(--share));
}
.funds-scale i {
  position: absolute; top: 50%; width: 6px; height: 6px; transform: translate(-50%, -50%) rotate(45deg);
  background: white; border: 1px solid #93a99d; border-radius: 1px;
}
.funds-scale i.filled { border-color: var(--green); background: var(--green); }
.funds-slider input[type='range'] {
  display: block; position: relative; appearance: none; width: 100%; height: 28px; margin: 0;
  padding: 0; border: 0; background: transparent; cursor: pointer;
}
.funds-slider input::-webkit-slider-runnable-track { height: 2px; background: transparent; }
.funds-slider input::-moz-range-track { height: 2px; background: transparent; }
.funds-slider input::-webkit-slider-thumb {
  appearance: none; width: 14px; height: 14px; margin-top: -6px; transform: rotate(45deg) scale(.78);
  background: white; border: 2px solid var(--green); border-radius: 1px;
}
.funds-slider input::-moz-range-thumb {
  box-sizing: border-box; width: 14px; height: 14px; transform: rotate(45deg) scale(.78);
  background: white; border: 2px solid var(--green); border-radius: 1px;
}
.funds-slider input:focus-visible { outline: 2px solid var(--green); outline-offset: 1px; border-radius: 4px; }
.funds-slider.unavailable { opacity: .5; }
.funds-slider input:disabled { cursor: default; }
.share-value {
  display: none; position: absolute; z-index: 1; bottom: 9px; left: clamp(13px, var(--share), calc(100% - 13px));
  transform: translateX(-50%); border: 1px solid #b8cfc1; border-radius: 4px; padding: 1px 4px;
  background: white; color: var(--green); font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.funds-slider:not(.unavailable):is(:hover, :focus-within) .share-value { display: block; }
.funds-summary { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 2px 8px; color: var(--muted); font-size: 12px; line-height: 1.4; }
.funds-value { display: inline-flex; flex-wrap: wrap; align-items: baseline; column-gap: 5px; }
.funds-value strong { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.funds-tools { display: flex; align-items: center; gap: 3px; color: var(--muted); font-size: 11px; }
.funds-refresh svg { width: 14px; height: 14px; }
.funds-refresh {
  display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid transparent;
  border-radius: 5px; color: var(--green); background: transparent;
}
.funds-refresh:hover:not(:disabled) { border-color: #bfd5c8; background: white; }
</style>
