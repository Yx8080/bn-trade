<script setup lang="ts">
import { Refresh, Wallet } from '@element-plus/icons-vue'
import { amountFromBalance, type OpeningFunds } from '../opening-funds'
import { formatNumber, formatTradeTime } from '../trades'

defineProps<{ funds: OpeningFunds; shortcuts?: boolean }>()
const emit = defineEmits<{ select: [amount: number]; refresh: []; connect: [] }>()
</script>

<template>
  <div class="opening-budget">
    <div class="funds-heading">
      <span class="funds-label"><Wallet aria-hidden="true" />合约可用余额</span>
      <button v-if="funds.state === 'disconnected'" type="button" class="text-button" @click="emit('connect')">连接账户</button>
      <div v-else class="funds-tools">
        <span v-if="funds.state === 'loading' && funds.updatedAt">更新中…</span>
        <time v-else-if="funds.updatedAt" :datetime="new Date(funds.updatedAt).toISOString()"
          :title="formatTradeTime(funds.updatedAt) + ' UTC+8'">{{ formatTradeTime(funds.updatedAt).slice(-8) }} 更新</time>
        <button type="button" class="funds-refresh" :disabled="funds.state === 'loading'" title="刷新可用余额"
          aria-label="刷新可用余额" @click="emit('refresh')"><Refresh /></button>
      </div>
    </div>
    <div v-if="funds.available != null" class="funds-value">
      <strong>{{ formatNumber(funds.available) }}</strong> <span>USDT</span>
    </div>
    <p v-else class="funds-state" role="status">{{ funds.state === 'loading' ? '正在读取余额…'
      : funds.state === 'disconnected' ? '连接后可查看 USDT 余额' : '未能读取 USDT 可用余额，请刷新' }}</p>
    <slot />
    <div v-if="shortcuts" class="funds-presets" role="group" aria-label="使用可用余额的比例">
      <button v-for="pct in [10, 25, 50, 100]" :key="pct" type="button"
        :aria-label="'使用可用余额的 ' + pct + '%'"
        :disabled="funds.state !== 'ready' || !amountFromBalance(funds.available ?? 0, pct)"
        @click="emit('select', amountFromBalance(funds.available ?? 0, pct))">{{ pct }}%</button>
    </div>
  </div>
</template>

<style scoped>
.opening-budget {
  display: grid;
  gap: 7px;
  min-width: 0;
  padding: 12px 14px 14px;
  border: 1px solid #cbded3;
  border-radius: 9px;
  background: #f3f8f4;
}
.funds-heading, .funds-label { display: flex; align-items: center; gap: 6px; }
.funds-heading { justify-content: space-between; min-height: 24px; }
.funds-tools { display: flex; align-items: center; gap: 3px; color: var(--muted); font-size: 11px; }
.funds-label { color: #365e4f; font-size: 12px; font-weight: 650; }
.funds-label svg, .funds-refresh svg { width: 15px; height: 15px; }
.funds-refresh {
  display: grid; place-items: center; width: 28px; height: 26px; border: 1px solid transparent;
  border-radius: 5px; color: var(--green); background: transparent;
}
.funds-refresh:hover:not(:disabled) { border-color: #bfd5c8; background: white; }
.funds-value { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; margin: -3px 0 3px; color: var(--ink); }
.funds-value strong { font-size: 24px; font-weight: 680; line-height: 1.2; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.funds-value span, .funds-state { font-size: 12px; color: #476554; }
.funds-state { margin-bottom: 4px; }
.funds-presets { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.funds-presets button {
  min-height: 28px; border: 1px solid #c9d9ce; border-radius: 5px; background: white;
  color: #245d46; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.funds-presets button:hover:not(:disabled), .funds-presets button:focus-visible { border-color: var(--green); background: #e7f3e8; }
</style>
