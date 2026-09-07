<script setup lang="ts">
import { ref } from "vue";
import { Save } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import ToolManagementPanel from "@/features/settings/ToolManagementPanel.vue";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
const { t } = useI18n();
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");
function saveTools() {
  saveState.value = "saving";
  try {
    store.saveTools();
    saveState.value = "saved";
    window.setTimeout(() => { if (saveState.value === "saved") saveState.value = "idle"; }, 1800);
  } catch { saveState.value = "error"; }
}
</script>

<template>
  <div class="page management-page">
    <header class="page-header">
      <div><span class="eyebrow">TOOL REGISTRY</span><h1>{{ t("tools.title") }}</h1><p>{{ t("tools.subtitle") }}</p></div>
      <button class="button primary" :disabled="saveState === 'saving'" @click="saveTools"><Save :size="15" />{{ saveState === "saved" ? t("settings.saved") : t("common.save") }}</button>
    </header>
    <main class="management-layout">
      <p v-if="saveState === 'error'" class="security-hint">{{ t("settings.saveFailed", { reason: store.toolSaveError || t("settings.invalidSettings") }) }}</p>
      <ToolManagementPanel standalone />
    </main>
  </div>
</template>
