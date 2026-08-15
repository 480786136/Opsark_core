<script setup lang="ts">
import { ref } from "vue";
import { KeyRound, Plus, Save, Shield, SlidersHorizontal, Trash2 } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import type { SecretMetadata } from "@/types";
import { useOpsStore } from "@/stores/ops";
import ToolManagementPanel from "@/features/settings/ToolManagementPanel.vue";

const store = useOpsStore();
const { t } = useI18n();
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

async function removeModel(modelId: string) {
  try {
    await store.removeModel(modelId);
  } catch {
    saveState.value = "error";
  }
}

async function saveSettings() {
  saveState.value = "saving";
  try {
    await Promise.all([store.saveModels(), store.saveSecretSettings(), store.saveTools()]);
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
      <div><span class="eyebrow">CONFIGURATION</span><h1>{{ t("settings.title") }}</h1><p>{{ t("settings.subtitle") }}</p></div>
      <button class="button primary" :disabled="saveState === 'saving'" @click="saveSettings">
        <Save :size="15" />{{ saveState === "saving" ? t("settings.saving") : saveState === "saved" ? t("settings.saved") : t("settings.save") }}
      </button>
    </header>
    <div class="settings-layout">
      <section class="settings-card">
        <div class="settings-title"><SlidersHorizontal :size="18" /><div><h2>{{ t("settings.modelTitle") }}</h2><p>{{ t("settings.modelSubtitle") }}</p></div></div>
        <div v-for="model in store.models" :key="model.id" class="model-row">
          <label class="toggle"><input v-model="model.enabled" type="checkbox" /><i></i></label>
          <div class="model-fields">
            <input v-model="model.name" :aria-label="t('settings.configName')" />
            <div><input v-model="model.provider" :aria-label="t('settings.provider')" /><input v-model="model.model" :aria-label="t('settings.modelName')" /><input v-model="model.endpoint" :aria-label="t('settings.endpoint')" /></div>
          </div>
          <label v-if="model.provider !== 'Built-in'" class="runtime-key">
            <KeyRound :size="13" />
            <input
              v-model="store.modelApiKeys[model.id]"
              type="password"
              autocomplete="off"
              :placeholder="t('settings.apiKeyPlaceholder')"
              @input="model.hasApiKey = Boolean(store.modelApiKeys[model.id])"
            />
          </label>
          <span v-else class="key-state configured"><KeyRound :size="13" />{{ t("common.builtIn") }}</span>
          <button class="icon-button danger" type="button" :title="t('settings.removeModel')" @click="removeModel(model.id)"><Trash2 :size="14" /></button>
        </div>
        <button class="button secondary" type="button" @click="store.addModel()"><Plus :size="14" />{{ t("settings.addModel") }}</button>
      </section>
      <ToolManagementPanel />
      <section class="settings-card">
        <div class="settings-title"><SlidersHorizontal :size="18" /><div><h2>{{ t("settings.limitsTitle") }}</h2><p>{{ t("settings.limitsSubtitle") }}</p></div></div>
        <div class="generation-limit-head">
          <div><strong>{{ t("settings.enableLimits") }}</strong><small>{{ t("settings.limitsHint") }}</small></div>
          <label class="toggle"><input v-model="store.aiGenerationSettings.limitOutput" type="checkbox" /><i></i></label>
        </div>
        <div v-if="store.aiGenerationSettings.limitOutput" class="generation-limit-grid">
          <label><span>{{ t("settings.maxSteps") }}</span><input v-model.number="store.aiGenerationSettings.maxPlanSteps" type="number" min="1" /></label>
          <label><span>{{ t("settings.outputTokens") }}</span><input v-model.number="store.aiGenerationSettings.maxOutputTokens" type="number" min="256" step="256" /></label>
          <label><span>{{ t("settings.textChars") }}</span><input v-model.number="store.aiGenerationSettings.maxTextChars" type="number" min="1" /></label>
          <label><span>{{ t("settings.commandChars") }}</span><input v-model.number="store.aiGenerationSettings.maxCommandChars" type="number" min="1" step="100" /></label>
        </div>
      </section>
      <p v-if="saveState === 'error'" class="security-hint">{{ t("settings.saveFailed", { reason: store.toolSaveError || store.credentialError || t("settings.invalidSettings") }) }}</p>
      <section class="settings-card">
        <div class="settings-title"><Shield :size="18" /><div><h2>{{ t("settings.secretsTitle") }}</h2><p>{{ t("settings.secretsSubtitle") }}</p></div></div>
        <div class="secret-editor-head"><span>{{ t("settings.variableName") }}</span><span>{{ t("settings.description") }}</span><span>{{ t("settings.secretValue") }}</span><span></span></div>
        <div v-for="secret in store.secretMetadata" :key="secret.key" class="secret-editor-row">
          <input :value="secret.key" :aria-label="t('settings.variableName')" autocomplete="off" @change="renameSecret(secret, $event)" />
          <input v-model="secret.description" :aria-label="t('settings.variableDescription')" autocomplete="off" />
          <input v-model="store.secretValues[secret.key]" type="text" :aria-label="t('settings.secretValue')" autocomplete="off" :placeholder="t('common.notSet')" />
          <button class="icon-button danger" type="button" :title="t('settings.removeSecret')" @click="removeSecret(secret.key)"><Trash2 :size="14" /></button>
        </div>
        <form class="add-secret-form" @submit.prevent="addSecret">
          <input v-model="newSecretKey" placeholder="VARIABLE_NAME" />
          <input v-model="newSecretDescription" :placeholder="t('settings.variableDescription')" />
          <input v-model="newSecretValue" type="text" autocomplete="off" :placeholder="t('settings.secretValue')" />
          <button class="button secondary" type="submit" :disabled="!newSecretKey"><Plus :size="14" />{{ t("common.add") }}</button>
        </form>
      </section>
      <section class="settings-card info-card">
        <Shield :size="20" /><div><h3>{{ t("settings.securityTitle") }}</h3><p>{{ t("settings.securityDescription") }}</p></div>
      </section>
    </div>
  </div>
</template>
