<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Close } from '@element-plus/icons-vue'

defineProps<{ title: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()

onMounted(() => dialog.value?.showModal())
</script>

<template>
  <dialog ref="dialog" class="workspace-dialog" :aria-label="title" @cancel.prevent="emit('close')">
    <div class="dialog-heading">
      <h2>{{ title }}</h2>
      <button class="icon-button" type="button" aria-label="关闭" @click="emit('close')">
        <Close />
      </button>
    </div>
    <slot />
  </dialog>
</template>
