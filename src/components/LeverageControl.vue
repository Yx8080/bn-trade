<script setup lang="ts">
import { computed, useId } from 'vue'
import { MIN_LEVERAGE } from '../../shared/leverage.js'

const props = withDefaults(defineProps<{
  label: string
  max?: number
  sliderMax?: number
  fallback?: number
  placeholder?: string
  disabled?: boolean
  required?: boolean
  description?: string
}>(), { fallback: MIN_LEVERAGE })
const value = defineModel<number | null>({ required: true })
const field = useId()
// Before a symbol limit is available, the slider is a convenient input
// range. The adjacent number field can still specify a larger preference.
const limit = computed(() => props.max ?? props.sliderMax ?? Math.max(150, value.value ?? 1))
const rangeValue = computed(() => Math.max(MIN_LEVERAGE, Math.min(limit.value, value.value ?? props.fallback)))

function change(event: Event) {
  const input = event.target as HTMLInputElement
  value.value = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null
}
</script>

<template>
  <div class="field leverage-field" role="group" :aria-labelledby="field + '-title'">
    <label :id="field + '-title'" :for="field">{{ label }}</label>
    <div class="leverage-controls">
      <div class="slider">
        <input type="range" :min="MIN_LEVERAGE" :max="limit" step="1" :value="rangeValue"
          :disabled="disabled" :aria-label="label + '滑块'" :aria-valuetext="rangeValue + ' 倍'"
          :aria-describedby="description ? field + '-help' : undefined" @input="change" />
        <div class="bounds" aria-hidden="true"><span>{{ MIN_LEVERAGE }}×</span><span v-if="!max && !sliderMax">快捷范围</span><span>{{ limit }}×</span></div>
      </div>
      <div class="leverage-number">
        <input :id="field" type="number" inputmode="numeric" :min="MIN_LEVERAGE" :max="max" step="1"
          :required="required" :value="value ?? ''" :placeholder="placeholder" :disabled="disabled"
          :aria-describedby="description ? field + '-help' : undefined" @input="change" />
        <span aria-hidden="true">倍</span>
      </div>
    </div>
    <small v-if="description" :id="field + '-help'">{{ description }}</small>
  </div>
</template>

<style scoped>
.leverage-controls { display: grid; grid-template-columns: minmax(70px, 1fr) minmax(65px, 90px); gap: 12px; align-items: start; }
.slider input[type='range'] { display: block; width: 100%; height: 23px; padding: 0; margin: 0; accent-color: var(--green); cursor: pointer; border: 0; background: transparent; }
.slider input:disabled { cursor: default; }
.bounds { display: flex; justify-content: space-between; font-size: 11px; font-weight: 450; color: var(--muted); }
.leverage-number { position: relative; }
.leverage-number input { padding-right: 24px; appearance: textfield; }
.leverage-number input::-webkit-inner-spin-button { -webkit-appearance: none; }
.leverage-number span { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
.leverage-field small { font-size: 12px; line-height: 1.5; color: var(--muted); font-weight: 450; }
</style>
