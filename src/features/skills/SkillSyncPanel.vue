<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { AlertTriangle, CheckCircle2, X } from "lucide-vue-next";
import { useSkillAutoSyncStore } from "./skillAutoSync";
const sync = useSkillAutoSyncStore();
const message = ref("");
const messageKind = ref<"error" | "success">("error");
let timer: ReturnType<typeof window.setTimeout> | undefined;
function close() {
  message.value = "";
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
}
function show(text: string, kind: "error" | "success") {
  message.value = text;
  messageKind.value = kind;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(close, 6_000);
}
watch(() => sync.error, (error) => {
  if (error) show(error, "error");
}, { immediate: true });
watch(() => sync.downloadNotice, (notice) => {
  if (notice) show(notice.message, "success");
  else if (messageKind.value === "success") close();
});
onBeforeUnmount(close);
</script>
<template>
  <Teleport to="body">
    <Transition name="skill-message">
      <div v-if="message" class="skill-sync-message" :class="{ success: messageKind === 'success' }" :role="messageKind === 'success' ? 'status' : 'alert'" :aria-live="messageKind === 'success' ? 'polite' : 'assertive'">
        <CheckCircle2 v-if="messageKind === 'success'" :size="17" />
        <AlertTriangle v-else :size="17" />
        <div><strong>{{ messageKind === 'success' ? '下载成功' : '同步失败' }}</strong><span>{{ message }}</span></div>
        <button type="button" aria-label="关闭同步提示" @click="close"><X :size="15" /></button>
      </div>
    </Transition>
  </Teleport>
</template>
<style scoped>
.skill-sync-message{position:fixed;z-index:2400;top:54px;left:50%;display:grid;grid-template-columns:18px minmax(0,1fr) 28px;align-items:start;gap:10px;width:min(460px,calc(100vw - 32px));padding:13px 12px 13px 14px;border:1px solid color-mix(in srgb,var(--red) 42%,var(--border));border-radius:9px;background:color-mix(in srgb,var(--raised) 94%,var(--red) 6%);color:var(--red);box-shadow:var(--shadow-popover);transform:translateX(-50%)}
.skill-sync-message.success{border-color:color-mix(in srgb,var(--green) 42%,var(--border));background:color-mix(in srgb,var(--raised) 94%,var(--green) 6%);color:var(--green)}
.skill-sync-message>div{display:grid;gap:3px;min-width:0}.skill-sync-message strong{color:var(--text);font-size:12px}.skill-sync-message span{color:var(--muted);font-size:11px;line-height:1.5;overflow-wrap:anywhere}.skill-sync-message button{display:grid;place-items:center;width:28px;height:28px;margin-top:-5px;border:0;border-radius:6px;background:transparent;color:var(--muted);cursor:pointer}.skill-sync-message button:hover{background:var(--hover);color:var(--text)}
.skill-message-enter-active,.skill-message-leave-active{transition:opacity .18s ease,transform .18s ease}.skill-message-enter-from,.skill-message-leave-to{opacity:0;transform:translate(-50%,-8px)}
@media(prefers-reduced-motion:reduce){.skill-message-enter-active,.skill-message-leave-active{transition:none}}
</style>
