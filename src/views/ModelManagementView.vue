<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { saveOfficialPreferences } from "@/features/account/officialModelSettings";
import { useAccountStore } from "@/features/account/accountStore";
import { useOfficialCatalogStore } from "@/features/account/officialCatalogStore";
import { Box, ChevronRight, LockKeyhole, Plus, Save, Trash2, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import ModelAdvancedParameters from "@/components/ModelAdvancedParameters.vue";
import ParameterSelect from "@/components/ParameterSelect.vue";
import { backend, modelServiceError, modelServiceErrorMessage } from "@/services/backend";
import { useOpsStore } from "@/stores/ops";
import { localizeCoreText } from "@/features/preferences/coreText";
import { directCapabilities, effectiveModelOutput, migratedModelIntegration, modelConfigurationFingerprint, newModelCapabilities, validateModelConfiguration } from "@/features/agent/modelCapabilities";
import { hasMatchingPresetIdentity, modelPresetConfiguration, modelPresets } from "@/features/agent/modelPresets";
import type { ModelApiProtocol, ModelProfile, ModelRequestPreview, ModelValidationResult } from "@/types";

defineProps<{ embedded?: boolean }>();
const emit = defineEmits<{ saved: []; editing: [value: boolean] }>();

const store = useOpsStore();
const account = useAccountStore();
const catalog = useOfficialCatalogStore();
const localModels = computed(() => store.models.filter(model => model.source !== "official"));
const officialModels = computed(() => {
  const profiles = account.current ? store.models.filter(model => model.source === "official") : [];
  const listings = catalog.loaded ? catalog.models : profiles.map(model => ({ id: model.model, name: model.name }));
  return listings.map(item => ({ ...item, profile: profiles.find(model => model.model === item.id) }));
});
const { t, locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const draft = ref<ModelProfile>();
const key = ref("");
const busy = ref(false);
const error = ref("");
const testResult = ref("");
const testing = ref(false);
const previewing = ref(false);
const preview = ref<ModelRequestPreview>();
const previewFingerprint = ref("");
const previewMode = ref<"parameters" | "structured" | "business">("structured");
const testFingerprint = ref("");
const tested = ref<ModelValidationResult>();
const validationMode = ref<"parameters" | "structured" | "business">("structured");
const fingerprint = computed(() => draft.value ? modelConfigurationFingerprint(draft.value,
  draft.value.source === "official" ? store.modelApiKeys[draft.value.id] : key.value) : "");
const previewStale = computed(() => Boolean(preview.value && (previewFingerprint.value !== fingerprint.value || previewMode.value !== validationMode.value)));
const testStale = computed(() => Boolean(tested.value && testFingerprint.value !== fingerprint.value));
const outputMode = computed(() => draft.value ? effectiveModelOutput(draft.value) : "unknown");
const budget = computed(() => draft.value?.requestParameters?.outputBudget ?? draft.value?.requestParameters?.max_tokens
  ?? draft.value?.requestParameters?.max_completion_tokens ?? store.aiGenerationSettings.maxOutputTokens);
const capability = computed(() => draft.value?.capabilitiesV2 ?? draft.value?.capabilities);
const protocolOptions = computed(() => [
  { value: "chat_completions", label: "Chat Completions API", disabled: draft.value?.source === "official" && !draft.value.capabilitiesV2?.supportedProtocols.includes("chat_completions") && !!draft.value.capabilitiesV2 },
  { value: "responses", label: "Responses API", disabled: draft.value?.source === "official" && !draft.value.capabilitiesV2?.supportedProtocols.includes("responses") },
]);
const outputPolicyOptions = computed(() => [
  { value: "auto", label: zh.value ? "自动选择已确认的能力" : "Auto: confirmed capabilities" },
  { value: "require_schema", label: zh.value ? "必须使用 JSON Schema" : "Require JSON Schema" },
  { value: "json_only", label: zh.value ? "仅 JSON（兼容诊断）" : "JSON only (compatibility)" },
]);
const drawer = ref<HTMLElement>();
const selectedPreset = ref("");
const presetOptions = computed(() => [{ value: "", label: zh.value ? "自定义接入" : "Custom endpoint" },
  ...modelPresets.map(preset => ({ value: preset.id, label: preset.label }))]);
const strictFlagOptions = computed(() => [
  { value: "", label: zh.value ? "未知（不发送 strict）" : "Unknown (omit strict)" },
  { value: "required", label: zh.value ? "按文档发送 strict: true" : "Send strict: true as documented" },
  { value: "optional", label: zh.value ? "支持可选 strict（不发送）" : "Optional strict (omit)" },
  { value: "unsupported", label: zh.value ? "不支持 strict（不发送）" : "Unsupported strict (omit)" },
]);
const DEFAULT_MODEL_TIMEOUT_SECONDS = 90;
function selectPreset(value: string) {
  if (!draft.value || draft.value.source === "official") return;
  selectedPreset.value = value;
  if (!value) {
    draft.value.capabilitiesV2 = newModelCapabilities(draft.value.apiProtocol);
    return;
  }
  Object.assign(draft.value, modelPresetConfiguration(value));
  draft.value.capabilities = undefined;
}
watch(() => draft.value ? [draft.value.endpoint, draft.value.model, draft.value.apiProtocol] : [], () => {
  if (!draft.value || draft.value.source === "official" || hasMatchingPresetIdentity(draft.value)) return;
  const previous = draft.value.capabilitiesV2!;
  draft.value.capabilitiesV2 = { ...newModelCapabilities(draft.value.apiProtocol),
    defaultOutputTokens: previous.defaultOutputTokens, maxOutputTokens: previous.maxOutputTokens };
  selectedPreset.value = "";
});
function changeAdapter(value: string) {
  if (!draft.value || draft.value.source === "official") return;
  const adapter = value as "portable" | "deepseek" | "qwen" | "openai";
  const previous = draft.value.capabilitiesV2 ?? draft.value.capabilities;
  draft.value.capabilities = { ...directCapabilities(adapter), structuredOutput: "unknown" };
  draft.value.capabilitiesV2 = { ...newModelCapabilities(draft.value.apiProtocol), parameterAdapter: adapter,
    ...(previous ? { defaultOutputTokens: previous.defaultOutputTokens, maxOutputTokens: previous.maxOutputTokens } : {}) };
}
const adapterOptions = computed(() => [
  { value: "portable", label: zh.value ? "自定义 / 通用兼容" : "Custom / portable" },
  { value: "deepseek", label: "DeepSeek" }, { value: "qwen", label: zh.value ? "千问（非思考模式）" : "Qwen (non-thinking)" },
  { value: "openai", label: zh.value ? "OpenAI 兼容接入" : "OpenAI-compatible endpoint" },
]);
const formatOptions = computed(() => [
  { value: "json_object", label: zh.value ? "JSON 输出 + 本地校验" : "JSON output + local validation" },
  { value: "json_schema", label: zh.value ? "JSON 与 JSON Schema（用户声明）" : "JSON and JSON Schema (user declared)" },
  { value: "unknown", label: zh.value ? "尚未确认（调用前需确认）" : "Unconfirmed (confirm before use)" },
]);
watch(() => Boolean(draft.value), value => { emit("editing", value); });
function changeProtocol(value: string) {
  if (!draft.value) return;
  const protocol = value as ModelApiProtocol;
  draft.value.apiProtocol = protocol;
  if (draft.value.source === "official") return;
  const previous = draft.value.capabilitiesV2 ?? migratedModelIntegration(draft.value).capabilitiesV2!;
  draft.value.capabilitiesV2 = { ...newModelCapabilities(protocol),
    parameterAdapter: previous.parameterAdapter,
    defaultOutputTokens: previous.defaultOutputTokens, maxOutputTokens: previous.maxOutputTokens };
  selectedPreset.value = "";
}
function changeCapability(value: string) {
  if (!draft.value || draft.value.source === "official") return;
  if (!draft.value.capabilitiesV2) Object.assign(draft.value, migratedModelIntegration(draft.value));
  const caps = draft.value.capabilitiesV2!;
  caps.outputModes = { json_object: value === "unknown" ? "unknown" : "supported", json_schema: value === "json_schema" ? "supported" : "unknown" };
  caps.evidence = { source: "user_declared" };
  caps.revision = `user:${Date.now()}`;
}
function declareStrictFlag(value: string) {
  if (!draft.value || draft.value.source === "official") return;
  if (!draft.value.capabilitiesV2) Object.assign(draft.value, migratedModelIntegration(draft.value));
  const caps = draft.value.capabilitiesV2!;
  if (value === "required" || value === "optional" || value === "unsupported") caps.strictFlag = value;
  else delete caps.strictFlag;
  caps.evidence = { source: "user_declared" }; caps.revision = `user:${Date.now()}`;
}
function declareParameter(key: "temperature" | "topP" | "presencePenalty" | "reasoningEfforts" | "thinkingEnabled" | "frequencyPenalty", value: string | boolean) {
  if (!draft.value || draft.value.source === "official") return;
  if (!draft.value.capabilitiesV2) Object.assign(draft.value, migratedModelIntegration(draft.value));
  const caps = draft.value.capabilitiesV2!;
  caps.parameterRules ??= { reasoningEfforts: [], thinkingEnabled: false, frequencyPenalty: false };
  if (key === "reasoningEfforts") caps.parameterRules.reasoningEfforts = [...new Set(String(value).split(",").map(item => item.trim()).filter(Boolean))];
  else if (key === "thinkingEnabled" || key === "frequencyPenalty") caps.parameterRules[key] = Boolean(value);
  else caps.parameterRules[key] = value ? "supported" : "unknown";
  caps.evidence = { source: "user_declared" }; caps.revision = `user:${Date.now()}`;
}
function updateBudget(value: string | number) {
  if (!draft.value) return;
  const params = { ...draft.value.requestParameters };
  delete params.max_tokens; delete params.max_completion_tokens; delete params.outputBudget;
  if (value !== "") params.outputBudget = Number(value);
  draft.value.requestParameters = params;
}
onMounted(() => { void catalog.refresh(); });
watch(() => account.current?.user.id, id => {
  if (draft.value?.source === "official") close();
  if (id) void account.refresh();
}, { immediate: true });
let returnFocus: HTMLElement | null = null;
const modelIdentity = (model: ModelProfile) =>
  `${model.provider} · ${model.model || "-"} · ${model.timeoutSeconds ?? DEFAULT_MODEL_TIMEOUT_SECONDS}s`;
const modelStatus = (model: ModelProfile) =>
  !model.enabled
    ? zh.value ? "已停用" : "Disabled"
    : localizeCoreText(store.modelAvailability[model.id]?.reason) || t("settings.unchecked");

async function edit(model?: ModelProfile) {
  if (model?.source === "official" && !account.current) return;
  returnFocus = document.activeElement as HTMLElement;
  draft.value = model ? JSON.parse(JSON.stringify(model)) : {
    id: `model-${crypto.randomUUID()}`, name: "",
    provider: "OpenAI Compatible", model: "", endpoint: "", enabled: true, hasApiKey: false,
    timeoutSeconds: DEFAULT_MODEL_TIMEOUT_SECONDS,
    apiProtocol: "chat_completions", outputPolicy: "auto", capabilitiesV2: newModelCapabilities(),
  };
  key.value = model ? store.modelApiKeys[model.id] ?? "" : "";
  if (!model && draft.value) draft.value.capabilities = { ...directCapabilities("portable"), structuredOutput: "unknown" };
  selectedPreset.value = modelPresets.find(preset => draft.value?.capabilitiesV2?.revision === `preset:${preset.id}:1`)?.id ?? "";
  validationMode.value = "structured";
  preview.value = undefined; previewFingerprint.value = ""; testResult.value = "";
  tested.value = model?.validationSnapshot?.result; testFingerprint.value = model?.validationSnapshot?.fingerprint ?? "";
  error.value = "";
  await nextTick();
  const controls = editorControls();
  (controls.find(element => element.tagName === "INPUT") ?? controls[0])?.focus();
}
function close() {
  if (busy.value) return;
  draft.value = undefined;
  key.value = "";
  void nextTick(() => returnFocus?.focus());
}
function validateDraft() {
  if (!draft.value) throw new Error("模型配置不存在");
  try { validateModelConfiguration(draft.value); }
  catch (reason) { revealAdvancedSettings(); throw reason; }
  const seconds = Number(draft.value.timeoutSeconds ?? DEFAULT_MODEL_TIMEOUT_SECONDS);
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 900) {
    revealAdvancedSettings();
    throw new Error(zh.value ? "请求超时必须是 10-900 秒的整数" : "Timeout must be an integer from 10 to 900 seconds");
  }
  if (draft.value.source !== "official") {
    if (![draft.value.model, draft.value.endpoint].every(value => value.trim())) throw new Error(zh.value ? "请填写模型名称和接口地址" : "Enter a model name and endpoint");
    const url = new URL(draft.value.endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("接口地址必须是无凭据、查询参数和片段的 HTTP / HTTPS 地址");
  }
}
async function testDraft() {
  if (!draft.value || busy.value) return;
  error.value = ""; testResult.value = "";
  tested.value = undefined; testFingerprint.value = "";
  delete draft.value.validationSnapshot;
  try {
    validateDraft();
    validateModelConfiguration(draft.value, { requireStructured: validationMode.value !== "parameters" });
    const apiKey = draft.value.source === "official" ? store.modelApiKeys[draft.value.id] : key.value;
    if (!apiKey) throw new Error(zh.value ? "请先填写 API Key 或登录官方账号" : "Enter an API key or sign in first");
    busy.value = true; testing.value = true;
    const testedFingerprint = fingerprint.value;
    const result = await backend.checkModel({ apiKey, endpoint: draft.value.endpoint, model: draft.value.model,
      capabilities: draft.value.capabilities, requestParameters: draft.value.requestParameters, timeoutSeconds: draft.value.timeoutSeconds,
      apiProtocol: draft.value.apiProtocol, outputPolicy: draft.value.outputPolicy, capabilitiesV2: draft.value.capabilitiesV2 }, validationMode.value);
    tested.value = { ...result, validation: result.validation ?? { modelAccess: result.available ? "passed" : "not_tested", structuredOutput: "not_tested", businessContract: "not_tested" } };
    testFingerprint.value = testedFingerprint;
    if (!result.available) throw new Error(result.reason);
    testResult.value = result.reason;
  } catch (reason) {
    const classified = modelServiceError(reason);
    error.value = classified ? modelServiceErrorMessage(classified) : reason instanceof Error ? reason.message : String(reason);
  } finally { testing.value = false; busy.value = false; }
}
async function previewDraft() {
  if (!draft.value || busy.value) return;
  error.value = "";
  preview.value = undefined; previewFingerprint.value = "";
  try {
    validateDraft(); validateModelConfiguration(draft.value, { requireStructured: validationMode.value !== "parameters" });
    busy.value = true; previewing.value = true;
    const captured = fingerprint.value;
    const capturedMode = validationMode.value;
    preview.value = await backend.previewModelRequest({ endpoint: draft.value.endpoint, model: draft.value.model,
      capabilities: draft.value.capabilities, requestParameters: draft.value.requestParameters,
      apiProtocol: draft.value.apiProtocol, outputPolicy: draft.value.outputPolicy, capabilitiesV2: draft.value.capabilitiesV2 }, validationMode.value);
    previewFingerprint.value = captured;
    previewMode.value = capturedMode;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { busy.value = false; previewing.value = false; }
}
function editorControls() {
  return [...(drawer.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary') ?? [])]
    .filter(element => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(":scope > summary")?.contains(element)) return false;
      }
      return true;
    });
}
function revealInvalid(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
}
function revealAdvancedSettings() {
  drawer.value?.querySelectorAll<HTMLDetailsElement>(".model-options, .capability-limits, .advanced-parameters")
    .forEach(detail => { detail.open = true; });
}
function keyboard(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  if (event.key === "Escape") { event.preventDefault(); close(); }
  if (event.key !== "Tab") return;
  const elements = editorControls();
  const first = elements[0], last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
async function save() {
  if (!draft.value || busy.value) return;
  error.value = "";
  try {
    validateDraft();
    const timeoutSeconds = Number(draft.value.timeoutSeconds ?? DEFAULT_MODEL_TIMEOUT_SECONDS);
    busy.value = true;
    const model = JSON.parse(JSON.stringify(draft.value)) as ModelProfile;
    model.timeoutSeconds = timeoutSeconds;
    model.name = model.name.trim() || model.model.trim();
    if (model.source === "official") {
      const current = store.models.find(item => item.id === model.id && item.source === "official");
      if (!account.current || !current) throw new Error("账号或官方模型列表已改变，请关闭后重试");
      saveOfficialPreferences(model);
      Object.assign(current, { timeoutSeconds, requestParameters: model.requestParameters, apiProtocol: model.apiProtocol, outputPolicy: model.outputPolicy });
      emit("saved");
      busy.value = false; close(); return;
    }
    model.hasApiKey = Boolean(key.value);
    if (tested.value && !testStale.value) model.validationSnapshot = { fingerprint: testFingerprint.value, validatedAt: new Date().toISOString(), result: tested.value };
    else delete model.validationSnapshot;
    await store.saveModelProfile(model, key.value);
    // Editing any field/key clears this result. Only the unchanged, explicitly
    // tested draft may carry its successful status into the saved profile.
    if (testResult.value && !testStale.value && model.enabled) {
      store.modelAvailability[model.id] = { status: "available", reason: testResult.value, checkedAt: new Date().toISOString() };
    }
    emit("saved");
    busy.value = false;
    close();
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { busy.value = false; }
}
async function remove() {
  if (!draft.value || draft.value.source === "official" || busy.value) return;
  busy.value = true;
  try { await store.removeModel(draft.value.id); busy.value = false; close(); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { busy.value = false; }
}
</script>

<template>
  <div :class="['page', 'management-page', { 'embedded-models': embedded }]">
    <header class="page-header">
      <div><span class="eyebrow">{{ zh ? "模型配置" : "MODEL CONFIGURATION" }}</span><h1>{{ t('settings.modelTitle') }}</h1><p>{{ t('settings.modelSubtitle') }}</p></div>
      <button class="button primary" @click="edit()"><Plus :size="15"/>{{ t('settings.addModel') }}</button>
    </header>
    <p v-if="catalog.error" class="catalog-status" role="status">{{ catalog.loaded ? (zh ? '暂时无法更新，正在显示已缓存的官方模型目录。' : 'Unable to refresh. Showing the cached official catalogue.') : (zh ? '官方模型目录暂时不可用，本地模型不受影响。' : 'The official catalogue is unavailable. Your own models are unaffected.') }}</p>
    <p v-else-if="catalog.loaded && !officialModels.length" class="catalog-status">{{ zh ? '暂无已开放的官方模型。' : 'No official models are currently offered.' }}</p>
    <main class="model-grid">
      <article v-for="model in officialModels" :key="`official:${model.id}`" class="model-card official-model-card" :class="{ 'is-locked': !account.current }">
        <button class="official-model-open" :disabled="!model.profile" :aria-label="`${model.name} · ${zh ? '官方模型设置' : 'Official model settings'}`" @click="model.profile && edit(model.profile)">
          <span class="official-label">OpsArk · {{ zh ? '官方模型' : 'Official' }}</span>
          <span class="card-heading"><span class="model-symbol"><Box :size="20"/></span><strong :title="model.name">{{ model.name }}</strong><ChevronRight v-if="model.profile" class="card-arrow" :size="16"/></span>
          <span class="model-identity">{{ zh ? '请求超时' : 'Timeout' }} · {{ model.profile?.timeoutSeconds ?? DEFAULT_MODEL_TIMEOUT_SECONDS }}s</span>
          <span class="card-footer"><span :class="['status-dot', model.profile ? store.modelAvailability[model.profile.id]?.status : 'disabled']"></span><span>{{ !account.current ? (zh ? '登录后使用官方额度' : 'Sign in to use your credits') : model.profile ? modelStatus(model.profile) : account.busy ? (zh ? '正在确认可用状态…' : 'Checking availability…') : (zh ? '此模型暂不可用' : 'Currently unavailable') }}</span><span v-if="model.profile" class="edit-label">{{ zh ? '设置' : 'Settings' }}</span></span>
        </button>
        <RouterLink v-if="!account.current" to="/account" class="official-model-lock" :aria-label="`${model.name} · ${zh ? '登录后使用' : 'Sign in to use'}`"><span><LockKeyhole :size="14"/>{{ zh ? '登录后使用' : 'Sign in to use' }}<ChevronRight :size="14"/></span></RouterLink>
      </article>
      <div v-if="catalog.loading && !catalog.loaded && !officialModels.length" class="model-card catalog-skeleton" role="status"><span class="official-label">OpsArk · {{ zh ? '官方模型' : 'Official' }}</span><span class="skeleton-line"></span><span class="skeleton-line short"></span><small>{{ zh ? '正在获取官方模型…' : 'Loading official models…' }}</small></div>
      <button v-for="model in localModels" :key="model.id" class="model-card" @click="edit(model)">
        <span class="card-heading"><span class="model-symbol"><Box :size="20"/></span><strong :title="model.name">{{ model.name }}</strong><ChevronRight class="card-arrow" :size="16"/></span>
        <span class="model-identity" :title="modelIdentity(model)">{{ modelIdentity(model) }}</span>
        <span class="model-endpoint" :title="model.endpoint || '-'">{{ model.endpoint || '-' }}</span>
        <span class="card-footer"><span :class="['status-dot', model.enabled ? store.modelAvailability[model.id]?.status : 'disabled']"></span><span :title="modelStatus(model)">{{ modelStatus(model) }}</span><span class="edit-label">{{ zh ? '编辑' : 'Edit' }}</span></span>
      </button>
      <button v-if="!localModels.length" class="empty-card" @click="edit()"><Plus :size="24"/><span>{{ t('settings.addModel') }}</span></button>
    </main>
    <Teleport to="body">
      <Transition name="model-drawer">
        <div v-if="draft" class="drawer-overlay" @keydown="keyboard">
          <section ref="drawer" class="model-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="model-editor-title" :aria-busy="busy">
            <header class="drawer-header"><span class="drawer-model-icon"><Box :size="18"/></span><div><small>{{ zh ? '模型详情' : 'Model details' }}</small><h2 id="model-editor-title" :title="draft.name">{{ draft.name || (zh ? '模型配置' : 'Model configuration') }}</h2></div><button class="icon-button" :disabled="busy" :aria-label="zh ? '关闭编辑' : 'Close editor'" @click="close"><X :size="20"/></button></header>
            <form class="drawer-form" @submit.prevent="save" @invalid.capture="revealInvalid">
              <fieldset :disabled="busy" class="drawer-body">
                <div v-if="draft.source !== 'official'" class="section-heading"><strong>{{ zh ? '连接配置' : 'Connection' }}</strong><label class="enabled-control"><input v-model="draft.enabled" type="checkbox"/>{{ zh ? '启用模型' : 'Enabled' }}</label></div>
                <p class="setup-intro">{{ draft.source === 'official'
                  ? (zh ? '平台已完成接入配置，可直接使用。' : 'Configured by the platform and ready to use.')
                  : (zh ? '保存仅检查本地配置。未知接入的协议和输出能力需确认后才能发起模型请求。' : 'Saving checks local configuration. Confirm an unknown endpoint’s protocol and output capabilities before making model requests.') }}</p>
                <div v-if="draft.source !== 'official'" class="connection-fields basic-connection-fields">
                  <label v-if="!store.models.some(model => model.id === draft?.id)" class="full"><span>{{ zh ? '精确接入预设' : 'Exact connection preset' }}</span><ParameterSelect :model-value="selectedPreset" :options="presetOptions" ariaLabel="Exact connection preset" @update:model-value="selectPreset"/><small>{{ zh ? '主动选择后填写官方地址、准确模型 ID 和协议；其他地址或别名使用自定义接入，不会从品牌猜测能力。' : 'Explicit selection fills the official endpoint, exact model ID and protocol. Other endpoints and aliases use custom configuration without inferred capabilities.' }}</small></label>
                  <label class="full"><span>{{ zh ? '接入来源' : 'Connection source' }}</span><ParameterSelect :model-value="draft.capabilitiesV2?.parameterAdapter ?? draft.capabilities?.parameterAdapter ?? 'portable'" :options="adapterOptions" :ariaLabel="zh ? '接入来源' : 'Connection source'" @update:model-value="changeAdapter"/></label>
                  <label class="full"><span>{{ t('settings.endpoint') }}</span><input v-model="draft.endpoint" required placeholder="https://api.example.com/v1" :aria-label="t('settings.endpoint')"/><small>{{ zh ? '使用服务商提供的兼容接口地址。' : 'Use the compatible API endpoint supplied by your provider.' }}</small></label>
                  <label class="full"><span>API Key</span><input v-model="key" type="password" autocomplete="off" :placeholder="t('settings.apiKeyPlaceholder')" aria-label="API Key"/></label>
                  <label class="full"><span>{{ t('settings.modelName') }}</span><input v-model="draft.model" required :aria-label="t('settings.modelName')"/><small>{{ zh ? '填写接口中的模型 ID，同时用作默认显示名称。' : 'Enter the API model ID. It also serves as the default display name.' }}</small></label>
                </div>
                <div class="connection-fields generation-budget">
                  <label class="full"><span>{{ zh ? '最大生成预算（Token）' : 'Maximum generation budget (tokens)' }}</span><input type="number" aria-label="outputBudget" :value="budget" min="1" :max="capability?.maxOutputTokens ?? 1000000" step="1" @input="updateBudget(($event.target as HTMLInputElement).value)"/><small>{{ draft.capabilitiesV2?.budgetSemantics === 'total_output' ? (zh ? '包含回答与推理消耗。' : 'Includes visible output and reasoning.') : draft.capabilitiesV2?.budgetSemantics === 'visible_output' ? (zh ? '此接入限制可见回答输出。' : 'This endpoint limits visible output.') : (zh ? '计数含义尚未确认，保留当前预算，不因格式错误自动提高。' : 'Counting semantics are unconfirmed. The configured budget is retained and never increased for format errors.') }}</small></label>
                  <button v-if="draft.requestParameters?.max_tokens !== undefined || draft.requestParameters?.max_completion_tokens !== undefined" type="button" class="button secondary full" @click="updateBudget(budget)">{{ zh ? '将现有预算迁移为通用生成预算' : 'Migrate the current limit to a semantic generation budget' }}</button>
                </div>
                <p class="effective-output" role="status">{{ zh ? '预期输出方式：' : 'Expected output: ' }}{{ outputMode === 'json_schema' ? (zh ? 'Schema 约束 + 本地业务校验' : 'Schema constraints + local validation') : outputMode === 'json_object' ? (zh ? 'JSON 输出 + 本地业务校验' : 'JSON + local validation') : draft.source === 'official' ? (zh ? '平台尚未确认结构输出能力，请管理员核对接入配置后刷新官方模型。' : 'The platform has not confirmed structured output. Ask the administrator to verify the route, then refresh official models.') : (zh ? '能力待确认；尚未启用结构生成' : 'Unconfirmed; structured generation is not enabled') }}</p>
                <details class="model-options">
                  <summary><strong>{{ zh ? '高级设置' : 'Advanced settings' }}</strong><span>{{ zh ? '按需调整' : 'Optional' }}</span></summary>
                  <div class="connection-fields">
                    <template v-if="draft.source !== 'official'">
                      <label><span>{{ zh ? '显示名称（选填）' : 'Display name (optional)' }}</span><input v-model="draft.name" :placeholder="draft.model || (zh ? '默认使用模型名称' : 'Defaults to model name')" :aria-label="zh ? '显示名称' : 'Display name'"/></label>
                      <label><span>{{ t('settings.provider') }}</span><input v-model="draft.provider"/></label>
                    </template>
                    <label class="full"><span>API {{ zh ? '协议' : 'protocol' }}</span><ParameterSelect :model-value="draft.apiProtocol ?? draft.capabilitiesV2?.preferredProtocol ?? 'chat_completions'" :options="protocolOptions" ariaLabel="API protocol" @update:model-value="changeProtocol"/></label>
                    <label class="full"><span>{{ zh ? '结构输出策略' : 'Output policy' }}</span><ParameterSelect :model-value="draft.outputPolicy ?? 'auto'" :options="outputPolicyOptions" ariaLabel="Output policy" @update:model-value="draft.outputPolicy = $event as ModelProfile['outputPolicy']"/></label>
                    <label class="full"><span>{{ zh ? '请求超时（秒）' : 'Request timeout (seconds)' }}</span><input v-model.number="draft.timeoutSeconds" aria-label="timeoutSeconds" type="number" min="10" max="900" step="1" required/><small>{{ zh ? '响应较慢时可增加等待时间，默认 90 秒。' : 'Increase this for slower responses. The default is 90 seconds.' }}</small></label>
                  </div>
                  <details v-if="draft.source !== 'official'" class="capability-limits">
                    <summary>{{ zh ? '接口兼容设置' : 'API compatibility' }}</summary>
                    <p class="compatibility-note">{{ zh ? '仅在接口要求特殊参数或测试不通过时调整。两种输出方式都会校验返回结构。' : 'Adjust only for provider-specific requirements or failed tests. Responses are validated in both output modes.' }}</p>
                    <div class="connection-fields">
                      <label class="full"><span>{{ zh ? '当前接入的能力声明' : 'Declared endpoint capabilities' }}</span><ParameterSelect :model-value="outputMode" :options="formatOptions" :ariaLabel="zh ? '结构输出能力' : 'Structured output capability'" @update:model-value="changeCapability"/><small>{{ zh ? '按这个具体地址、协议和模型的文档填写；选择来源本身不证明 Schema 能力，声明也不等于真实测试通过。' : 'Use documentation for this exact endpoint, protocol and model. Selecting a provider does not prove Schema support, and a declaration is not a completed test.' }}</small></label>
                      <label class="full"><span>{{ zh ? 'Schema 的 strict 参数声明' : 'Schema strict parameter declaration' }}</span><ParameterSelect :model-value="draft.capabilitiesV2 ? (draft.capabilitiesV2.strictFlag ?? '') : (draft.capabilities?.structuredOutput === 'json_schema' ? 'required' : '')" :options="strictFlagOptions" ariaLabel="Schema strict flag" @update:model-value="declareStrictFlag"/><small>{{ zh ? '支持 JSON Schema 不代表接口接受 strict。仅按该模型和 API 文档单独声明；strict 为未知、可选或不支持时均不发送。' : 'JSON Schema support does not establish support for strict. Declare it separately for this model and API; unknown, optional and unsupported all omit the flag.' }}</small></label>
                      <label v-if="draft.capabilitiesV2" class="full"><span>{{ zh ? '能力来源 / 版本' : 'Capability source / revision' }}</span><small>{{ draft.capabilitiesV2.evidence.source }} · {{ draft.capabilitiesV2.revision }}</small></label>
                      <label v-if="draft.capabilitiesV2"><span>{{ zh ? '接入预算上限' : 'Connection budget limit' }}</span><input v-model.number="draft.capabilitiesV2.maxOutputTokens" type="number" :min="draft.capabilitiesV2.defaultOutputTokens" max="1000000" step="1"/></label>
                      <label v-else-if="draft.capabilities"><span>{{ zh ? '接入预算上限' : 'Connection budget limit' }}</span><input v-model.number="draft.capabilities.maxOutputTokens" type="number" :min="draft.capabilities.defaultOutputTokens" max="1000000" step="1"/></label>
                    </div>
                    <details class="parameter-declarations"><summary>{{ zh ? '声明该模型支持的高级参数' : 'Declare supported advanced parameters' }}</summary><p class="compatibility-note">{{ zh ? '仅根据当前模型/模式文档开启；未声明的参数不会发送。已有值仍保留并显示冲突。' : 'Enable only with documentation for this model and mode. Undeclared parameters are not sent; existing conflicting values are retained.' }}</p><div class="declaration-checks"><label v-for="(label, parameter) in {temperature:'temperature',topP:'top_p',presencePenalty:'presence_penalty'}" :key="parameter"><input type="checkbox" :checked="draft.capabilitiesV2?.parameterRules?.[parameter] === 'supported'" @change="declareParameter(parameter, ($event.target as HTMLInputElement).checked)"/>{{ label }}</label><label><input type="checkbox" :checked="draft.capabilitiesV2?.parameterRules?.frequencyPenalty === true" @change="declareParameter('frequencyPenalty', ($event.target as HTMLInputElement).checked)"/>frequency_penalty</label><label><input type="checkbox" :checked="draft.capabilitiesV2?.parameterRules?.thinkingEnabled === true" @change="declareParameter('thinkingEnabled', ($event.target as HTMLInputElement).checked)"/>thinking</label></div><label class="reasoning-declaration">{{ zh ? '支持的推理档位（逗号分隔，留空表示未声明）' : 'Supported reasoning levels (comma separated; empty means undeclared)' }}<input aria-label="Declared reasoning levels" :value="draft.capabilitiesV2?.parameterRules?.reasoningEfforts.join(', ') ?? ''" @input="declareParameter('reasoningEfforts', ($event.target as HTMLInputElement).value)"/></label></details>
                  </details>
                  <ModelAdvancedParameters :model="draft"/>
                </details>
                <div class="validation-controls"><label>{{ zh ? '验证范围' : 'Validation scope' }}<ParameterSelect v-model="validationMode" :options="[{value:'parameters',label:zh?'连接 / 参数':'Connection / parameters'},{value:'structured',label:zh?'基础结构':'Basic structure'},{value:'business',label:zh?'Opsark 业务契约':'Opsark business contract'}]" ariaLabel="Validation scope"/></label><button class="button secondary" type="button" :disabled="busy" @click="previewDraft">{{ zh ? '验证请求预览' : 'Validation request preview' }}</button></div>
                <div v-if="tested" class="validation-layers" role="status"><strong>{{ testStale ? (zh ? '验证已过期：配置已修改' : 'Validation expired: configuration changed') : (zh ? '当前草稿的验证范围' : 'Validation for this draft') }}</strong><p v-for="(label, layer) in {modelAccess: zh?'模型可访问':'Model access',structuredOutput:zh?'基础结构':'Basic structure',businessContract:zh?'业务契约':'Business contract'}" :key="layer">{{ label }} · {{ tested.validation?.[layer] === 'passed' ? (zh ? '通过' : 'Passed') : tested.validation?.[layer] === 'failed' ? (zh ? '未通过' : 'Failed') : (zh ? '未验证' : 'Not tested') }}</p></div>
                <details v-if="preview" class="request-preview" open><summary>{{ zh ? '验证请求的本地预览（实际构造器，不含密钥，不联网）' : 'Local validation request preview (actual builder, no key, no network)' }}{{ previewStale ? (zh ? ' · 已过期' : ' · Expired') : '' }}</summary><p>{{ zh ? '使用当前验证范围的固定样例，不是某个任务的真实提示词。' : 'Uses a fixed fixture for the selected validation scope, not a task prompt.' }}</p><p>{{ preview.apiProtocol }} · {{ preview.endpoint }}</p><pre>{{ JSON.stringify(preview, null, 2) }}</pre></details>
                <p class="testing-notice">{{ zh ? '保存不会调用模型；测试会发送一条简短请求，可能产生少量费用。' : 'Saving makes no model request. Testing sends a short request and may incur a small charge.' }}</p>
              </fieldset>
              <footer class="drawer-footer"><p v-if="error" role="alert">{{ localizeCoreText(error) }}</p><p v-if="testResult && !testStale" class="test-success" role="status">{{ testResult }}</p><span v-if="busy" role="status">{{ testing ? (zh ? '正在测试当前模型…' : 'Testing current model…') : previewing ? (zh ? '正在本地编译预览…' : 'Compiling local preview…') : (zh ? '正在保存…' : 'Saving…') }}</span><div><button v-if="draft.source !== 'official' && store.models.some(model => model.id === draft?.id)" class="button danger" type="button" :disabled="busy" @click="remove"><Trash2 :size="14"/>{{ t('settings.removeModel') }}</button><span class="footer-spacer"></span><button class="button secondary" type="button" :disabled="busy" @click="testDraft">{{ zh ? '测试当前模型' : 'Test this model' }}</button><button class="button secondary" type="button" :disabled="busy" @click="close">{{ zh ? '取消' : 'Cancel' }}</button><button class="button primary" :disabled="busy" type="submit"><Save :size="14"/>{{ t('common.save') }}</button></div></footer>
            </form>
          </section>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.embedded-models{padding:0!important}.embedded-models .page-header{margin-top:0}.capability-limits{margin-top:20px;border-top:1px solid var(--border);font-size:12px}.capability-limits>summary{padding:14px 0;cursor:pointer;color:var(--muted)}.capability-limits small,.testing-notice{display:block;color:var(--muted);font-size:11px;line-height:1.6;margin-top:12px}.drawer-footer .test-success{color:var(--accent)}.drawer-footer>div{flex-wrap:wrap}.connection-fields :deep(.parameter-select){width:100%}
.catalog-status{font-size:12px;color:var(--muted);line-height:1.6;margin:0 0 16px}.official-model-card{position:relative;padding:0!important;border-color:color-mix(in srgb,var(--accent) 40%,var(--border))!important;background:color-mix(in srgb,var(--accent) 5%,var(--panel))!important}.official-model-card:before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--accent);pointer-events:none}.official-model-open{display:flex;flex-direction:column;gap:12px;width:100%;height:100%;padding:20px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.official-model-open:disabled{opacity:1;cursor:default}.official-model-open:focus-visible{outline:2px solid var(--accent);outline-offset:-4px}.official-label{font-size:10px;font-weight:600;letter-spacing:.035em;color:var(--accent)}.official-model-card .card-footer{margin-top:auto}.official-model-lock{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;padding:16px;background:linear-gradient(to bottom,transparent 28%,color-mix(in srgb,var(--panel) 48%,transparent) 50%,var(--panel) 80%);color:var(--text);text-decoration:none}.official-model-lock>span{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid color-mix(in srgb,var(--accent) 40%,var(--border));border-radius:6px;background:var(--panel);font-size:12px;font-weight:500;transition:background .18s}.official-model-lock:hover>span{background:var(--accent-soft)}.official-model-lock:focus-visible{outline:2px solid var(--accent);outline-offset:-4px}.official-model-lock:active>span{transform:translateY(1px)}.catalog-skeleton{pointer-events:none;min-height:188px}.catalog-skeleton small{color:var(--muted);font-size:12px}.skeleton-line{display:block;height:18px;width:70%;border-radius:4px;background:var(--border-soft)}.skeleton-line.short{width:45%;height:12px}
.model-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr));gap:16px;width:100%;max-width:1400px;min-width:0;overflow:hidden}.model-card{display:flex;flex-direction:column;gap:12px;width:100%;max-width:100%;min-width:0;overflow:hidden;text-align:left;padding:20px;border:1px solid var(--border);border-radius:12px;background:var(--panel);color:var(--text);cursor:pointer;transition:transform .18s,border-color .18s,background .18s}.model-card:hover{transform:translateY(-2px);border-color:var(--accent);background:var(--panel-2)}.model-card:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.card-heading{display:flex;align-items:center;gap:12px;width:100%;min-width:0}.card-heading strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px}.model-symbol{flex-shrink:0;padding:9px;background:var(--accent-soft);color:var(--accent);border-radius:9px;display:flex}.card-arrow{margin-left:auto;flex-shrink:0;color:var(--muted)}.model-identity,.model-endpoint{display:block;width:100%;max-width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--muted)}.model-endpoint{font-size:11px}.card-footer{display:flex;gap:7px;align-items:center;width:100%;min-width:0;overflow:hidden;border-top:1px solid var(--border-soft);padding-top:12px;font-size:11px;color:var(--muted)}.card-footer>span:nth-child(2){display:block;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status-dot{width:6px;height:6px;border-radius:50%;background:var(--muted);flex-shrink:0}.status-dot.available{background:var(--accent)}.status-dot.unavailable{background:var(--red)}.edit-label{margin-left:auto;color:var(--accent);flex-shrink:0}.empty-card{min-height:170px;border:1px dashed var(--border);border-radius:12px;background:var(--panel);color:var(--muted);display:flex;align-items:center;justify-content:center;gap:12px;cursor:pointer}.drawer-overlay{position:fixed;inset:0;z-index:1200;background:var(--scrim);display:flex;justify-content:flex-end}.model-drawer-panel{width:min(620px,100vw);height:100%;display:flex;flex-direction:column;background:var(--panel);color:var(--text);border-left:1px solid var(--border);box-shadow:var(--shadow-dialog)}.drawer-header{display:flex;align-items:center;justify-content:space-between;padding:26px 28px;border-bottom:1px solid var(--border)}.drawer-header h2{font-size:20px;margin:8px 0 0;overflow-wrap:anywhere}.drawer-form{display:flex;flex-direction:column;flex:1;min-height:0}.drawer-body{border:0;margin:0;padding:24px 28px;overflow-y:auto;min-height:0;flex:1;min-width:0}.section-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px;font-size:13px}.enabled-control{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.connection-fields{display:grid;grid-template-columns:1fr 1fr;gap:18px}.connection-fields label{display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--muted)}.connection-fields .full{grid-column:1/-1}.connection-fields input{width:100%;min-width:0;height:40px;padding:0 12px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text)}input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}.drawer-body :deep(.parameter-grid){grid-template-columns:repeat(2,minmax(0,1fr))}.drawer-footer{border-top:1px solid var(--border);padding:18px 28px;background:var(--panel)}.drawer-footer>div{display:flex;align-items:center;gap:10px}.footer-spacer{flex:1}.drawer-footer p{color:var(--red);font-size:12px;overflow-wrap:anywhere}.drawer-footer>span{display:block;font-size:12px;color:var(--muted);margin-bottom:10px}.model-drawer-enter-active,.model-drawer-leave-active{transition:opacity .2s}.model-drawer-enter-active .model-drawer-panel,.model-drawer-leave-active .model-drawer-panel{transition:transform .24s ease}.model-drawer-enter-from,.model-drawer-leave-to{opacity:0}.model-drawer-enter-from .model-drawer-panel,.model-drawer-leave-to .model-drawer-panel{transform:translateX(100%)}@media(prefers-reduced-motion:reduce){.model-card,.model-drawer-enter-active,.model-drawer-leave-active,.model-drawer-panel{transition:none!important}}@media(max-width:480px){.model-grid{grid-template-columns:1fr}.drawer-header,.drawer-body,.drawer-footer{padding:18px}.connection-fields{grid-template-columns:1fr}}
.connection-fields small{font-size:11px;line-height:1.5}.field-help{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-left:4px;border:1px solid var(--border);border-radius:50%;font-size:10px;color:var(--muted);cursor:help}
.drawer-header{position:relative;z-index:2;display:grid;grid-template-columns:38px minmax(0,1fr) 34px;align-items:center;gap:12px;min-height:76px;padding:14px 22px;background:var(--panel)}.drawer-header>div{min-width:0}.drawer-header small{display:block;margin-bottom:4px;color:var(--muted);font-size:10px}.drawer-header h2{max-width:100%;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:18px;line-height:1.3}.drawer-header .icon-button{margin:0}.drawer-model-icon{display:grid;width:38px;height:38px;place-items:center;border-radius:8px;background:var(--accent-soft);color:var(--accent)}
</style>

