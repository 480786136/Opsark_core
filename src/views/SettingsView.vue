<script setup lang="ts">
import { ref } from "vue";
import { Save, Shield, SlidersHorizontal } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
const { t } = useI18n();
const saved = ref(false);
function saveSettings() {
  store.persist(true);
  saved.value = true;
  window.setTimeout(() => { saved.value = false; }, 1800);
}
</script>

<template>
  <div class="page settings-page">
    <header class="page-header">
      <div><span class="eyebrow">CONFIGURATION</span><h1>{{ t("settings.title") }}</h1><p>{{ t("settings.subtitle") }}</p></div>
      <button class="button primary" @click="saveSettings">
        <Save :size="15" />{{ saved ? t("settings.saved") : t("settings.save") }}
      </button>
    </header>
    <div class="settings-layout">
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
      <section class="settings-card info-card">
        <Shield :size="20" /><div><h3>{{ t("settings.securityTitle") }}</h3><p>{{ t("settings.securityDescription") }}</p></div>
      </section>
    </div>
  </div>
</template>
