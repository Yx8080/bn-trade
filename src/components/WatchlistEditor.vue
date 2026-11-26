<script setup lang="ts">
import { ref } from 'vue'
import { Delete, Plus } from '@element-plus/icons-vue'
import { parsePortfolioId } from '../trades'
import type { LeadPortfolio } from '../portfolios'
import WorkspaceDialog from './WorkspaceDialog.vue'

const props = defineProps<{ portfolios: LeadPortfolio[]; adding?: boolean; saving?: boolean; saveError?: string }>()
const emit = defineEmits<{ close: []; save: [entries: LeadPortfolio[]] }>()
let nextId = 0
function makeRow(id = '', name = '') {
  return { key: ++nextId, id, name }
}
const rows = ref(props.portfolios.map((item) => makeRow(item.id, item.name)))
if (props.adding || !rows.value.length) rows.value.push(makeRow())
const error = ref('')

function pasteIds(event: ClipboardEvent, index: number) {
  const text = event.clipboardData?.getData('text').trim()
  if (!text) return
  const values = text.split(/[\s,，]+/).filter(Boolean)
  if (values.length < 2) return
  event.preventDefault()
  const ids = values.map(parsePortfolioId)
  if (ids.some((id) => !id)) {
    error.value = '批量粘贴的内容中有无效的组合 ID 或链接。'
    return
  }
  const names = new Map(rows.value.map((row) => [parsePortfolioId(row.id), row.name]))
  rows.value.splice(index, 1, ...ids.map((id) => makeRow(id, names.get(id))))
  error.value = ''
}

function save() {
  const entries: LeadPortfolio[] = []
  const ids = new Set<string>()
  for (const [index, row] of rows.value.entries()) {
    if (!row.id.trim() && !row.name.trim()) continue
    const id = parsePortfolioId(row.id)
    if (!id || ids.has(id)) {
      error.value = id
        ? `第 ${index + 1} 行的组合已存在。`
        : `请检查第 ${index + 1} 行的组合 ID 或币安带单链接。`
      return
    }
    ids.add(id)
    entries.push({ id, name: row.name.trim() })
  }
  emit('save', entries)
}
</script>

<template>
  <WorkspaceDialog title="管理带单组合" @close="emit('close')">
    <p class="dialog-description">
      可按行批量粘贴组合 ID 或币安带单链接。保存后，服务会在后台持续监控这些组合。
    </p>
    <form :aria-busy="saving" @submit.prevent="save">
      <div class="edit-rows">
        <div v-for="(row, i) in rows" :key="row.key" class="edit-row">
          <label class="field">
            <span>组合 ID 或带单链接</span>
            <input
              v-model="row.id"
              :aria-label="`组合 ${i + 1} 的 ID 或带单链接`"
              :autofocus="adding && i === rows.length - 1"
              placeholder="输入 ID 或粘贴链接"
              @paste="pasteIds($event, i)"
            />
          </label>
          <label class="field">
            <span>备注名称</span>
            <input
              v-model="row.name"
              :aria-label="`组合 ${i + 1} 的名称`"
              maxlength="80"
              placeholder="选填"
            />
          </label>
          <button
            type="button"
            class="icon-button"
            :aria-label="`移除组合 ${i + 1}`"
            @click="rows.splice(i, 1)"
          >
            <Delete />
          </button>
        </div>
      </div>
      <button type="button" class="text-button add-combo" @click="rows.push(makeRow())">
        <Plus />
        添加组合
      </button>
      <p v-if="error || saveError" class="notice error" role="alert">{{ error || saveError }}</p>
      <div class="dialog-actions">
        <button type="button" class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" type="submit" :disabled="saving">{{ saving ? '正在保存…' : '保存组合' }}</button>
      </div>
    </form>
  </WorkspaceDialog>
</template>
