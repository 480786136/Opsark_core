<script setup lang="ts">
import { ref } from "vue";
import { Cloud } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import SkillManagementPanel from "@/features/settings/SkillManagementPanel.vue";
import SkillSyncPanel from "@/features/skills/SkillSyncPanel.vue";
import CloudSkillManager from "@/features/skills/CloudSkillManager.vue";
import { useAccountStore } from "@/features/account/accountStore";

const { t, locale } = useI18n();
const account = useAccountStore();
const cloudOpen = ref(false);
</script>

<template>
  <div class="page management-page registry-management-page">
    <header class="page-header">
      <div><span class="eyebrow">{{ locale.startsWith("zh") ? "Skill 管理" : "SKILL REGISTRY" }}</span><h1>{{ t("skills.title") }}</h1><p>{{ t("skills.subtitle") }}</p></div>
      <button v-if="account.current" class="button secondary" type="button" @click="cloudOpen = true"><Cloud :size="15"/>云同步管理</button>
    </header>
    <main class="management-layout">
      <SkillSyncPanel />
      <SkillManagementPanel standalone />
    </main>
    <CloudSkillManager v-if="account.current" :open="cloudOpen" @close="cloudOpen = false" />
  </div>
</template>
