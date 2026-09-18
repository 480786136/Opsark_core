<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
const props = withDefaults(defineProps<{ message: string; title?: string; confirmLabel?: string }>(), { title: "请确认", confirmLabel: "确认操作" });
const emit = defineEmits<{ result: [confirmed: boolean] }>();
const cancel = ref<HTMLButtonElement>(), confirm = ref<HTMLButtonElement>();
let previous: HTMLElement | null = null;
watch(() => props.message, async message => {
  if (message) { previous = document.activeElement as HTMLElement | null; await nextTick(); cancel.value?.focus(); }
  else previous?.focus();
});
function tab(event: KeyboardEvent) {
  event.preventDefault();
  (document.activeElement === cancel.value ? confirm.value : cancel.value)?.focus();
}
</script>
<template>
  <Teleport to="body"><div v-if="message" class="action-confirmation-overlay"><section role="alertdialog" aria-modal="true" :aria-label="title" class="action-confirmation" @keydown.esc.prevent="emit('result', false)" @keydown.tab="tab">
    <h2>{{ title }}</h2><p>{{ message }}</p><div><button ref="cancel" class="button secondary" @click="emit('result', false)">取消</button><button ref="confirm" class="button primary" @click="emit('result', true)">{{ confirmLabel }}</button></div>
  </section></div></Teleport>
</template>
<style scoped>.action-confirmation-overlay{position:fixed;inset:36px 0 0;z-index:2000;display:grid;place-items:center;background:#0006;padding:24px}.action-confirmation{max-width:480px;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:24px;box-shadow:var(--shadow-dialog)}.action-confirmation h2{font-size:17px}.action-confirmation p{font-size:14px;line-height:1.8;white-space:pre-wrap}.action-confirmation>div{display:flex;justify-content:flex-end;gap:12px;margin-top:20px}</style>
