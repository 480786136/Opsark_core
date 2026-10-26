<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = withDefaults(defineProps<{
  message: string;
  title?: string;
  confirmLabel?: string;
  requestId?: number;
}>(), { title: "请确认", confirmLabel: "确认操作", requestId: 0 });
const emit = defineEmits<{ result: [confirmed: boolean, requestId: number] }>();
const dialog = ref<HTMLDialogElement>();
const cancel = ref<HTMLButtonElement>(), confirm = ref<HTMLButtonElement>();
const settled = ref(true);
let previous: HTMLElement | null = null;

function restoreFocus() {
  const target = previous;
  previous = null;
  // An editor may have closed while its confirmation was pending.
  if (target?.isConnected && !target.closest("dialog:not([open])")) target.focus();
}

watch(() => [props.message, props.requestId] as const, async ([message, requestId]) => {
  if (!message) {
    settled.value = true;
    dialog.value?.close();
    restoreFocus();
    return;
  }
  if (!previous) previous = document.activeElement as HTMLElement | null;
  settled.value = false;
  await nextTick();
  if (props.message !== message || props.requestId !== requestId || settled.value) return;
  // showModal joins the browser top layer above an existing native editor.
  // A high-z-index Teleport div cannot do that.
  if (dialog.value && !dialog.value.open) dialog.value.showModal();
  cancel.value?.focus();
}, { immediate: true, flush: "post" });

function respond(confirmed: boolean) {
  if (settled.value || !props.message) return;
  settled.value = true;
  dialog.value?.close();
  emit("result", confirmed, props.requestId);
}

function closed(event: Event) {
  // Ignore a queued close from an older dialog after a new request opened.
  if (event.target === dialog.value && !dialog.value?.open) respond(false);
}

function tab(event: KeyboardEvent) {
  event.preventDefault();
  (document.activeElement === cancel.value ? confirm.value : cancel.value)?.focus();
}

onBeforeUnmount(() => {
  dialog.value?.close();
  restoreFocus();
});
</script>

<template>
  <Teleport to="body">
    <dialog v-if="message" ref="dialog" role="alertdialog" aria-modal="true" :aria-label="title"
      class="action-confirmation" @cancel.prevent="respond(false)" @close="closed" @keydown.tab="tab">
      <h2>{{ title }}</h2>
      <p>{{ message }}</p>
      <div>
        <button ref="cancel" type="button" class="button secondary" :disabled="settled" @click="respond(false)">取消</button>
        <button ref="confirm" type="button" class="button primary" :disabled="settled" @click="respond(true)">{{ confirmLabel }}</button>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.action-confirmation{width:min(480px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:auto;margin:auto;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:24px;box-shadow:var(--shadow-dialog)}
.action-confirmation::backdrop{background:#0006}
.action-confirmation h2{font-size:17px}
.action-confirmation p{font-size:14px;line-height:1.8;white-space:pre-wrap}
.action-confirmation>div{display:flex;justify-content:flex-end;gap:12px;margin-top:20px}
</style>
