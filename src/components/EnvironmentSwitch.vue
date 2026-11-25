<script setup lang="ts">
import { SetUp, TrendCharts } from '@element-plus/icons-vue'
import type { Environment } from '../futures'

defineProps<{ modelValue: Environment }>()
const emit = defineEmits<{ change: [value: Environment] }>()
const options = [
  { id: 'testnet', name: '测试网', icon: SetUp },
  { id: 'live', name: '实盘', icon: TrendCharts },
] as const
</script>

<template>
  <fieldset class="environment-switch" aria-label="交易环境">
    <label v-for="option in options" :key="option.id" :class="option.id">
      <input type="radio" name="trading-environment" :value="option.id"
        :checked="modelValue === option.id" @change="emit('change', option.id)" />
      <span class="choice"><component :is="option.icon" aria-hidden="true" />{{ option.name }}</span>
    </label>
  </fieldset>
</template>

<style scoped>
.environment-switch {
  display: inline-flex;
  align-items: stretch;
  gap: 2px;
  flex-shrink: 0;
  padding: 3px;
  margin: 0;
  border: 1px solid #d8e1dc;
  border-radius: 9px;
  background: #f2f5f3;
}
label { position: relative; display: flex; }
input { position: absolute; z-index: 1; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.choice {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 6px;
  min-width: 65px;
  height: 29px;
  padding-inline: 10px;
  color: #5b6c63;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  border-radius: 6px;
}
.choice svg { width: 15px; height: 15px; }
input:hover + .choice { color: #263f33; background: #e7ede9; }
input:checked + .choice {
  color: #16543d;
  background: #e3f1e8;
  box-shadow: inset 0 0 0 1px #b8d3c3;
}
.live input:checked + .choice {
  color: #855110;
  background: #fff0d7;
  box-shadow: inset 0 0 0 1px #e6c68f;
}
input:focus-visible + .choice { outline: 2px solid #336e58; outline-offset: 1px; }
@media (max-width: 570px) {
  .choice { height: 32px; min-width: 54px; padding-inline: 8px; gap: 5px; }
  .choice svg { width: 14px; height: 14px; }
}
@media (forced-colors: active) { input:checked + .choice { outline: 2px solid Highlight; } }
</style>
