<script setup lang="ts">
import { ref } from "vue";
import { KeyRound, Plus, Save, Trash2 } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
const { t } = useI18n();
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");

async function saveModels() {
  saveState.value = "saving";
  try {
    await store.saveModels();
    saveState.value = "saved";
    window.setTimeout(() => { if (saveState.value === "saved") saveState.value = "idle"; }, 1800);
  } catch { saveState.value = "error"; }
}
</script>

<template>
  <div class="page management-page">
    <header class="page-header">
      <div><span class="eyebrow">MODEL CONFIGURATION</span><h1>{{ t("settings.modelTitle") }}</h1><p>{{ t("settings.modelSubtitle") }}</p></div>
      <button class="button primary" :disabled="saveState === 'saving'" @click="saveModels"><Save :size="15" />{{ saveState === "saving" ? t("settings.saving") : saveState === "saved" ? t("settings.saved") : t("common.save") }}</button>
    </header>
    <main class="management-layout">
      <p v-if="saveState === 'error'" class="security-hint">{{ t("settings.saveFailed", { reason: store.credentialError || t("settings.invalidSettings") }) }}</p>
      <section class="settings-card">
        <div v-for="model in store.models" :key="model.id" class="model-row">
          <label class="toggle"><input v-model="model.enabled" type="checkbox" /><i></i></label>
          <div class="model-fields"><input v-model="model.name" :aria-label="t('settings.configName')" /><div><input v-model="model.provider" :aria-label="t('settings.provider')" /><input v-model="model.model" :aria-label="t('settings.modelName')" /><input v-model="model.endpoint" :aria-label="t('settings.endpoint')" /></div></div>
          <label v-if="model.provider !== 'Built-in'" class="runtime-key"><KeyRound :size="13" /><input v-model="store.modelApiKeys[model.id]" type="password" autocomplete="off" :placeholder="t('settings.apiKeyPlaceholder')" @input="model.hasApiKey = Boolean(store.modelApiKeys[model.id])" /></label>
          <span v-else class="key-state configured"><KeyRound :size="13" />{{ t("common.builtIn") }}</span>
          <button class="icon-button danger" type="button" :title="t('settings.removeModel')" @click="store.removeModel(model.id)"><Trash2 :size="14" /></button>
        </div>
        <button class="button secondary" type="button" @click="store.addModel()"><Plus :size="14" />{{ t("settings.addModel") }}</button>
      </section>
    </main>
  </div>
</template>
