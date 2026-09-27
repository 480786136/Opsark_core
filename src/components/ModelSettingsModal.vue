<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import ModelManagementView from "@/views/ModelManagementView.vue";
import { useOpsStore } from "@/stores/ops";
import type { AiGenerationSettings } from "@/types";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const store = useOpsStore();
const { t, locale } = useI18n();
const limits = ref<AiGenerationSettings>({ ...store.aiGenerationSettings });
const editing = ref(false);
const panel = ref<HTMLElement>();
const error = ref("");
const saved = ref(false);
let returnFocus: HTMLElement | null = null;
watch(() => props.open, async open => {
  if (!open) { returnFocus?.focus(); return; }
  returnFocus = document.activeElement as HTMLElement;
  limits.value = { ...store.aiGenerationSettings };
  editing.value = false; error.value = ""; saved.value = false;
  await nextTick(); panel.value?.focus();
}, { immediate: true });
watch(limits, () => { saved.value = false; }, { deep: true });
function saveLimits() {
  error.value = "";
  const value = limits.value;
  if (!Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens < 256 || value.maxOutputTokens > 1_000_000
    || [value.maxPlanSteps, value.maxTextChars, value.maxCommandChars].some(n => !Number.isInteger(n) || n < 1)) {
    error.value = locale.value.startsWith("zh") ? "请输入有效整数：输出预算为 256–1000000，其余限制大于 0。" : "Use integers: output budget 256–1000000; other limits above zero.";
    return;
  }
  store.aiGenerationSettings = { ...value };
  store.persist(true); saved.value = true; emit("saved");
}
function keyboard(event: KeyboardEvent) {
  if (editing.value || event.defaultPrevented) return;
  if (event.key === "Escape") { event.preventDefault(); emit("close"); }
  if (event.key !== "Tab") return;
  const items = [...(panel.value?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), summary') ?? [])]
    .filter(el => el.getClientRects().length && (!el.closest("details:not([open])") || el.matches("details:not([open]) > summary")));
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop model-settings-backdrop" @keydown="keyboard">
      <section ref="panel" class="modal-card shared-model-settings" role="dialog" aria-modal="true" aria-labelledby="model-settings-title" tabindex="-1" :inert="editing || undefined">
        <header class="modal-title"><h2 id="model-settings-title">{{ t('settings.modalTitle') }}</h2><button class="icon-button" :aria-label="t('common.close')" @click="emit('close')"><X :size="18"/></button></header>
        <ModelManagementView embedded @editing="editing = $event" @saved="emit('saved')"/>
        <form class="budget-settings" @submit.prevent="saveLimits">
          <h3>{{ locale.startsWith('zh') ? '规划输出预算' : 'Planning output budget' }}</h3>
          <label>{{ t('settings.compactOutputTokens') }}<input v-model.number="limits.maxOutputTokens" type="number" min="256" max="1000000" step="1" required/></label>
          <p>{{ locale.startsWith('zh') ? '始终生效，不受下方精简开关影响。模型高级参数可覆盖此值，最终预算仍须符合该模型的接入上限。' : 'Always active, independent of compact limits. Model overrides take precedence and connection limits still apply.' }}</p>
          <label class="compact-toggle"><input v-model="limits.limitOutput" type="checkbox"/>{{ t('settings.enableCompactLimits') }}</label>
          <div v-if="limits.limitOutput" class="budget-grid">
            <label>{{ t('settings.compactMaxSteps') }}<input v-model.number="limits.maxPlanSteps" type="number" min="1" step="1" required/></label>
            <label>{{ t('settings.compactTextChars') }}<input v-model.number="limits.maxTextChars" type="number" min="1" step="1" required/></label>
            <label>{{ t('settings.compactCommandChars') }}<input v-model.number="limits.maxCommandChars" type="number" min="1" step="1" required/></label>
          </div>
          <p v-if="error" role="alert" class="settings-error">{{ error }}</p>
          <p v-if="saved" role="status">{{ locale.startsWith('zh') ? '预算已保存，未调用模型。' : 'Budget saved. No model request was sent.' }}</p>
          <button class="button primary" type="submit">{{ locale.startsWith('zh') ? '保存规划预算' : 'Save planning budget' }}</button>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.model-settings-backdrop{z-index:1100}.shared-model-settings{width:min(1120px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto}.shared-model-settings>.modal-title{margin-bottom:24px}.budget-settings{margin-top:28px;border-top:1px solid var(--border);padding-top:20px}.budget-settings h3{font-size:15px;margin:0 0 16px}.budget-settings label{display:flex;flex-direction:column;gap:8px;color:var(--muted);font-size:12px}.budget-settings input[type=number]{width:100%;max-width:280px;padding:10px 12px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text)}.budget-settings input:focus-visible{outline:2px solid var(--accent)}.budget-settings p{font-size:12px;line-height:1.7;color:var(--muted)}.budget-settings .settings-error{color:var(--red)}.budget-settings .compact-toggle{flex-direction:row;margin:18px 0}.budget-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:20px}@media(max-width:600px){.budget-grid{grid-template-columns:1fr}.shared-model-settings{width:100%;max-height:100dvh}}
</style>

<style scoped>
.budget-settings .compact-toggle{align-items:center}
.budget-settings .compact-toggle input{width:14px;height:14px;margin:0;flex:none;accent-color:var(--accent)}
</style>
