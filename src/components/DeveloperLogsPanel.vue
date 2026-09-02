<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertTriangle, Bug, Check, ChevronLeft, ChevronRight, Copy, RotateCcw, Search, Server } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import type { DeveloperLogEntry } from "@/types";

const store = useOpsStore();
const { t, locale } = useI18n();
const query = ref(""); const serverFilter = ref("all"); const taskFilter = ref("all");
const operationFilter = ref("all"); const levelFilter = ref("all");
const selectedServerId = ref<string | null>(null); const selectedTaskId = ref(""); const copiedId = ref("");
type TaskGroup = { key: string; taskId?: string; title: string; entries: DeveloperLogEntry[] };
type ServerGroup = { key: string; serverId?: string; name: string; host?: string; entries: DeveloperLogEntry[]; tasks: TaskGroup[] };

const serverOptions = computed(() => { const out = new Map<string, string>(); store.developerLogs.forEach(e => { if (e.serverId) out.set(e.serverId, e.serverName || e.serverId); }); return [...out].map(([id, name]) => ({ id, name })); });
const taskOptions = computed(() => { const out = new Map<string, { title: string; serverId?: string }>(); store.developerLogs.forEach(e => { if (e.taskId) out.set(e.taskId, { title: e.taskTitle || e.taskId, serverId: e.serverId }); }); return [...out].map(([id, v]) => ({ id, ...v })).filter(e => serverFilter.value === "all" || e.serverId === serverFilter.value); });
const operations = computed(() => [...new Set(store.developerLogs.map(e => e.operation))].sort());
const filteredLogs = computed(() => { const needle = query.value.trim().toLowerCase(); return store.developerLogs.filter(e => {
  if (serverFilter.value !== "all" && e.serverId !== serverFilter.value) return false;
  if (taskFilter.value !== "all" && e.taskId !== taskFilter.value) return false;
  if (operationFilter.value !== "all" && e.operation !== operationFilter.value) return false;
  if (levelFilter.value !== "all" && e.level !== levelFilter.value) return false;
  return !needle || [e.title, e.summary, e.operation, e.modelName, e.endpoint, e.request, e.response, e.trace, e.error].filter(Boolean).join(" ").toLowerCase().includes(needle);
}).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)); });
const groupedLogs = computed<ServerGroup[]>(() => { const groups = new Map<string, ServerGroup>(); filteredLogs.value.forEach(entry => {
  const key = entry.serverId || "__unassigned__"; const known = store.servers.find(s => s.id === entry.serverId); let server = groups.get(key);
  if (!server) { server = { key, serverId: entry.serverId, name: entry.serverName || known?.name || t("logs.unassignedServer"), host: known?.host, entries: [], tasks: [] }; groups.set(key, server); }
  server.entries.push(entry); const taskKey = entry.taskId || "__unassigned__"; let task = server.tasks.find(i => i.key === taskKey);
  if (!task) { task = { key: taskKey, taskId: entry.taskId, title: entry.taskTitle || t("logs.unassignedTask"), entries: [] }; server.tasks.push(task); } task.entries.push(entry);
}); return [...groups.values()]; });
const selectedServer = computed(() => groupedLogs.value.find(s => s.key === selectedServerId.value));
const selectedTasks = computed(() => selectedServer.value?.tasks ?? []);
const selectedTask = computed(() => selectedTasks.value.find(task => task.key === selectedTaskId.value) ?? selectedTasks.value[0]);
const summary = computed(() => ({ total: filteredLogs.value.length, errors: filteredLogs.value.filter(e => e.level === "error").length, tokens: filteredLogs.value.reduce((sum, e) => sum + (e.tokenUsage?.total ?? 0), 0) }));
watch(selectedTasks, tasks => { if (!tasks.some(task => task.key === selectedTaskId.value)) selectedTaskId.value = tasks[0]?.key ?? ""; }, { immediate: true });
watch(serverFilter, value => { selectedServerId.value = value === "all" ? null : value; taskFilter.value = "all"; });
function resetFilters() { query.value = ""; serverFilter.value = "all"; taskFilter.value = "all"; operationFilter.value = "all"; levelFilter.value = "all"; }
function openServer(key: string) { selectedServerId.value = key; selectedTaskId.value = ""; if (key !== "__unassigned__") serverFilter.value = key; }
function closeServer() { selectedServerId.value = null; selectedTaskId.value = ""; serverFilter.value = "all"; taskFilter.value = "all"; }
function formatTime(value: string) { return new Date(value).toLocaleString(locale.value, { hour12: false }); }
async function copyLog(entry: DeveloperLogEntry) { await navigator.clipboard?.writeText(JSON.stringify(entry, null, 2)); copiedId.value = entry.id; window.setTimeout(() => { if (copiedId.value === entry.id) copiedId.value = ""; }, 1500); }
function tokenText(entry: DeveloperLogEntry) { const u = entry.tokenUsage; return u ? `${u.source === "api" ? t("logs.tokenExact") : t("logs.tokenEstimated")} ${u.total.toLocaleString()} (${u.input.toLocaleString()} → ${u.output.toLocaleString()})` : t("logs.tokenUnavailable"); }
</script>

