<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FuturesSession } from '../futures'
import { useFuturesLeverage } from '../useFuturesLeverage'
import { formatNumber } from '../trades'
import LeverageControl from './LeverageControl.vue'

const props = defineProps<{ session: FuturesSession | null; token: string; disabled: boolean; notional: number | null }>()
const preferred = defineModel<number | null>({ required: true })
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
    <label v-if="disabled && preferred == null" class="field"><span>跟单杠杆</span>
      <input value="沿用交易对当前杠杆" disabled /></label>
    <LeverageControl v-else v-model="preferred" label="跟单杠杆" :disabled="disabled" required
      :slider-max="info?.symbolMaxLeverage"
      description="每次跟单按信号交易对和预计开仓后的档位核对，超限会跳过该笔开仓。可用倍数以币安最终确认为准。" />
    <div v-if="session" class="lookup">
      <label class="field"><span>查询交易对的最高杠杆</span>
        <input v-model="input" spellcheck="false" @keydown.enter.prevent="lookup" /></label>
      <button class="btn" type="button" @click="lookup">查询档位</button>
    </div>
    <p v-if="!session" class="ticket-hint">连接账户后可查询任一 USDT 合约的币安杠杆档位。</p>
    <p v-else-if="loading" class="ticket-hint" role="status">正在读取 {{ symbol }} 的币安杠杆档位…</p>
    <p v-if="info" class="ticket-hint" role="status">
      {{ info.symbol }} 的币安最高杠杆为 <strong>{{ info.symbolMaxLeverage }} 倍</strong>。
      <template v-if="info.maxLeverage">当前持仓档位上限 {{ info.maxLeverage }} 倍。</template>
      <template v-if="projected">预计开仓后仓位价值约 {{ formatNumber(projected.amount) }} USDT，
        {{ projected.maximum ? '该档最高 ' + projected.maximum + ' 倍。' : '超过最高名义价值档位。' }}
        <strong v-if="preferred && (!projected.maximum || preferred > projected.maximum)">此交易对按当前设置会跳过开仓。</strong>
      </template>
    </p>
    <p v-if="invalid || error" class="notice warning" role="status">{{ invalid || error }}
      <button v-if="error" type="button" class="text-button" @click="refresh">重读杠杆档位</button>
    </p>
  </div>
</template>

<style scoped>
.copy-leverage { display: grid; gap: 8px; min-width: 0; }
.lookup { display: flex; align-items: end; gap: 8px; }
.lookup .field { flex: 1; }
.ticket-hint strong { color: var(--ink); }
</style>
