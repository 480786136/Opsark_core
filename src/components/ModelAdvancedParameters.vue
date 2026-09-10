<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { SlidersHorizontal, RotateCcw } from "lucide-vue-next";
import type { ModelProfile, ModelRequestParameters } from "@/types";
import { numericParameters, validateRequestParameters } from "@/features/agent/modelParameters";
const props = defineProps<{ model: ModelProfile }>();
const { locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const values = computed(() => props.model.requestParameters ?? {});
const error = computed(() => { try { validateRequestParameters(values.value); return ""; } catch (e) { return String(e instanceof Error ? e.message : e); } });
function update(key: keyof ModelRequestParameters, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  const next = { ...values.value };
  delete next[key];
  if (value !== "") Object.assign(next, { [key]: numericParameters.some(field => field.key === key) ? Number(value) : value });
  props.model.requestParameters = next;
}
const preview = computed(() => {
  const result: Record<string, unknown> = { ...values.value };
  if (result.thinking === "default") delete result.thinking;
  else if (result.thinking) result.thinking = { type: result.thinking };
  return JSON.stringify(result, null, 2);
});
</script>
<template>
  <details class="advanced-parameters">
    <summary><SlidersHorizontal :size="15"/><strong>{{ zh ? '高级请求参数' : 'Advanced request parameters' }}</strong><span>{{ Object.keys(values).length }} {{ zh ? '项自定义' : 'overrides' }}</span></summary>
    <div class="advanced-body">
      <p>{{ zh ? '留空保持应用默认值；自定义值覆盖同名参数，适用于规划、复核和总结。不同模型支持范围不同，保存时会测试实际生成请求。' : 'Empty fields retain application defaults. Overrides apply to planning, reviews and summaries. Saving tests a real generation request; provider support varies.' }}</p>
      <div class="parameter-grid">
        <label v-for="field in numericParameters" :key="field.key"><span>{{ field.key }}</span><input type="number" :aria-label="field.key" :value="values[field.key]" :min="field.min" :max="field.max" :step="field.step" :placeholder="zh ? '默认' : 'Default'" @input="update(field.key, $event)"/><small>{{ field.min }} – {{ field.max }}</small></label>
        <label><span>reasoning_effort</span><select :value="values.reasoning_effort ?? ''" @change="update('reasoning_effort', $event)"><option value="">{{ zh ? '默认' : 'Default' }}</option><option value="low">{{ zh ? "低" : "Low" }}</option><option value="medium">{{ zh ? "中" : "Medium" }}</option><option value="high">{{ zh ? "高" : "High" }}</option></select></label>
        <label><span>thinking</span><select :value="values.thinking ?? ''" @change="update('thinking', $event)"><option value="">{{ zh ? '应用默认' : 'Application default' }}</option><option value="default">{{ zh ? '不发送，使用服务端默认' : 'Omit; provider default' }}</option><option value="enabled">{{ zh ? "开启" : "Enabled" }}</option><option value="disabled">{{ zh ? "关闭" : "Disabled" }}</option></select></label>
      </div>
      <p class="parameter-advice">{{ zh ? '建议一次只调整 temperature 或 top_p。两个 token 上限只能选一个；过低的上限可能截断计划。推理参数仅在接口支持时设置。测试请求可能产生少量费用。' : 'Adjust temperature or top_p individually. Choose one token limit; a low limit can truncate plans. Set reasoning options only when supported. Testing may incur a small charge.' }}</p>
      <p v-if="error" role="alert" class="parameter-error">{{ error }}</p>
      <div class="parameter-footer"><span>{{ zh ? '自定义请求字段预览' : 'Custom request fields' }}</span><button class="button secondary" type="button" @click="model.requestParameters = undefined"><RotateCcw :size="13"/>{{ zh ? '恢复默认' : 'Reset' }}</button></div>
      <pre>{{ preview }}</pre>
    </div>
  </details>
</template>
<style scoped>
.advanced-parameters{grid-column:1/-1;width:100%;border-top:1px solid var(--border);margin-top:12px;font-size:12px}
summary{display:flex;align-items:center;gap:9px;cursor:pointer;padding:16px 0;color:var(--muted);list-style:none}summary strong{color:var(--text);font-weight:500}summary span{margin-left:auto}summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.advanced-body p{color:var(--muted);line-height:1.7;margin:0 0 16px}.parameter-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.parameter-grid label{display:flex;flex-direction:column;gap:7px}.parameter-grid input,.parameter-grid select{width:100%;min-width:0;padding:9px 10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:7px}.parameter-grid small{color:var(--muted)}.parameter-advice{margin-top:18px!important}.parameter-error{color:var(--red)!important}.parameter-footer{display:flex;justify-content:space-between;align-items:center;color:var(--muted);margin-top:14px}pre{background:var(--bg);padding:14px;border:1px solid var(--border);border-radius:8px;overflow:auto;color:var(--text);max-height:220px}@media(max-width:800px){.parameter-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
