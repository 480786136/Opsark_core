<script setup lang="ts">
import { ref } from "vue";
import { KeyRound, Plus, RefreshCw, Save, Shield, SlidersHorizontal, Trash2, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const store = useOpsStore();
const { t } = useI18n();
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
        <div><h2>{{ t("settings.modalTitle") }}</h2><p>{{ t("settings.modalSubtitle") }}</p></div>
        <button class="icon-button" type="button" @click="emit('close')"><X :size="18" /></button>
      </div>

      <div class="modal-section-title">
        <SlidersHorizontal :size="16" />
        <div><strong>{{ t("settings.modelTitle") }}</strong><small>{{ t("settings.modelCheckHint") }}</small></div>
      </div>
      <div v-for="model in store.models" :key="model.id" class="model-row modal-model-row">
        <label class="toggle"><input v-model="model.enabled" type="checkbox" /><i></i></label>
        <div class="model-fields">
          <input v-model="model.name" :aria-label="t('settings.configName')" />
          <div>
            <input v-model="model.provider" :aria-label="t('settings.provider')" />
            <input v-model="model.model" :aria-label="t('settings.modelName')" />
            <input v-model="model.endpoint" :aria-label="t('settings.endpoint')" />
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
        <button class="icon-button danger" type="button" :title="t('settings.removeModel')" @click="removeModel(model.id)"><Trash2 :size="14" /></button>
        <span :class="['model-check-state', store.modelAvailability[model.id]?.status ?? 'unknown']">
          {{ store.modelAvailability[model.id]?.reason ?? t("settings.unchecked") }}
        </span>
      </div>
      <button class="button secondary add-model-button" type="button" @click="store.addModel()"><Plus :size="14" />{{ t("settings.addModel") }}</button>

      <div class="modal-section-title limit-section-title">
        <SlidersHorizontal :size="16" />
        <div><strong>{{ t("settings.limitsTitle") }}</strong><small>{{ t("settings.modalLimitsSubtitle") }}</small></div>
      </div>
      <div class="generation-limit-head compact">
        <div><strong>{{ t("settings.enableCompactLimits") }}</strong><small>{{ t("settings.compactLimitsHint") }}</small></div>
        <label class="toggle"><input v-model="store.aiGenerationSettings.limitOutput" type="checkbox" /><i></i></label>
      </div>
      <div v-if="store.aiGenerationSettings.limitOutput" class="generation-limit-grid modal-limit-grid">
        <label><span>{{ t("settings.compactMaxSteps") }}</span><input v-model.number="store.aiGenerationSettings.maxPlanSteps" type="number" min="1" /></label>
        <label><span>{{ t("settings.compactOutputTokens") }}</span><input v-model.number="store.aiGenerationSettings.maxOutputTokens" type="number" min="256" step="256" /></label>
        <label><span>{{ t("settings.compactTextChars") }}</span><input v-model.number="store.aiGenerationSettings.maxTextChars" type="number" min="1" /></label>
        <label><span>{{ t("settings.compactCommandChars") }}</span><input v-model.number="store.aiGenerationSettings.maxCommandChars" type="number" min="1" step="100" /></label>
      </div>

      <p class="security-hint"><Shield :size="14" />{{ t("settings.modelSecurityHint") }}</p>
      <p v-if="saveState === 'error'" class="settings-error">{{ t("settings.saveFailed", { reason: store.credentialError }) }}</p>
      <div class="modal-actions">
        <button class="button secondary" type="button" :disabled="saveState === 'saving'" @click="recheck">
          <RefreshCw :class="{ spin: saveState === 'saving' }" :size="14" />{{ t("settings.recheck") }}
        </button>
        <button class="button primary" type="button" :disabled="saveState === 'saving'" @click="save">
          <Save :size="14" />{{ saveState === "saving" ? t("settings.savingAndChecking") : saveState === "saved" ? t("settings.savedShort") : t("settings.saveConfig") }}
        </button>
      </div>
    </div>
  </div>
</template>
