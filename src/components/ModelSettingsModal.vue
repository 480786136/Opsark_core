<script setup lang="ts">
import { ref } from "vue";
import { KeyRound, RefreshCw, Save, Shield, SlidersHorizontal, X } from "lucide-vue-next";
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
        <span :class="['model-check-state', store.modelAvailability[model.id]?.status ?? 'unknown']">
          {{ store.modelAvailability[model.id]?.reason ?? "尚未检查" }}
        </span>
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
