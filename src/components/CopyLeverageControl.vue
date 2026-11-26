<script setup lang="ts">
import { computed, ref } from 'vue'
import { COPY_LEVERAGE_TIERS, type CopyLeverageOverrides, type CopyLeverageTier } from '../../shared/leverage.js'
import type { CopyConfig, FuturesSession } from '../futures'
import { useFuturesLeverage } from '../useFuturesLeverage'
import { formatNumber } from '../trades'

const props = defineProps<{ session: FuturesSession | null; token: string; disabled: boolean; notional: number | null }>()
const preferred = defineModel<CopyConfig['leverage']>({ required: true })
const overrides = computed(() => preferred.value && typeof preferred.value === 'object' ? preferred.value : null)
let previousOverrides: CopyLeverageOverrides = {}
const leverageMode = computed<'max' | 'custom' | 'legacy'>({
  get: () => overrides.value ? 'custom' : preferred.value === 'max' ? 'max' : 'legacy',
  set: mode => {
    if (mode === 'max') {
      if (overrides.value) previousOverrides = { ...overrides.value }
      preferred.value = 'max'
    } else if (mode === 'custom') {
      preferred.value = previousOverrides
    }
  },
})
function changeOverride(tier: CopyLeverageTier, event: Event) {
  const input = event.target as HTMLInputElement
  const next = { ...overrides.value }
  if (input.value === '') delete next[tier]
  else next[tier] = input.valueAsNumber
  preferred.value = next
}
const symbol = ref('BTCUSDT')
const input = ref(symbol.value)
const invalid = ref('')
const { info, loading, error, refresh } = useFuturesLeverage(() => symbol.value, () => props.session, () => props.token)
const projected = computed(() => {
  if (info.value?.exposure == null || props.notional == null || !Number.isFinite(props.notional) || props.notional <= 0) return null
  const amount = Number(info.value.exposure) + props.notional
  return { amount, maximum: info.value.brackets.find(t => amount <= Number(t.cap))?.leverage }
})
function lookup() {
  const next = input.value.trim().toUpperCase()
  if (!/^[\p{Lu}\p{Lo}\p{Nd}]{1,28}USDT$/u.test(next)) {
    invalid.value = '请输入 USDT 合约交易对，例如 ETHUSDT。'
    return
  }
  invalid.value = ''
  input.value = next
  if (next === symbol.value) refresh()
  else symbol.value = next
}
</script>

<template>
  <div class="copy-leverage">
    <label class="field copy-setting">
      <span>杠杆</span>
      <select v-model="leverageMode" :disabled="disabled">
        <option v-if="leverageMode === 'legacy'" value="legacy" disabled>
          {{ typeof preferred === 'number' ? '原设置 · ' + preferred + '×' : '沿用交易对当前杠杆' }}
        </option>
        <option value="max">默认最高档</option>
        <option value="custom">自定义档位</option>
      </select>
    </label>
    <fieldset v-if="overrides" class="leverage-tiers" :disabled="disabled">
      <legend>跟单杠杆 · 自定义档位</legend>
      <p class="ticket-hint">按交易对最高杠杆匹配。留空或未列出的档位使用最高可用杠杆。</p>
      <div class="leverage-tier-grid">
        <label v-for="tier in COPY_LEVERAGE_TIERS" :key="tier" class="field">
          <span>交易对最高 {{ tier }}×</span>
          <input type="number" inputmode="numeric" min="1" :max="tier" step="1"
            :value="overrides[tier] ?? ''" placeholder="默认最高" @input="changeOverride(tier, $event)" />
        </label>
      </div>
    </fieldset>
    <div v-if="session" class="lookup">
      <label class="field"><span>查询交易对的最高杠杆</span>
        <input v-model="input" spellcheck="false" @keydown.enter.prevent="lookup" /></label>
      <button class="btn" type="button" @click="lookup">查询档位</button>
    </div>
    <p v-if="session && loading" class="ticket-hint" role="status">正在读取 {{ symbol }} 的币安杠杆档位…</p>
    <p v-if="info" class="ticket-hint" role="status">
      {{ info.symbol }} 的币安最高杠杆为 <strong>{{ info.symbolMaxLeverage }} 倍</strong>。
      <template v-if="info.maxLeverage">当前持仓档位上限 {{ info.maxLeverage }} 倍。</template>
      <template v-if="projected">预计开仓后仓位价值约 {{ formatNumber(projected.amount) }} USDT，
        {{ projected.maximum ? '该档最高 ' + projected.maximum + ' 倍。' : '超过最高名义价值档位。' }}
        <template v-if="typeof preferred === 'number' && (!projected.maximum || preferred > projected.maximum)">开仓时会按可用档位重新核算。</template>
      </template>
    </p>
    <p v-if="invalid || error" class="notice warning" role="status">{{ invalid || error }}
      <button v-if="error" type="button" class="text-button" @click="refresh">重读杠杆档位</button>
    </p>
  </div>
</template>

<style scoped>
.copy-leverage { display: grid; gap: 8px; min-width: 0; }
.leverage-tiers { display: grid; gap: 8px; min-width: 0; padding: 0; margin: 0; border: 0; }
.leverage-tiers legend { padding: 0; margin-bottom: 5px; font-size: 13px; font-weight: 650; }
.leverage-tier-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.lookup { display: flex; align-items: end; gap: 8px; }
.lookup .field { flex: 1; }
.ticket-hint strong { color: var(--ink); }
@media (max-width: 480px) { .leverage-tier-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
