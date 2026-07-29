<script setup lang="ts">
import { ref } from "vue";
import { KeyRound, Plus, Save, Shield, SlidersHorizontal } from "lucide-vue-next";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
const newSecretKey = ref("");
const newSecretDescription = ref("");
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");

function addSecret() {
  store.addSecretMetadata(newSecretKey.value, newSecretDescription.value);
  newSecretKey.value = "";
  newSecretDescription.value = "";
}

async function saveSettings() {
  saveState.value = "saving";
  try {
    await store.saveModels();
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
      <div><span class="eyebrow">CONFIGURATION</span><h1>模型与安全</h1><p>管理计划模型、接口和敏感变量元数据。</p></div>
      <button class="button primary" :disabled="saveState === 'saving'" @click="saveSettings">
        <Save :size="15" />{{ saveState === "saving" ? "正在保存…" : saveState === "saved" ? "已安全保存" : "保存设置" }}
      </button>
    </header>
    <div class="settings-layout">
      <section class="settings-card">
        <div class="settings-title"><SlidersHorizontal :size="18" /><div><h2>大模型配置</h2><p>首版支持 OpenAI-compatible 接口与本地演示规划器。</p></div><button class="icon-button"><Plus :size="16" /></button></div>
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
      <p v-if="saveState === 'error'" class="security-hint">保存失败：{{ store.credentialError }}</p>
      <section class="settings-card">
        <div class="settings-title"><Shield :size="18" /><div><h2>敏感信息管理</h2><p>模型只能看到变量名称和说明，无法读取真实值。</p></div></div>
        <div v-for="secret in store.secretMetadata" :key="secret.key" class="secret-row">
          <code>{{ secret.key }}</code><span>{{ secret.description }}</span>
          <strong>{{ store.secretValues[secret.key] ? "本次会话已设置" : "未设置" }}</strong>
        </div>
        <form class="add-secret-form" @submit.prevent="addSecret">
          <input v-model="newSecretKey" placeholder="VARIABLE_NAME" />
          <input v-model="newSecretDescription" placeholder="变量说明" />
          <button class="button secondary" type="submit" :disabled="!newSecretKey"><Plus :size="14" />添加</button>
        </form>
      </section>
      <section class="settings-card info-card">
        <Shield :size="20" /><div><h3>首版安全边界</h3><p>当前执行器仅直接运行白名单诊断命令；其他命令使用可验证的演示输出。接入真实 SSH 前，请启用系统钥匙串和命令策略审计。</p></div>
      </section>
    </div>
  </div>
</template>
