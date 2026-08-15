<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronDown, ChevronRight, Search, ScrollText } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";

const store = useOpsStore();
const { t, locale } = useI18n();
const query = ref("");
const category = ref("all");
const expandedLogs = ref<string[]>([]);
const filtered = computed(() => store.logs.filter((log) =>
  (category.value === "all" || log.category === category.value) &&
  (`${log.title} ${log.detail}`.toLowerCase().includes(query.value.toLowerCase()))
));

function toggleLog(id: string) {
  expandedLogs.value = expandedLogs.value.includes(id)
    ? expandedLogs.value.filter((item) => item !== id)
    : [...expandedLogs.value, id];
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div><span class="eyebrow">AUDIT TRAIL</span><h1>{{ t("logs.title") }}</h1><p>{{ t("logs.subtitle") }}</p></div>
    </header>
    <div class="filter-bar">
      <label class="search-box"><Search :size="16" /><input v-model="query" :placeholder="t('logs.searchPlaceholder')" /></label>
      <select v-model="category">
        <option value="all">{{ t("logs.all") }}</option><option value="task">{{ t("logs.task") }}</option><option value="model">{{ t("logs.model") }}</option><option value="tool">{{ t("logs.tool") }}</option><option value="command">{{ t("logs.command") }}</option><option value="system">{{ t("logs.system") }}</option>
      </select>
    </div>
    <section class="log-list">
      <article v-for="log in filtered" :key="log.id" :class="['log-row', { expanded: expandedLogs.includes(log.id) }]">
        <button class="log-row-summary" @click="toggleLog(log.id)">
          <span :class="['log-level', log.level]"></span>
          <span class="log-category">{{ t(`logs.${log.category}`) }}</span>
          <span class="log-primary"><strong>{{ log.title }}</strong><small>{{ log.detail.split('\n')[0] }}</small></span>
          <time>{{ new Date(log.createdAt).toLocaleString(locale, { hour12: false }) }}</time>
          <ChevronDown v-if="expandedLogs.includes(log.id)" :size="16" />
          <ChevronRight v-else :size="16" />
        </button>
        <div v-if="expandedLogs.includes(log.id)" class="log-detail">
          <div class="log-detail-meta">
            <span v-if="log.serverId">{{ t("logs.serverId", { id: log.serverId }) }}</span>
            <span v-if="log.taskId">{{ t("logs.taskId", { id: log.taskId }) }}</span>
          </div>
          <pre>{{ log.detail }}</pre>
        </div>
      </article>
      <div v-if="!filtered.length" class="empty-list"><ScrollText :size="28" /><strong>{{ t("logs.empty") }}</strong><span>{{ t("logs.emptyHint") }}</span></div>
    </section>
  </div>
</template>