<style scoped>
.embedded-models{background:transparent;min-height:0}
@media(max-width:480px){
  .drawer-footer>div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
  .drawer-footer .footer-spacer{display:none}
  .drawer-footer .button{width:100%;justify-content:center}
  .drawer-footer .button.primary{grid-column:2}
}
</style>

<style scoped>
.setup-intro{margin:0 0 22px;color:var(--muted);font-size:12px;line-height:1.7}
.model-options{margin-top:26px;border-top:1px solid var(--border);font-size:12px}
.model-options>summary{display:flex;align-items:center;gap:12px;padding:18px 0;cursor:pointer;color:var(--text);list-style:none}
.model-options>summary::-webkit-details-marker{display:none}
.model-options>summary::marker{content:""}
.model-options>summary::before{content:"›";color:var(--muted);font-size:18px;line-height:1;transition:transform .15s}
.model-options[open]>summary::before{transform:rotate(90deg)}
.model-options>summary strong{font-weight:500}.model-options>summary span{margin-left:auto;color:var(--muted);font-size:11px}
.model-options summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.compatibility-note{margin:0 0 18px;color:var(--muted);font-size:11px;line-height:1.6}
.generation-budget{margin-top:22px}.effective-output{color:var(--muted);font-size:12px;line-height:1.7}.validation-controls{display:flex;align-items:end;gap:12px;margin-top:22px}.validation-controls label{display:flex;flex:1;flex-direction:column;gap:8px;font-size:12px;color:var(--muted)}.validation-layers,.request-preview{margin-top:18px;padding:14px;border:1px solid var(--border);border-radius:7px;font-size:12px}.validation-layers p{margin:8px 0 0;color:var(--muted)}.request-preview summary{cursor:pointer;line-height:1.6}.request-preview p{overflow-wrap:anywhere;color:var(--muted)}.request-preview pre{max-height:280px;overflow:auto;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}
.parameter-declarations{margin-top:16px}.parameter-declarations summary{cursor:pointer;padding:12px 0;color:var(--muted)}.declaration-checks{display:flex;flex-wrap:wrap;gap:12px;color:var(--muted)}.declaration-checks label{display:flex;align-items:center;gap:6px}.reasoning-declaration{display:flex;flex-direction:column;gap:8px;margin-top:14px;color:var(--muted);line-height:1.6}.reasoning-declaration input{padding:9px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text)}
</style>
