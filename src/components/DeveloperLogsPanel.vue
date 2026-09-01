<script setup lang="ts">
import { computed, ref } from "vue";
import {
  AlertTriangle,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  RotateCcw,
  Search,
} from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import type { DeveloperLogEntry } from "@/types";

const store = useOpsStore();
const { t, locale } = useI18n();
const query = ref("");
const serverFilter = ref("all");
const taskFilter = ref("all");
const operationFilter = ref("all");
const levelFilter = ref("all");
const expanded = ref<string[]>([]);
const copiedId = ref("");

const serverOptions = computed(() => {
  const options = new Map<string, string>();
  store.developerLogs.forEach((entry) => {
    if (entry.serverId) options.set(entry.serverId, entry.serverName || entry.serverId);
  });
  return [...options.entries()].map(([id, name]) => ({ id, name }));
});

const taskOptions = computed(() => {
  const options = new Map<string, { title: string; serverId?: string }>();
  store.developerLogs.forEach((entry) => {
    if (entry.taskId) options.set(entry.taskId, {
      title: entry.taskTitle || entry.taskId,
      serverId: entry.serverId,
    });
  });
  return [...options.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .filter((entry) => serverFilter.value === "all" || entry.serverId === serverFilter.value);
});

const operations = computed(() => [...new Set(store.developerLogs.map((entry) => entry.operation))].sort());
const filteredLogs = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return store.developerLogs.filter((entry) => {
    if (serverFilter.value !== "all" && entry.serverId !== serverFilter.value) return false;
    if (taskFilter.value !== "all" && entry.taskId !== taskFilter.value) return false;
    if (operationFilter.value !== "all" && entry.operation !== operationFilter.value) return false;
    if (levelFilter.value !== "all" && entry.level !== levelFilter.value) return false;
    if (!needle) return true;
    return [
      entry.title,
      entry.summary,
      entry.operation,
      entry.modelName,
      entry.endpoint,
      entry.request,
      entry.response,
      entry.trace,
      entry.error,
    ].filter(Boolean).join(" ").toLowerCase().includes(needle);
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
});

const summary = computed(() => ({
  total: filteredLogs.value.length,
  errors: filteredLogs.value.filter((entry) => entry.level === "error").length,
}));

function resetFilters() {
  query.value = "";
  serverFilter.value = "all";
  taskFilter.value = "all";
  operationFilter.value = "all";
  levelFilter.value = "all";
}

function toggle(id: string) {
  expanded.value = expanded.value.includes(id)
    ? expanded.value.filter((item) => item !== id)
    : [...expanded.value, id];
}

function formatTime(value: string) {
  return new Date(value).toLocaleString(locale.value, { hour12: false });
}

function completeLog(entry: DeveloperLogEntry) {
  return JSON.stringify(entry, null, 2);
}

async function copyLog(entry: DeveloperLogEntry) {
  await navigator.clipboard?.writeText(completeLog(entry));
  copiedId.value = entry.id;
  window.setTimeout(() => {
    if (copiedId.value === entry.id) copiedId.value = "";
  }, 1500);
}
</script>

<template>
  <section class="developer-log-panel">
    <div class="developer-log-toolbar">
      <label class="search-box"><Search :size="16" /><input v-model="query" :placeholder="t('logs.developerSearchPlaceholder')" /></label>
      <select v-model="serverFilter" :aria-label="t('logs.serverFilter')">
        <option value="all">{{ t("logs.allServers") }}</option>
        <option v-for="server in serverOptions" :key="server.id" :value="server.id">{{ server.name }}</option>
      </select>
      <select v-model="taskFilter" :aria-label="t('logs.taskFilter')">
        <option value="all">{{ t("logs.allTasks") }}</option>
        <option v-for="task in taskOptions" :key="task.id" :value="task.id">{{ task.title }}</option>
      </select>
      <select v-model="operationFilter" :aria-label="t('logs.developerOperation')">
        <option value="all">{{ t("logs.allDeveloperOperations") }}</option>
        <option v-for="operation in operations" :key="operation" :value="operation">{{ operation }}</option>
      </select>
      <select v-model="levelFilter" :aria-label="t('logs.levelFilter')">
        <option value="all">{{ t("logs.allLevels") }}</option>
        <option value="success">{{ t("logs.levels.success") }}</option>
        <option value="warning">{{ t("logs.levels.warning") }}</option>
        <option value="error">{{ t("logs.levels.error") }}</option>
      </select>
      <button class="ghost-button" type="button" @click="resetFilters"><RotateCcw :size="14" />{{ t("logs.reset") }}</button>
    </div>

    <div class="developer-log-hint">
      <Bug :size="15" />
      <span>{{ t("logs.developerPrivacyHint") }}</span>
      <strong>{{ summary.total }} {{ t("logs.records") }}</strong>
      <em v-if="summary.errors"><AlertTriangle :size="13" />{{ summary.errors }} {{ t("logs.levels.error") }}</em>
    </div>

    <div v-if="filteredLogs.length" class="developer-log-list">
      <article v-for="entry in filteredLogs" :key="entry.id" :class="['developer-log-entry', `developer-log-${entry.level}`]">
        <button class="developer-log-entry-head" type="button" :aria-expanded="expanded.includes(entry.id)" @click="toggle(entry.id)">
          <span class="developer-log-status"><Bug :size="15" /></span>
          <span class="developer-log-heading">
            <span><code>{{ entry.operation }}</code><strong>{{ entry.title }}</strong></span>
            <small>{{ entry.summary }}</small>
          </span>
          <span class="developer-log-meta">
            <small v-if="entry.modelName">{{ entry.modelName }}</small>
            <small v-if="entry.durationMs !== undefined">{{ entry.durationMs }} ms</small>
            <time>{{ formatTime(entry.createdAt) }}</time>
          </span>
          <ChevronDown v-if="expanded.includes(entry.id)" :size="16" />
          <ChevronRight v-else :size="16" />
        </button>

        <div v-if="expanded.includes(entry.id)" class="developer-log-detail">
          <div class="developer-log-identifiers">
            <span>{{ entry.id }}</span>
            <span v-if="entry.serverId">server={{ entry.serverId }}</span>
            <span v-if="entry.taskId">task={{ entry.taskId }}</span>
            <span v-if="entry.modelProfileId">profile={{ entry.modelProfileId }}</span>
            <span v-if="entry.endpoint">endpoint={{ entry.endpoint }}</span>
            <button type="button" @click.stop="copyLog(entry)">
              <Check v-if="copiedId === entry.id" :size="13" />
              <Copy v-else :size="13" />
              {{ copiedId === entry.id ? t("logs.copiedDeveloperLog") : t("logs.copyDeveloperLog") }}
            </button>
          </div>
          <section v-if="entry.request"><label>{{ t("logs.developerRequest") }}</label><pre tabindex="0">{{ entry.request }}</pre></section>
          <section v-if="entry.trace"><label>{{ t("logs.developerTrace") }}</label><pre tabindex="0">{{ entry.trace }}</pre></section>
          <section v-if="entry.response"><label>{{ t("logs.developerResponse") }}</label><pre tabindex="0">{{ entry.response }}</pre></section>
          <section v-if="entry.error"><label>{{ t("logs.developerError") }}</label><pre tabindex="0">{{ entry.error }}</pre></section>
          <section v-if="entry.stack"><label>{{ t("logs.developerStack") }}</label><pre tabindex="0">{{ entry.stack }}</pre></section>
        </div>
      </article>
    </div>
    <div v-else class="empty-list developer-log-empty">
      <Bug :size="28" /><strong>{{ t("logs.developerEmpty") }}</strong><span>{{ t("logs.developerEmptyHint") }}</span>
    </div>
  </section>
</template>