<template><section class="developer-log-panel">
  <div class="developer-log-toolbar">
    <label class="search-box"><Search :size="16"/><input v-model="query" :placeholder="t('logs.developerSearchPlaceholder')"/></label>
    <select v-model="serverFilter"><option value="all">{{ t("logs.allServers") }}</option><option v-for="s in serverOptions" :key="s.id" :value="s.id">{{ s.name }}</option></select>
    <select v-model="taskFilter"><option value="all">{{ t("logs.allTasks") }}</option><option v-for="task in taskOptions" :key="task.id" :value="task.id">{{ task.title }}</option></select>
    <select v-model="operationFilter"><option value="all">{{ t("logs.allDeveloperOperations") }}</option><option v-for="op in operations" :key="op" :value="op">{{ op }}</option></select>
    <select v-model="levelFilter"><option value="all">{{ t("logs.allLevels") }}</option><option value="success">{{ t("logs.levels.success") }}</option><option value="warning">{{ t("logs.levels.warning") }}</option><option value="error">{{ t("logs.levels.error") }}</option></select>
    <button class="ghost-button" type="button" @click="resetFilters"><RotateCcw :size="14"/>{{ t("logs.reset") }}</button>
  </div>
  <div class="developer-log-hint"><Bug :size="15"/><span>{{ t("logs.developerPrivacyHint") }}</span><strong>{{ summary.total }} {{ t("logs.records") }} · {{ t("logs.tokenTotal", { count: summary.tokens.toLocaleString() }) }}</strong><em v-if="summary.errors"><AlertTriangle :size="13"/>{{ summary.errors }} {{ t("logs.levels.error") }}</em></div>
  <div class="developer-log-content">
    <div v-if="!selectedServerId" key="overview" class="log-overview"><div v-if="groupedLogs.length" class="log-groups"><article v-for="server in groupedLogs" :key="server.key" class="log-server-group"><button class="log-server-summary developer-server-summary" type="button" @click="openServer(server.key)"><span class="server-icon"><Server :size="16"/></span><span class="server-identity"><strong>{{ server.name }}</strong><small>{{ server.host || server.serverId || t("logs.localSource") }}</small></span><span class="server-count">{{ server.entries.length }} {{ t("logs.records") }}</span><ChevronRight :size="17"/></button><div class="server-task-preview"><span v-for="task in server.tasks.slice(0,4)" :key="task.key"><span class="task-marker"/>{{ task.title }} <small>{{ task.entries.length }}</small></span></div></article></div><div v-else class="empty-list developer-log-empty"><Bug :size="28"/><strong>{{ t("logs.developerEmpty") }}</strong><span>{{ t("logs.developerEmptyHint") }}</span></div></div>
    <section v-else :key="selectedServerId" class="server-log-workspace developer-log-workspace"><header class="server-log-toolbar"><button class="ghost-button" type="button" @click="closeServer"><ChevronLeft :size="15"/>{{ t("logs.backToServers") }}</button><div class="selected-server-heading"><span class="server-icon"><Server :size="16"/></span><div><strong>{{ selectedServer?.name }}</strong><small>{{ selectedServer?.host || selectedServer?.serverId || t("logs.localSource") }}</small></div></div><span class="server-count">{{ selectedServer?.entries.length }} {{ t("logs.records") }}</span></header>
      <div class="server-log-columns"><aside class="server-task-list"><div class="task-list-heading"><span class="eyebrow">TASKS</span><strong>{{ t("logs.taskList") }}</strong><span>{{ selectedTasks.length }}</span></div><button v-for="task in selectedTasks" :key="task.key" type="button" :class="['server-task-item',{active:selectedTask?.key===task.key}]" @click="selectedTaskId=task.key"><span class="task-marker"/><span><strong>{{ task.title }}</strong><small>{{ task.taskId || t("logs.noTaskId") }}</small></span><span class="task-item-count">{{ task.entries.length }}</span></button></aside>
      <main class="task-process-panel"><template v-if="selectedTask"><header class="task-process-heading"><div><span class="eyebrow">DEVELOPER DIAGNOSTICS / TIMELINE</span><h2>{{ selectedTask.title }}</h2><p>{{ selectedTask.taskId || t("logs.noTaskId") }}</p></div><span class="task-count">{{ selectedTask.entries.length }} {{ t("logs.events") }}</span></header><div class="complete-process-list"><article v-for="(entry,index) in selectedTask.entries" :key="entry.id" class="complete-process-event"><div class="process-rail"><span :class="['log-level',entry.level]"/><span v-if="index<selectedTask.entries.length-1" class="process-line"/></div><div class="process-event-card developer-detail-card"><header><div><span class="log-category">{{ entry.operation }}</span><strong>{{ entry.title }}</strong></div><div class="process-event-meta"><span :class="['log-level-label',entry.level]">{{ t(`logs.levels.${entry.level}`) }}</span><time>{{ formatTime(entry.createdAt) }}</time></div></header><p class="developer-event-summary">{{ entry.summary }}</p><div class="developer-log-identifiers"><span>{{ entry.id }}</span><span v-if="entry.modelName">{{ entry.modelName }}</span><span v-if="entry.durationMs!==undefined">{{ entry.durationMs }} ms</span><span class="developer-token-usage">{{ tokenText(entry) }}</span><button type="button" @click="copyLog(entry)"><Check v-if="copiedId===entry.id" :size="13"/><Copy v-else :size="13"/>{{ copiedId===entry.id?t("logs.copiedDeveloperLog"):t("logs.copyDeveloperLog") }}</button></div><section v-if="entry.request"><label>{{ t("logs.developerRequest") }}</label><pre tabindex="0">{{ entry.request }}</pre></section><section v-if="entry.trace"><label>{{ t("logs.developerTrace") }}</label><pre tabindex="0">{{ entry.trace }}</pre></section><section v-if="entry.response"><label>{{ t("logs.developerResponse") }}</label><pre tabindex="0">{{ entry.response }}</pre></section><section v-if="entry.error"><label>{{ t("logs.developerError") }}</label><pre tabindex="0">{{ entry.error }}</pre></section><section v-if="entry.stack"><label>{{ t("logs.developerStack") }}</label><pre tabindex="0">{{ entry.stack }}</pre></section></div></article></div></template></main></div>
    </section>
  </div>
</section></template>
