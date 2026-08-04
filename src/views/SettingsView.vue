<script setup lang="ts">
import { ref } from "vue";
import { KeyRound, Plus, Save, Shield, SlidersHorizontal, Trash2 } from "lucide-vue-next";
import type { SecretMetadata } from "@/types";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
const newSecretKey = ref("");
const newSecretDescription = ref("");
const newSecretValue = ref("");
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");

function addSecret() {
  store.addSecretMetadata(newSecretKey.value, newSecretDescription.value, newSecretValue.value);
  newSecretKey.value = "";
  newSecretDescription.value = "";
  newSecretValue.value = "";
}

async function renameSecret(secret: SecretMetadata, event: Event) {
  const input = event.target as HTMLInputElement;
  try {
    const renamed = await store.renameSecretMetadata(secret.key, input.value);
    if (!renamed) input.value = secret.key;
  } catch {
    input.value = secret.key;
    saveState.value = "error";
  }
}

async function removeSecret(key: string) {
  try {
    await store.removeSecretMetadata(key);
  } catch {
    saveState.value = "error";
  }
}

async function saveSettings() {
  saveState.value = "saving";
  try {
    await Promise.all([store.saveModels(), store.saveSecretSettings()]);
    saveState.value = "saved";
    window.setTimeout(() => {
      if (saveState.value === "saved") saveState.value = "idle";
    }, 1800);
  } catch {
    saveState.value = "error";
  }
}
</script>

<template>
  <div class="page settings-page">
    <header class="page-header">
      <div><span class="eyebrow">CONFIGURATION</span><h1>模型与安全</h1><p>管理计划模型、接口和系统钥匙串中的敏感变量。</p></div>
      <button class="button primary" :disabled="saveState === 'saving'" @click="saveSettings">
        <Save :size="15" />{{ saveState === "saving" ? "正在保存…" : saveState === "saved" ? "已安全保存" : "保存设置" }}
      </button>
    </header>
    <div class="settings-layout">
      <section class="settings-card">
        <div class="settings-title"><SlidersHorizontal :size="18" /><div><h2>大模型配置</h2><p>支持 OpenAI-compatible 远程模型接口，保存后自动检查可用性。</p></div></div>
        <div v-for="model in store.models" :key="model.id" class="model-row">
          <label class="toggle"><input v-model="model.enabled" type="checkbox" /><i></i></label>
          <div class="model-fields">
            <input v-model="model.name" aria-label="配置名称" />
            <div><input v-model="model.model" aria-label="模型名" /><input v-model="model.endpoint" aria-label="接口地址" /></div>
          </div>
          <label v-if="model.provider !== 'Built-in'" class="runtime-key">
            <KeyRound :size="13" />
            <input
              v-model="store.modelApiKeys[model.id]"
              type="password"
              autocomplete="off"
              placeholder="API Key（保存到系统钥匙串）"
              @input="model.hasApiKey = Boolean(store.modelApiKeys[model.id])"
            />
          </label>
          <span v-else class="key-state configured"><KeyRound :size="13" />内置</span>
        </div>
      </section>
      <section class="settings-card">
        <div class="settings-title"><SlidersHorizontal :size="18" /><div><h2>计划输出限制</h2><p>默认不限制步骤数、输出预算和字段长度；仅在需要控制模型成本或响应体积时开启。</p></div></div>
        <div class="generation-limit-head">
          <div><strong>启用计划输出限制</strong><small>关闭时仍会校验 JSON 结构、必填字段、风险等级和安全规则。</small></div>
          <label class="toggle"><input v-model="store.aiGenerationSettings.limitOutput" type="checkbox" /><i></i></label>
        </div>
        <div v-if="store.aiGenerationSettings.limitOutput" class="generation-limit-grid">
          <label><span>最多计划步骤</span><input v-model.number="store.aiGenerationSettings.maxPlanSteps" type="number" min="1" /></label>
          <label><span>模型输出预算（tokens）</span><input v-model.number="store.aiGenerationSettings.maxOutputTokens" type="number" min="256" step="256" /></label>
          <label><span>文本字段上限（字符）</span><input v-model.number="store.aiGenerationSettings.maxTextChars" type="number" min="1" /></label>
          <label><span>命令字段上限（字符）</span><input v-model.number="store.aiGenerationSettings.maxCommandChars" type="number" min="1" step="100" /></label>
        </div>
      </section>
      <p v-if="saveState === 'error'" class="security-hint">保存失败：{{ store.credentialError }}</p>
      <section class="settings-card">
        <div class="settings-title"><Shield :size="18" /><div><h2>敏感信息管理</h2><p>可直接增删改并查看真实值；真实值只保存到系统钥匙串，不会发送给模型。</p></div></div>
        <div class="secret-editor-head"><span>变量名</span><span>说明</span><span>真实值</span><span></span></div>
        <div v-for="secret in store.secretMetadata" :key="secret.key" class="secret-editor-row">
          <input :value="secret.key" aria-label="变量名" autocomplete="off" @change="renameSecret(secret, $event)" />
          <input v-model="secret.description" aria-label="变量说明" autocomplete="off" />
          <input v-model="store.secretValues[secret.key]" type="text" aria-label="真实值" autocomplete="off" placeholder="未设置" />
          <button class="icon-button danger" type="button" title="删除敏感变量" @click="removeSecret(secret.key)"><Trash2 :size="14" /></button>
        </div>
        <form class="add-secret-form" @submit.prevent="addSecret">
          <input v-model="newSecretKey" placeholder="VARIABLE_NAME" />
          <input v-model="newSecretDescription" placeholder="变量说明" />
          <input v-model="newSecretValue" type="text" autocomplete="off" placeholder="真实值" />
          <button class="button secondary" type="submit" :disabled="!newSecretKey"><Plus :size="14" />添加</button>
        </form>
      </section>
      <section class="settings-card info-card">
        <Shield :size="20" /><div><h3>首版安全边界</h3><p>当前执行器仅直接运行白名单诊断命令；其他命令使用可验证的演示输出。接入真实 SSH 前，请启用系统钥匙串和命令策略审计。</p></div>
      </section>
    </div>
  </div>
</template>
