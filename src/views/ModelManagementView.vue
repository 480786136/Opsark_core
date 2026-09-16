<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Box, ChevronRight, Plus, Save, Trash2, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import ModelAdvancedParameters from "@/components/ModelAdvancedParameters.vue";
import { useOpsStore } from "@/stores/ops";
import { localizeCoreText } from "@/features/preferences/coreText";
import { validateRequestParameters } from "@/features/agent/modelParameters";
import type { ModelProfile } from "@/types";

const store = useOpsStore();
const { t, locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const draft = ref<ModelProfile>();
const key = ref("");
const busy = ref(false);
const error = ref("");
const drawer = ref<HTMLElement>();
const DEFAULT_MODEL_TIMEOUT_SECONDS = 90;
let returnFocus: HTMLElement | null = null;
const modelIdentity = (model: ModelProfile) =>
  `${model.provider} · ${model.model || "-"} · ${model.timeoutSeconds ?? DEFAULT_MODEL_TIMEOUT_SECONDS}s`;
const modelStatus = (model: ModelProfile) =>
  !model.enabled
    ? zh.value ? "已停用" : "Disabled"
    : localizeCoreText(store.modelAvailability[model.id]?.reason) || t("settings.unchecked");

async function edit(model?: ModelProfile) {
  returnFocus = document.activeElement as HTMLElement;
  draft.value = model ? JSON.parse(JSON.stringify(model)) : {
    id: `model-${crypto.randomUUID()}`, name: zh.value ? "新模型" : "New model",
    provider: "OpenAI Compatible", model: "", endpoint: "", enabled: true, hasApiKey: false,
    timeoutSeconds: DEFAULT_MODEL_TIMEOUT_SECONDS,
  };
  key.value = model ? store.modelApiKeys[model.id] ?? "" : "";
  error.value = "";
  await nextTick();
  drawer.value?.querySelector<HTMLInputElement>("input")?.focus();
}
function close() {
  if (busy.value) return;
  draft.value = undefined;
  key.value = "";
  returnFocus?.focus();
}
function keyboard(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  if (event.key === "Escape") { event.preventDefault(); close(); }
  if (event.key !== "Tab") return;
  const elements = [...(drawer.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary') ?? [])]
    .filter(element => !element.closest("details:not([open])") || element.tagName === "SUMMARY");
  const first = elements[0], last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
async function save() {
  if (!draft.value || busy.value) return;
  error.value = "";
  try {
    validateRequestParameters(draft.value.requestParameters);
    const timeoutSeconds = Number(draft.value.timeoutSeconds ?? DEFAULT_MODEL_TIMEOUT_SECONDS);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 900) {
      throw new Error(zh.value ? "请求超时必须是 10-900 秒的整数。" : "Request timeout must be an integer from 10 to 900 seconds.");
    }
    if (![draft.value.name, draft.value.model, draft.value.endpoint].every(value => value.trim())) {
      throw new Error(zh.value ? "请填写配置名称、模型名和接口地址。" : "Enter a configuration name, model name and endpoint.");
    }
    busy.value = true;
    const model = JSON.parse(JSON.stringify(draft.value)) as ModelProfile;
    model.timeoutSeconds = timeoutSeconds;
    model.hasApiKey = Boolean(key.value);
    const index = store.models.findIndex(item => item.id === model.id);
    if (index < 0) store.models.push(model); else store.models[index] = model;
    store.modelApiKeys[model.id] = key.value;
    await store.saveModels();
    busy.value = false;
    close();
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { busy.value = false; }
}
async function remove() {
  if (!draft.value || busy.value) return;
  busy.value = true;
  try { await store.removeModel(draft.value.id); busy.value = false; close(); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="page management-page">
    <header class="page-header">
      <div><span class="eyebrow">{{ zh ? "模型配置" : "MODEL CONFIGURATION" }}</span><h1>{{ t('settings.modelTitle') }}</h1><p>{{ t('settings.modelSubtitle') }}</p></div>
      <button class="button primary" @click="edit()"><Plus :size="15"/>{{ t('settings.addModel') }}</button>
    </header>
    <main class="model-grid">
      <button v-for="model in store.models" :key="model.id" class="model-card" @click="edit(model)">
        <span class="card-heading"><span class="model-symbol"><Box :size="20"/></span><strong :title="model.name">{{ model.name }}</strong><ChevronRight class="card-arrow" :size="16"/></span>
        <span class="model-identity" :title="modelIdentity(model)">{{ modelIdentity(model) }}</span>
        <span class="model-endpoint" :title="model.endpoint || '-'">{{ model.endpoint || '-' }}</span>
        <span class="card-footer"><span :class="['status-dot', model.enabled ? store.modelAvailability[model.id]?.status : 'disabled']"></span><span :title="modelStatus(model)">{{ modelStatus(model) }}</span><span class="edit-label">{{ zh ? '编辑' : 'Edit' }}</span></span>
      </button>
      <button v-if="!store.models.length" class="empty-card" @click="edit()"><Plus :size="24"/><span>{{ t('settings.addModel') }}</span></button>
    </main>
    <Teleport to="body">
      <Transition name="model-drawer">
        <div v-if="draft" class="drawer-overlay" @keydown="keyboard">
          <section ref="drawer" class="model-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="model-editor-title" :aria-busy="busy">
            <header class="drawer-header"><span class="drawer-model-icon"><Box :size="18"/></span><div><small>{{ zh ? '模型详情' : 'Model details' }}</small><h2 id="model-editor-title" :title="draft.name">{{ draft.name || (zh ? '模型配置' : 'Model configuration') }}</h2></div><button class="icon-button" :disabled="busy" :aria-label="zh ? '关闭编辑' : 'Close editor'" @click="close"><X :size="20"/></button></header>
            <form class="drawer-form" @submit.prevent="save">
              <fieldset :disabled="busy" class="drawer-body">
                <div class="section-heading"><strong>{{ zh ? '连接配置' : 'Connection' }}</strong><label class="enabled-control"><input v-model="draft.enabled" type="checkbox"/>{{ zh ? '启用模型' : 'Enabled' }}</label></div>
                <div class="connection-fields">
                  <label class="full"><span>{{ t('settings.configName') }}</span><input v-model="draft.name" required/></label>
                  <label><span>{{ t('settings.provider') }}</span><input v-model="draft.provider"/></label>
                  <label><span>{{ t('settings.modelName') }}</span><input v-model="draft.model" required/></label>
                  <label class="full"><span>{{ t('settings.endpoint') }}</span><input v-model="draft.endpoint" required placeholder="https://api.example.com/v1"/></label>
                  <label class="full"><span>API Key</span><input v-model="key" type="password" autocomplete="off" :placeholder="t('settings.apiKeyPlaceholder')"/></label>
                  <label class="full"><span>{{ zh ? '请求超时（秒）' : 'Request timeout (seconds)' }} <span class="field-help" :title="zh ? '每次该模型请求允许的最长时间，包含上游生成响应的时间。速度较慢或输出较长的模型应设置更大值。' : 'Maximum duration of each request for this model, including upstream generation time. Use a larger value for slower or longer responses.'">?</span></span><input v-model.number="draft.timeoutSeconds" type="number" min="10" max="900" step="1" required/><small>{{ zh ? '建议：普通模型 60-120 秒，长输出/慢模型 180-600 秒。' : 'Suggested: 60-120s normally; 180-600s for slow or long-output models.' }}</small></label>
                </div>
                <ModelAdvancedParameters :model="draft"/>
              </fieldset>
              <footer class="drawer-footer"><p v-if="error" role="alert">{{ localizeCoreText(error) }}</p><span v-if="busy" role="status">{{ zh ? '正在保存并检查连接…' : 'Saving and checking connection…' }}</span><div><button v-if="store.models.some(model => model.id === draft?.id)" class="button danger" type="button" :disabled="busy" @click="remove"><Trash2 :size="14"/>{{ t('settings.removeModel') }}</button><span class="footer-spacer"></span><button class="button secondary" type="button" :disabled="busy" @click="close">{{ zh ? '取消' : 'Cancel' }}</button><button class="button primary" :disabled="busy" type="submit"><Save :size="14"/>{{ busy ? t('settings.saving') : t('common.save') }}</button></div></footer>
            </form>
          </section>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.model-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr));gap:16px;width:100%;max-width:1400px;min-width:0;overflow:hidden}.model-card{display:flex;flex-direction:column;gap:12px;width:100%;max-width:100%;min-width:0;overflow:hidden;text-align:left;padding:20px;border:1px solid var(--border);border-radius:12px;background:var(--panel);color:var(--text);cursor:pointer;transition:transform .18s,border-color .18s,background .18s}.model-card:hover{transform:translateY(-2px);border-color:var(--accent);background:var(--panel-2)}.model-card:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.card-heading{display:flex;align-items:center;gap:12px;width:100%;min-width:0}.card-heading strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px}.model-symbol{flex-shrink:0;padding:9px;background:var(--accent-soft);color:var(--accent);border-radius:9px;display:flex}.card-arrow{margin-left:auto;flex-shrink:0;color:var(--muted)}.model-identity,.model-endpoint{display:block;width:100%;max-width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--muted)}.model-endpoint{font-size:11px}.card-footer{display:flex;gap:7px;align-items:center;width:100%;min-width:0;overflow:hidden;border-top:1px solid var(--border-soft);padding-top:12px;font-size:11px;color:var(--muted)}.card-footer>span:nth-child(2){display:block;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status-dot{width:6px;height:6px;border-radius:50%;background:var(--muted);flex-shrink:0}.status-dot.available{background:var(--accent)}.status-dot.unavailable{background:var(--red)}.edit-label{margin-left:auto;color:var(--accent);flex-shrink:0}.empty-card{min-height:170px;border:1px dashed var(--border);border-radius:12px;background:var(--panel);color:var(--muted);display:flex;align-items:center;justify-content:center;gap:12px;cursor:pointer}.drawer-overlay{position:fixed;inset:0;z-index:1200;background:var(--scrim);display:flex;justify-content:flex-end}.model-drawer-panel{width:min(620px,100vw);height:100%;display:flex;flex-direction:column;background:var(--panel);color:var(--text);border-left:1px solid var(--border);box-shadow:var(--shadow-dialog)}.drawer-header{display:flex;align-items:center;justify-content:space-between;padding:26px 28px;border-bottom:1px solid var(--border)}.drawer-header h2{font-size:20px;margin:8px 0 0;overflow-wrap:anywhere}.drawer-form{display:flex;flex-direction:column;flex:1;min-height:0}.drawer-body{border:0;margin:0;padding:24px 28px;overflow-y:auto;min-height:0;flex:1;min-width:0}.section-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px;font-size:13px}.enabled-control{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.connection-fields{display:grid;grid-template-columns:1fr 1fr;gap:18px}.connection-fields label{display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--muted)}.connection-fields .full{grid-column:1/-1}.connection-fields input{width:100%;min-width:0;height:40px;padding:0 12px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text)}input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}.drawer-body :deep(.parameter-grid){grid-template-columns:repeat(2,minmax(0,1fr))}.drawer-footer{border-top:1px solid var(--border);padding:18px 28px;background:var(--panel)}.drawer-footer>div{display:flex;align-items:center;gap:10px}.footer-spacer{flex:1}.drawer-footer p{color:var(--red);font-size:12px;overflow-wrap:anywhere}.drawer-footer>span{display:block;font-size:12px;color:var(--muted);margin-bottom:10px}.model-drawer-enter-active,.model-drawer-leave-active{transition:opacity .2s}.model-drawer-enter-active .model-drawer-panel,.model-drawer-leave-active .model-drawer-panel{transition:transform .24s ease}.model-drawer-enter-from,.model-drawer-leave-to{opacity:0}.model-drawer-enter-from .model-drawer-panel,.model-drawer-leave-to .model-drawer-panel{transform:translateX(100%)}@media(prefers-reduced-motion:reduce){.model-card,.model-drawer-enter-active,.model-drawer-leave-active,.model-drawer-panel{transition:none!important}}@media(max-width:480px){.model-grid{grid-template-columns:1fr}.drawer-header,.drawer-body,.drawer-footer{padding:18px}.connection-fields{grid-template-columns:1fr}}
.connection-fields small{font-size:11px;line-height:1.5}.field-help{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-left:4px;border:1px solid var(--border);border-radius:50%;font-size:10px;color:var(--muted);cursor:help}
.drawer-header{position:relative;z-index:2;display:grid;grid-template-columns:38px minmax(0,1fr) 34px;align-items:center;gap:12px;min-height:76px;padding:14px 22px;background:var(--panel)}.drawer-header>div{min-width:0}.drawer-header small{display:block;margin-bottom:4px;color:var(--muted);font-size:10px}.drawer-header h2{max-width:100%;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:18px;line-height:1.3}.drawer-header .icon-button{margin:0}.drawer-model-icon{display:grid;width:38px;height:38px;place-items:center;border-radius:8px;background:var(--accent-soft);color:var(--accent)}
</style>
