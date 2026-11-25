<script setup lang="ts">
import { computed } from 'vue'
import type { PositionSource } from '../futures'
import type { LeadPortfolio } from '../portfolios'

const props = defineProps<{ sources: PositionSource[]; complete: boolean; entries: LeadPortfolio[] }>()
const known = computed(() => props.sources.filter(source => source.kind !== 'unknown'))
const partial = computed(() => !props.complete || props.sources.some(source => source.kind === 'unknown'))
const mixed = computed(() => known.value.length > 1)
function nameOf(source: PositionSource) {
  if (source.kind === 'manual') return '平台手动'
  if (source.kind === 'external') return '币安其他来源'
  if (source.kind === 'copy') {
    const portfolio = props.entries.find(entry => entry.id === source.portfolioId)
    return portfolio?.name || source.portfolioId || '带单组合待核实'
  }
  return '来源待核实'
}
const primary = computed(() => {
  if (mixed.value) return '混合来源'
  const [source] = known.value
  if (partial.value || !source) return '来源待核实'
  return source.kind === 'copy' ? '平台跟单' : nameOf(source)
})
const detail = computed(() => {
  if (mixed.value || partial.value) {
    const names = known.value.map(source => source.kind === 'copy' ? '跟单 · ' + nameOf(source) : nameOf(source))
    if (mixed.value && partial.value) names.push('部分待核实')
    return !mixed.value && partial.value && names.length ? '已核实 ' + names[0] : names.join('、')
  }
  const [source] = known.value
  return source?.kind === 'external' ? '下单渠道未知' : source?.kind === 'copy' ? nameOf(source) : ''
})
const note = computed(() => known.value.map(source => {
  if (source.kind === 'external') return '币安成交未匹配到本平台订单，具体下单渠道未知。'
  return source.portfolioId ? '带单组合 ID ' + source.portfolioId : ''
}).filter(Boolean).join(' '))
</script>

<template>
  <span class="trade-source" :title="note || undefined">
    <span class="origin-label" :class="{ copy: primary === '平台跟单', mixed, pending: primary === '来源待核实' }">{{ primary }}</span>
    <small v-if="detail">{{ detail }}</small>
  </span>
</template>

<style scoped>
.trade-source { display: inline-grid; justify-items: start; gap: 3px; max-width: 24ch; white-space: normal; }
.origin-label { white-space: nowrap; padding: 2px 6px; border-radius: 4px; color: #344e48; background: #edf1ef; font-size: 12px; line-height: 1.45; }
.origin-label.copy { color: #185b42; background: #e5f3ea; }
.origin-label.mixed { color: #48547a; background: #eff0f7; }
.origin-label.pending { color: #765b26; background: #fbf2da; }
.trade-source small { color: var(--muted); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
</style>
