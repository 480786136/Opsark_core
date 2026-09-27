<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { SlidersHorizontal, RotateCcw } from "lucide-vue-next";
import ParameterSelect from "@/components/ParameterSelect.vue";
import type { ModelProfile, ModelRequestParameters } from "@/types";
import { numericParameters } from "@/features/agent/modelParameters";
import { parameterRules, validateModelConfiguration } from "@/features/agent/modelCapabilities";
import { localizeCoreText } from "@/features/preferences/coreText";
const props = defineProps<{ model: ModelProfile }>();
const { locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const values = computed(() => props.model.requestParameters ?? {});
const capabilities = computed(() => props.model.capabilitiesV2 ?? props.model.capabilities);
const rules = computed(() => parameterRules(capabilities.value));
const fields = computed(() => numericParameters.filter(field => {
  if (field.key === "outputBudget") return false;
  if (field.key.includes("tokens")) return values.value[field.key] !== undefined;
  if (!props.model.capabilitiesV2) return true;
  if (values.value[field.key] !== undefined) return true;
  return field.key === "frequency_penalty" ? rules.value?.frequencyPenalty === true
    : (field.key === "temperature" ? rules.value?.temperature : field.key === "top_p" ? rules.value?.topP : rules.value?.presencePenalty) === "supported";
}).map(field => ({ ...field,
  max: field.key.includes('tokens') ? (capabilities.value?.maxOutputTokens ?? field.max) : field.max,
  step: field.key.includes('tokens') ? 1 : field.step,
})));
const help = computed<Record<string, string>>(() => zh.value ? {
  temperature: "控制输出随机性。较低值更稳定，知识提炼通常建议 0.2 左右。", top_p: "控制核采样范围。通常只需调整 temperature 或 top_p 中的一个。", max_tokens: "限制响应最大输出 Token，适用于多数 OpenAI-compatible 接口。", max_completion_tokens: "部分推理模型使用的完成 Token 上限。不要与 max_tokens 同时设置。", frequency_penalty: "正值会减少重复用词。结构化提炼一般保持默认。", presence_penalty: "正值会鼓励引入新主题。为避免偏离原始证据，一般保持默认。", reasoning_effort: "设置推理强度。仅在上游模型支持该参数时使用。", thinking: "控制上游模型是否启用思考模式。关闭可为最终结构化输出保留更多 Token。",
} : {
  temperature: "Controls output randomness.", top_p: "Controls nucleus sampling; normally adjust this or temperature.", max_tokens: "Maximum response tokens for most OpenAI-compatible APIs.", max_completion_tokens: "Completion token limit used by some reasoning models; do not combine with max_tokens.", frequency_penalty: "Positive values reduce repeated wording.", presence_penalty: "Positive values encourage new topics and may drift from evidence.", reasoning_effort: "Sets reasoning intensity when supported upstream.", thinking: "Controls thinking mode; disabling it preserves tokens for final output.",
});
const optionSets = computed(() => ({
  reasoning_effort: [{ value: "", label: zh.value ? "默认" : "Default" }, { value: "low", label: zh.value ? "低" : "Low" }, { value: "medium", label: zh.value ? "中" : "Medium" }, { value: "high", label: zh.value ? "高" : "High" }],
  thinking: [{ value: "", label: zh.value ? "应用默认" : "Application default" }, { value: "default", label: zh.value ? "由适配器 / 上游决定" : "Adapter / provider default" }, { value: "enabled", label: zh.value ? "开启" : "Enabled" }, { value: "disabled", label: zh.value ? "关闭" : "Disabled" }],
}));
const error = computed(() => { try { validateModelConfiguration(props.model); return ""; } catch (e) { return localizeCoreText(String(e instanceof Error ? e.message : e), locale.value); } });
const supportedEfforts = computed(() => {
  const efforts = rules.value?.reasoningEfforts ?? (props.model.capabilitiesV2 ? [] : ["low", "medium", "high"]);
  return [{ value: "", label: zh.value ? "默认" : "Default" }, ...[...new Set([...efforts, ...(values.value.reasoning_effort ? [values.value.reasoning_effort] : [])])]
    .map(value => ({ value, label: optionSets.value.reasoning_effort.find(option => option.value === value)?.label ?? value,
      disabled: !efforts.includes(value) }))];
});
const supportedThinking = computed(() => optionSets.value.thinking.map(option => ({ ...option,
  disabled: option.value === 'enabled' && (props.model.capabilitiesV2 ? rules.value?.thinkingEnabled !== true : rules.value?.thinkingEnabled === false),
})));
function update(key: keyof ModelRequestParameters, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  const next = { ...values.value };
  delete next[key];
  if (value !== "") Object.assign(next, { [key]: numericParameters.some(field => field.key === key) ? Number(value) : value });
  props.model.requestParameters = next;
}
function updateValue(key: keyof ModelRequestParameters, value: string) {
  update(key, { target: { value } } as unknown as Event);
}
const preview = computed(() => JSON.stringify(values.value, null, 2));
function resetAdvanced() {
  const budget = Object.fromEntries(Object.entries(values.value).filter(([key]) => ["outputBudget", "max_tokens", "max_completion_tokens"].includes(key)));
  props.model.requestParameters = Object.keys(budget).length ? budget : undefined;
}
</script>
<template>
  <details class="advanced-parameters">
    <summary><SlidersHorizontal :size="15"/><strong>{{ zh ? '高级请求参数' : 'Advanced request parameters' }}</strong><span>{{ Object.keys(values).length }} {{ zh ? '项自定义' : 'overrides' }}</span></summary>
    <div class="advanced-body">
      <p>{{ zh ? '留空保持默认值；参数应用于规划、复核和总结。保存只做本地校验，测试需单独点击；官方路由强制参数可能覆盖此处设置。' : 'Empty fields retain defaults. Overrides apply to planning, reviews and summaries. Save validates locally; tests are explicit. Official route overrides may take precedence.' }}</p>
      <p v-if="capabilities">{{ zh ? '接入上限' : 'Connection limit' }}：{{ capabilities.maxOutputTokens }} Token</p>
      <div class="parameter-grid">
        <label v-for="field in fields" :key="field.key"><span class="parameter-label">{{ field.key }} <span class="parameter-help" tabindex="0" :data-tip="help[field.key]">?</span></span><input type="number" :aria-label="field.key" :value="values[field.key]" :min="field.min" :max="field.max" :step="field.step" :disabled="field.key === 'frequency_penalty' && rules?.frequencyPenalty === false && values[field.key] === undefined" :placeholder="zh ? '默认' : 'Default'" @input="update(field.key, $event)"/><small>{{ field.key === 'frequency_penalty' && rules?.frequencyPenalty === false ? (zh ? '当前接入不支持；已有值请清空' : 'Unsupported; clear any existing value') : `${field.min} - ${field.max}` }}</small></label>
        <label v-if="supportedEfforts.length > 1"><span class="parameter-label">reasoning_effort <span class="parameter-help" tabindex="0" :data-tip="help.reasoning_effort">?</span></span><ParameterSelect :model-value="values.reasoning_effort ?? ''" :options="supportedEfforts" :ariaLabel="'reasoning_effort'" size="small" @update:model-value="updateValue('reasoning_effort', $event)"/></label>
        <label v-if="!model.capabilitiesV2 || rules?.thinkingEnabled || values.thinking"><span class="parameter-label">thinking <span class="parameter-help" tabindex="0" :data-tip="help.thinking">?</span></span><ParameterSelect :model-value="values.thinking ?? ''" :options="supportedThinking" :ariaLabel="'thinking'" size="small" @update:model-value="updateValue('thinking', $event)"/></label>
      </div>
      <p class="parameter-advice">{{ zh ? '建议一次只调整 temperature 或 top_p。两个 token 上限只能选一个；过低的上限可能截断计划。推理参数仅在接口支持时设置。测试请求可能产生少量费用。' : 'Adjust temperature or top_p individually. Choose one token limit; a low limit can truncate plans. Set reasoning options only when supported. Testing may incur a small charge.' }}</p>
      <p v-if="error" role="alert" class="parameter-error">{{ error }}</p>
      <div class="parameter-footer"><span>{{ zh ? '已保存覆盖值（非最终请求）' : 'Saved overrides (not the final request)' }}</span><button class="button secondary" type="button" @click="resetAdvanced"><RotateCcw :size="13"/>{{ zh ? '恢复默认' : 'Reset' }}</button></div>
      <pre>{{ preview }}</pre>
    </div>
  </details>
</template>
<style scoped>
.advanced-parameters{grid-column:1/-1;width:100%;border-top:1px solid var(--border);margin-top:12px;font-size:12px}
summary{display:flex;align-items:center;gap:9px;cursor:pointer;padding:16px 0;color:var(--muted);list-style:none}summary strong{color:var(--text);font-weight:500}summary span{margin-left:auto}summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.advanced-body p{color:var(--muted);line-height:1.7;margin:0 0 16px}.parameter-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.parameter-grid label{display:flex;flex-direction:column;gap:7px}.parameter-grid input,.parameter-grid select{width:100%;min-width:0;padding:9px 10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:7px}.parameter-grid small{color:var(--muted)}.parameter-advice{margin-top:18px!important}.parameter-error{color:var(--red)!important}.parameter-footer{display:flex;justify-content:space-between;align-items:center;color:var(--muted);margin-top:14px}pre{background:var(--bg);padding:14px;border:1px solid var(--border);border-radius:8px;overflow:auto;color:var(--text);max-height:220px}@media(max-width:800px){.parameter-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
<style scoped>
.parameter-grid > label:nth-child(odd) .parameter-help::after{left:0;right:auto}
.parameter-label{display:flex;align-items:center;gap:5px;min-width:0}.parameter-help{position:relative;display:inline-grid;flex:0 0 16px;width:16px;height:16px;place-items:center;border:1px solid var(--border);border-radius:50%;color:var(--muted);font-size:10px;line-height:1;cursor:help}.parameter-help::after{content:attr(data-tip);position:absolute;z-index:30;right:0;bottom:calc(100% + 8px);width:min(260px,70vw);padding:9px 11px;border:1px solid var(--border);border-radius:7px;background:var(--raised);box-shadow:var(--shadow-popover);color:var(--text);font-size:11px;font-weight:400;line-height:1.55;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(3px);transition:opacity .14s,transform .14s}.parameter-help:hover::after,.parameter-help:focus-visible::after{opacity:1;visibility:visible;transform:translateY(0)}.parameter-help:focus-visible{outline:1px solid var(--accent);outline-offset:2px}
</style>
