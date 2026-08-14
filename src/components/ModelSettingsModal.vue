<script setup lang="ts">
import { ref } from "vue";
import { KeyRound, Plus, RefreshCw, Save, Shield, SlidersHorizontal, Trash2, X } from "lucide-vue-next";
import { useOpsStore } from "@/stores/ops";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const store = useOpsStore();
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");

async function save() {
  saveState.value = "saving";
  try {
    await store.saveModels();
    saveState.value = "saved";
    emit("saved");
  } catch {
    saveState.value = "error";
  }
}

async function recheck() {
  saveState.value = "saving";
  await store.refreshModelAvailability();
  saveState.value = "idle";
  emit("saved");
}

async function removeModel(modelId: string) {
  saveState.value = "saving";
  try {
    await store.removeModel(modelId);
    saveState.value = "idle";
    emit("saved");
  } catch {
    saveState.value = "error";
  }
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal-card model-settings-modal">
      <div class="modal-title">
        <div><h2>模型与安全</h2><p>配置智能运维使用的大模型，API Key 仅保存到系统钥匙串。</p></div>
        <button class="icon-button" type="button" @click="emit('close')"><X :size="18" /></button>
      </div>

      <div class="modal-section-title">
        <SlidersHorizontal :size="16" />
        <div><strong>大模型配置</strong><small>保存后会自动检查接口、鉴权和模型名称。</small></div>
      </div>
      <div v-for="model in store.models" :key="model.id" class="model-row modal-model-row">
        <label class="toggle"><input v-model="model.enabled" type="checkbox" /><i></i></label>
        <div class="model-fields">
          <input v-model="model.name" aria-label="配置名称" />
          <div>
            <input v-model="model.provider" aria-label="供应商" />
            <input v-model="model.model" aria-label="模型名" />
            <input v-model="model.endpoint" aria-label="接口地址" />
          </div>
        </div>
        <label class="runtime-key">
          <KeyRound :size="13" />
          <input
            v-model="store.modelApiKeys[model.id]"
            type="password"
            autocomplete="off"
            placeholder="API Key"
            @input="model.hasApiKey = Boolean(store.modelApiKeys[model.id])"
          />
        </label>
        <button class="icon-button danger" type="button" title="删除模型" @click="removeModel(model.id)"><Trash2 :size="14" /></button>
        <span :class="['model-check-state', store.modelAvailability[model.id]?.status ?? 'unknown']">
          {{ store.modelAvailability[model.id]?.reason ?? "尚未检查" }}
        </span>
      </div>
      <button class="button secondary add-model-button" type="button" @click="store.addModel()"><Plus :size="14" />增加模型</button>

      <div class="modal-section-title limit-section-title">
        <SlidersHorizontal :size="16" />
        <div><strong>计划输出限制</strong><small>默认关闭；开启后才限制步骤数、输出预算和字段长度。</small></div>
      </div>
      <div class="generation-limit-head compact">
        <div><strong>启用限制</strong><small>关闭不会影响 JSON 协议与安全校验。</small></div>
        <label class="toggle"><input v-model="store.aiGenerationSettings.limitOutput" type="checkbox" /><i></i></label>
      </div>
      <div v-if="store.aiGenerationSettings.limitOutput" class="generation-limit-grid modal-limit-grid">
        <label><span>最多步骤</span><input v-model.number="store.aiGenerationSettings.maxPlanSteps" type="number" min="1" /></label>
        <label><span>输出 tokens</span><input v-model.number="store.aiGenerationSettings.maxOutputTokens" type="number" min="256" step="256" /></label>
        <label><span>文本字符</span><input v-model.number="store.aiGenerationSettings.maxTextChars" type="number" min="1" /></label>
        <label><span>命令字符</span><input v-model.number="store.aiGenerationSettings.maxCommandChars" type="number" min="1" step="100" /></label>
      </div>

      <p class="security-hint"><Shield :size="14" />模型只能接收脱敏后的服务器上下文和执行结果，无法读取系统钥匙串中的原始凭据。</p>
      <p v-if="saveState === 'error'" class="settings-error">保存失败：{{ store.credentialError }}</p>
      <div class="modal-actions">
        <button class="button secondary" type="button" :disabled="saveState === 'saving'" @click="recheck">
          <RefreshCw :class="{ spin: saveState === 'saving' }" :size="14" />重新检查
        </button>
        <button class="button primary" type="button" :disabled="saveState === 'saving'" @click="save">
          <Save :size="14" />{{ saveState === "saving" ? "正在保存并检查…" : saveState === "saved" ? "已保存" : "保存配置" }}
        </button>
      </div>
    </div>
  </div>
</template>
