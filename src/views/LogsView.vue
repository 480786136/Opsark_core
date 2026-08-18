<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, RotateCcw, Search, ScrollText, Server, XCircle } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import type { AuditEvent, TaskStatus } from "@/types";

const store = useOpsStore();
const { t, locale } = useI18n();
const query = ref("");
const serverFilter = ref("all");
const taskFilter = ref("all");
const categoryFilter = ref("all");
const levelFilter = ref("all");
const selectedServerId = ref<string | null>(null);
const selectedTaskId = ref("");

watch(serverFilter, (value) => {
  if (taskFilter.value !== "all" && !taskOptions.value.some((task) => task.id === taskFilter.value)) taskFilter.value = "all";
  if (value === "all") selectedServerId.value = null;
  else if (selectedServerId.value !== value) selectedServerId.value = value;
});

type TaskGroup = { key: string; taskId?: string; title: string; status?: TaskStatus; events: AuditEvent[] };
type ServerGroup = { key: string; serverId?: string; name: string; host?: string; status?: string; events: AuditEvent[]; tasks: TaskGroup[] };

const serverOptions = computed(() => {
  const options = new Map<string, { id: string; name: string; host?: string }>();
  store.servers.forEach((server) => options.set(server.id, { id: server.id, name: server.name, host: server.host }));
  store.logs.forEach((event) => {
    if (event.serverId && !options.has(event.serverId)) options.set(event.serverId, { id: event.serverId, name: event.serverName || event.serverId });
  });
  return [...options.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
});

const taskOptions = computed(() => {
  const options = new Map<string, { id: string; title: string; serverId?: string }>();
  store.tasks.forEach((task) => options.set(task.id, { id: task.id, title: task.title, serverId: task.serverId }));
  store.logs.forEach((event) => {
    if (event.taskId && !options.has(event.taskId)) options.set(event.taskId, { id: event.taskId, title: event.taskTitle || event.taskId, serverId: event.serverId });
  });
  return [...options.values()].filter((task) => serverFilter.value === "all" || task.serverId === serverFilter.value).sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
});

const filteredLogs = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return store.logs.filter((log) => {
    if (serverFilter.value !== "all" && log.serverId !== serverFilter.value) return false;
    if (taskFilter.value !== "all" && log.taskId !== taskFilter.value) return false;
    if (categoryFilter.value !== "all" && log.category !== categoryFilter.value) return false;
    if (levelFilter.value !== "all" && log.level !== levelFilter.value) return false;
    if (!needle) return true;
    return [log.title, log.detail, log.serverName, log.taskTitle, log.serverId, log.taskId].filter(Boolean).join(" ").toLowerCase().includes(needle);
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
});

const summary = computed(() => ({
  total: filteredLogs.value.length,
  success: filteredLogs.value.filter((log) => log.level === "success").length,
  warning: filteredLogs.value.filter((log) => log.level === "warning").length,
  error: filteredLogs.value.filter((log) => log.level === "error").length,
}));

const groupedLogs = computed<ServerGroup[]>(() => {
  const servers = new Map<string, ServerGroup>();
  for (const event of filteredLogs.value) {
    const key = event.serverId || "__unassigned__";
    const server = store.servers.find((item) => item.id === event.serverId);
    let group = servers.get(key);
    if (!group) {
      group = { key, serverId: event.serverId, name: event.serverName || server?.name || t("logs.unassignedServer"), host: server?.host, status: server?.status, events: [], tasks: [] };
      servers.set(key, group);
    }
    group.events.push(event);
    const taskKey = event.taskId || "__unassigned__";
    let task = group.tasks.find((item) => item.key === taskKey);
    if (!task) {
      const currentTask = event.taskId ? store.tasks.find((item) => item.id === event.taskId) : undefined;
      task = { key: taskKey, taskId: event.taskId, title: event.taskTitle || currentTask?.title || t("logs.unassignedTask"), status: currentTask?.status, events: [] };
      group.tasks.push(task);
    }
    task.events.push(event);
  }
  return [...servers.values()];
});

const selectedServer = computed(() => groupedLogs.value.find((server) => server.key === selectedServerId.value));
const selectedTasks = computed(() => selectedServer.value?.tasks ?? []);
const selectedTask = computed(() => selectedTasks.value.find((task) => task.key === selectedTaskId.value) ?? selectedTasks.value[0]);

watch(selectedTasks, (tasks) => {
  if (!tasks.some((task) => task.key === selectedTaskId.value)) selectedTaskId.value = tasks[0]?.key ?? "";
}, { immediate: true });
watch(taskFilter, (value) => {
  if (selectedServerId.value && value !== "all") selectedTaskId.value = value;
});

function resetFilters() {
  query.value = ""; serverFilter.value = "all"; taskFilter.value = "all"; categoryFilter.value = "all"; levelFilter.value = "all";
}
function openServer(key: string) {
  if (key === "__unassigned__") return;
  selectedServerId.value = key;
  selectedTaskId.value = "";
  taskFilter.value = "all";
  serverFilter.value = key;
}
function closeServer() {
  selectedServerId.value = null;
  selectedTaskId.value = "";
  serverFilter.value = "all";
  taskFilter.value = "all";
}
function selectTask(task: TaskGroup) {
  selectedTaskId.value = task.key;
}
function formatTime(value: string) { return new Date(value).toLocaleString(locale.value, { hour12: false }); }
function levelLabel(level: AuditEvent["level"]) { return t(`logs.levels.${level}`); }
function categoryLabel(category: AuditEvent["category"]) { return t(`logs.${category}`); }
function commandContent(log: AuditEvent) {
  if (log.category !== "command" || log.detail.trimStart().startsWith("{")) return undefined;
  const [command, ...output] = log.detail.split("\n");
  return { command, output: output.join("\n") };
}
</script>

<template>
  <div class="page logs-page">
    <header class="page-header logs-header">
      <div><span class="eyebrow">AUDIT TRAIL / OPERATIONS</span><h1>{{ t("logs.title") }}</h1><p>{{ t("logs.subtitle") }}</p></div>
      <div class="log-summary" aria-label="日志统计"><span><strong>{{ summary.total }}</strong>{{ t("logs.records") }}</span><span class="summary-success"><CheckCircle2 :size="14" />{{ summary.success }}</span><span class="summary-warning"><AlertTriangle :size="14" />{{ summary.warning }}</span><span class="summary-error"><XCircle :size="14" />{{ summary.error }}</span></div>
    </header>

    <section class="log-filters">
      <label class="search-box"><Search :size="16" /><input v-model="query" :placeholder="t('logs.searchPlaceholder')" /></label>
      <select v-model="serverFilter" :aria-label="t('logs.serverFilter')"><option value="all">{{ t("logs.allServers") }}</option><option v-for="server in serverOptions" :key="server.id" :value="server.id">{{ server.name }}{{ server.host ? ` · ${server.host}` : "" }}</option></select>
      <select v-model="taskFilter" :aria-label="t('logs.taskFilter')"><option value="all">{{ t("logs.allTasks") }}</option><option v-for="task in taskOptions" :key="task.id" :value="task.id">{{ task.title }}</option></select>
      <select v-model="categoryFilter" :aria-label="t('logs.categoryFilter')"><option value="all">{{ t("logs.all") }}</option><option value="task">{{ t("logs.task") }}</option><option value="model">{{ t("logs.model") }}</option><option value="tool">{{ t("logs.tool") }}</option><option value="command">{{ t("logs.command") }}</option><option value="system">{{ t("logs.system") }}</option></select>
      <select v-model="levelFilter" :aria-label="t('logs.levelFilter')"><option value="all">{{ t("logs.allLevels") }}</option><option value="success">{{ t("logs.levels.success") }}</option><option value="info">{{ t("logs.levels.info") }}</option><option value="warning">{{ t("logs.levels.warning") }}</option><option value="error">{{ t("logs.levels.error") }}</option></select>
      <button class="ghost-button log-reset" type="button" @click="resetFilters"><RotateCcw :size="14" />{{ t("logs.reset") }}</button>
    </section>

    <Transition name="log-workspace" mode="out-in">
      <section v-if="!selectedServerId" key="overview" class="log-overview">
        <section v-if="groupedLogs.length" class="log-groups">
          <article v-for="server in groupedLogs" :key="server.key" class="log-server-group">
            <button class="log-server-summary" type="button" @click="openServer(server.key)"><span class="server-icon"><Server :size="16" /></span><span class="server-identity"><strong>{{ server.name }}</strong><small>{{ server.host || server.serverId || t("logs.localSource") }}</small></span><span class="server-state" :class="server.status || 'unknown'">{{ server.status ? t(`status.${server.status}`) : t("logs.archived") }}</span><span class="server-count">{{ server.events.length }} {{ t("logs.records") }}</span><ChevronRight :size="17" /></button>
            <div class="server-task-preview"><span v-for="task in server.tasks.slice(0, 4)" :key="task.key"><span class="task-marker"></span>{{ task.title }} <small>{{ task.events.length }}</small></span><em v-if="server.tasks.length > 4">+{{ server.tasks.length - 4 }}</em></div>
          </article>
        </section>
        <div v-else class="empty-list"><ScrollText :size="28" /><strong>{{ t("logs.empty") }}</strong><span>{{ t("logs.emptyHint") }}</span></div>
      </section>

      <section v-else :key="`server-${selectedServerId}`" class="server-log-workspace">
        <header class="server-log-toolbar">
          <button class="ghost-button" type="button" @click="closeServer"><ChevronLeft :size="15" />{{ t("logs.backToServers") }}</button>
          <div class="selected-server-heading"><span class="server-icon"><Server :size="16" /></span><div><strong>{{ selectedServer?.name || t("logs.unassignedServer") }}</strong><small>{{ selectedServer?.host || selectedServer?.serverId }}</small></div></div>
          <span class="server-count">{{ selectedServer?.events.length || 0 }} {{ t("logs.records") }}</span>
        </header>
        <div class="server-log-columns">
          <aside class="server-task-list">
            <div class="task-list-heading"><span class="eyebrow">TASKS</span><strong>{{ t("logs.taskList") }}</strong><span>{{ selectedTasks.length }}</span></div>
            <button v-for="task in selectedTasks" :key="task.key" type="button" :class="['server-task-item', { active: selectedTask?.key === task.key }]" @click="selectTask(task)"><span class="task-marker"></span><span><strong>{{ task.title }}</strong><small>{{ task.taskId || t("logs.noTaskId") }}</small></span><span class="task-item-count">{{ task.events.length }}</span></button>
            <div v-if="!selectedTasks.length" class="task-list-empty">{{ t("logs.noTaskForFilter") }}</div>
          </aside>
          <main class="task-process-panel">
            <template v-if="selectedTask">
              <header class="task-process-heading"><div><span class="eyebrow">TASK EXECUTION / TIMELINE</span><h2>{{ selectedTask.title }}</h2><p>{{ selectedTask.taskId || t("logs.noTaskId") }}<span v-if="selectedTask.status"> · {{ t(`logs.taskStatus.${selectedTask.status}`) }}</span></p></div><span class="task-count">{{ selectedTask.events.length }} {{ t("logs.events") }}</span></header>
              <div class="complete-process-list">
                <article v-for="(log, index) in selectedTask.events" :key="log.id" class="complete-process-event">
                  <div class="process-rail"><span :class="['log-level', log.level]"></span><span v-if="index < selectedTask.events.length - 1" class="process-line"></span></div>
                  <div class="process-event-card"><header><div><span class="log-category">{{ categoryLabel(log.category) }}</span><strong>{{ log.title }}</strong></div><div class="process-event-meta"><span :class="['log-level-label', log.level]">{{ levelLabel(log.level) }}</span><time>{{ formatTime(log.createdAt) }}</time></div></header><div class="process-event-identifiers"><span>{{ log.id }}</span><span v-if="log.stepId">{{ t("logs.stepId", { id: log.stepId }) }}</span><span v-if="log.executionId">{{ t("logs.executionId", { id: log.executionId }) }}</span></div><template v-if="commandContent(log)"><div class="process-output-block"><label>{{ t("logs.executionContent") }}</label><pre>{{ commandContent(log)?.command }}</pre></div><div class="process-output-block"><label>{{ t("logs.returnContent") }}</label><pre>{{ commandContent(log)?.output || t("logs.noDetail") }}</pre></div></template><pre v-else>{{ log.detail || t("logs.noDetail") }}</pre></div>
                </article>
              </div>
            </template>
            <div v-else class="empty-list task-process-empty"><ScrollText :size="28" /><strong>{{ t("logs.noTaskForFilter") }}</strong><span>{{ t("logs.noTaskForFilterHint") }}</span></div>
          </main>
        </div>
      </section>
    </Transition>
  </div>
</template>
