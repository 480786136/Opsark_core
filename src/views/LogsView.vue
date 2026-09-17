<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { AlertTriangle, Bug, CheckCircle2, ChevronLeft, ChevronRight, RotateCcw, Search, ScrollText, Server, ShieldCheck, XCircle } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import type { AuditEvent, TaskStatus } from "@/types";
import { backend } from "@/services/backend";
import DeveloperLogsPanel from "@/components/DeveloperLogsPanel.vue";
import ParameterSelect from "@/components/ParameterSelect.vue";
import { isInternalPlanDiagnostic, localizeCoreText } from "@/features/preferences/coreText";

const store = useOpsStore();
const { t, locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const logMode = ref<"audit" | "developer">("audit");
const query = ref("");
const serverFilter = ref("all");
const taskFilter = ref("all");
const categoryFilter = ref("all");
const levelFilter = ref("all");
const fromFilter = ref("");
const toFilter = ref("");
const selectedServerId = ref<string | null>(null);
const selectedTaskId = ref("");
const persistedLogs = ref<AuditEvent[]>([]);
const historyCursor = ref<string>();
const historyHasMore = ref(false);
const historyTotal = ref(0);
const historyMalformedLines = ref(0);
const historyOversizedLines = ref(0);
const historyInvalidRecords = ref(0);
const historyLoading = ref(false);
const historyAvailable = ref(false);
const historyError = ref("");
const debouncedQuery = ref("");
const HISTORY_PAGE_SIZE = 100;
let historyRequestVersion = 0;
let searchTimer: number | undefined;
let historyResetQueued = false;
let historyUnmounted = false;

watch(query, (value) => {
  window.clearTimeout(searchTimer);
  if (!value.trim()) {
    debouncedQuery.value = "";
    return;
  }
  searchTimer = window.setTimeout(() => {
    debouncedQuery.value = value.trim();
  }, 300);
});

onBeforeUnmount(() => {
  window.clearTimeout(searchTimer);
  historyUnmounted = true;
  historyResetQueued = false;
  historyRequestVersion += 1;
});

function matchesCurrentFilters(log: AuditEvent, search = query.value.trim()) {
  if (serverFilter.value !== "all" && log.serverId !== serverFilter.value) return false;
  if (taskFilter.value !== "all" && log.taskId !== taskFilter.value) return false;
  if (categoryFilter.value !== "all" && log.category !== categoryFilter.value) return false;
  if (levelFilter.value !== "all" && log.level !== levelFilter.value) return false;
  const createdAt = Date.parse(log.createdAt);
  const from = dateBoundaryIso(fromFilter.value, false);
  const to = dateBoundaryIso(toFilter.value, true);
  if (from && (!Number.isFinite(createdAt) || createdAt < Date.parse(from))) return false;
  if (to && (!Number.isFinite(createdAt) || createdAt > Date.parse(to))) return false;
  const needle = search.toLowerCase();
  if (!needle) return true;
  // Keep the client-side safety filter aligned with the Rust query, which
  // searches the complete structured record (including correlation IDs).
  return JSON.stringify(log).toLowerCase().includes(needle);
}

function dateBoundaryIso(value: string, endOfDay: boolean) {
  if (!value) return undefined;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isAuditEvent(value: unknown): value is AuditEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<AuditEvent>;
  return typeof event.id === "string"
    && ["task", "model", "command", "tool", "system"].includes(event.category ?? "")
    && ["info", "warning", "error", "success"].includes(event.level ?? "")
    && typeof event.title === "string"
    && typeof event.detail === "string"
    && typeof event.createdAt === "string";
}

function mergeById(current: AuditEvent[], incoming: AuditEvent[]) {
  const events = new Map(current.map((event) => [event.id, event]));
  incoming.forEach((event) => events.set(event.id, event));
  return [...events.values()];
}

async function loadPersistedLogs(reset: boolean) {
  // A filtered JSONL lookup may scan a sizeable archive. Keep at most one
  // scan in flight and coalesce rapid filter changes into the latest reset.
  if (historyLoading.value) {
    if (reset) {
      historyResetQueued = true;
      historyRequestVersion += 1;
    }
    return;
  }
  const requestVersion = reset ? ++historyRequestVersion : historyRequestVersion;
  const cursor = reset ? undefined : historyCursor.value;
  if (reset) {
    persistedLogs.value = [];
    historyAvailable.value = false;
    historyCursor.value = undefined;
    historyHasMore.value = false;
    historyTotal.value = 0;
    historyMalformedLines.value = 0;
    historyOversizedLines.value = 0;
    historyInvalidRecords.value = 0;
    historyError.value = "";
  }
  historyLoading.value = true;
  try {
    const result = await backend.queryTaskLogs<AuditEvent>({
      stream: "events",
      cursor,
      limit: HISTORY_PAGE_SIZE,
      taskId: taskFilter.value === "all" ? undefined : taskFilter.value,
      serverId: serverFilter.value === "all" ? undefined : serverFilter.value,
      category: categoryFilter.value === "all" ? undefined : categoryFilter.value,
      level: levelFilter.value === "all" ? undefined : levelFilter.value,
      search: debouncedQuery.value || undefined,
      from: dateBoundaryIso(fromFilter.value, false),
      to: dateBoundaryIso(toFilter.value, true),
    });
    if (requestVersion !== historyRequestVersion) return;
    if (!result) {
      historyAvailable.value = false;
      return;
    }
    historyAvailable.value = true;
    // The backend applies the same filters. Re-check here so a legacy backend,
    // or a record whose shape predates an indexed field, cannot leak into a view.
    const validItems = result.items.filter(isAuditEvent);
    historyInvalidRecords.value += result.items.length - validItems.length;
    const items = validItems.filter((event) => matchesCurrentFilters(event, debouncedQuery.value));
    persistedLogs.value = reset ? mergeById([], items) : mergeById(persistedLogs.value, items);
    historyCursor.value = result.nextCursor;
    historyHasMore.value = result.hasMore;
    historyTotal.value = result.total;
    // These are totals for the whole filtered scan, not per-page counters.
    historyMalformedLines.value = result.malformedLines;
    historyOversizedLines.value = result.oversizedLines;
    historyError.value = "";
  } catch (error) {
    if (requestVersion !== historyRequestVersion) return;
    if (reset) historyAvailable.value = false;
    historyError.value = error instanceof Error ? error.message : String(error);
  } finally {
    historyLoading.value = false;
    if (historyResetQueued && !historyUnmounted) {
      historyResetQueued = false;
      void loadPersistedLogs(true);
    }
  }
}

watch(
  [serverFilter, taskFilter, categoryFilter, levelFilter, fromFilter, toFilter, debouncedQuery],
  () => void loadPersistedLogs(true),
  { immediate: true },
);

watch(serverFilter, (value) => {
  if (taskFilter.value !== "all" && !taskOptions.value.some((task) => task.id === taskFilter.value)) taskFilter.value = "all";
  if (value === "all") selectedServerId.value = null;
  else if (selectedServerId.value !== value) selectedServerId.value = value;
});

type TaskGroup = {
  key: string;
  taskId?: string;
  title: string;
  scope: "task" | "server" | "unassigned";
  status?: TaskStatus;
  events: AuditEvent[];
};
type ServerGroup = { key: string; serverId?: string; name: string; host?: string; status?: string; events: AuditEvent[]; tasks: TaskGroup[] };

const serverOptions = computed(() => {
  const options = new Map<string, { id: string; name: string; host?: string }>();
  store.servers.forEach((server) => options.set(server.id, { id: server.id, name: server.name, host: server.host }));
  allLogs.value.forEach((event) => {
    if (event.serverId && !options.has(event.serverId)) options.set(event.serverId, { id: event.serverId, name: event.serverName || event.serverId });
  });
  return [...options.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
});

const taskOptions = computed(() => {
  const options = new Map<string, { id: string; title: string; serverId?: string }>();
  store.tasks.forEach((task) => options.set(task.id, { id: task.id, title: task.title, serverId: task.serverId }));
  allLogs.value.forEach((event) => {
    if (event.taskId && !options.has(event.taskId)) options.set(event.taskId, { id: event.taskId, title: event.taskTitle || event.taskId, serverId: event.serverId });
  });
  return [...options.values()].filter((task) => serverFilter.value === "all" || task.serverId === serverFilter.value).sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
});
const serverFilterOptions = computed(() => [
  { value: "all", label: t("logs.allServers") },
  ...serverOptions.value.map((server) => ({ value: server.id, label: `${server.name}${server.host ? ` · ${server.host}` : ""}` })),
]);
const taskFilterOptions = computed(() => [
  { value: "all", label: t("logs.allTasks") },
  ...taskOptions.value.map((task) => ({ value: task.id, label: task.title })),
]);
const categoryFilterOptions = computed(() => [
  { value: "all", label: t("logs.all") },
  ...(["task", "model", "tool", "command", "system"] as const).map((category) => ({ value: category, label: t(`logs.${category}`) })),
]);
const levelFilterOptions = computed(() => [
  { value: "all", label: t("logs.allLevels") },
  ...(["success", "info", "warning", "error"] as const).map((level) => ({ value: level, label: t(`logs.levels.${level}`) })),
]);

const allLogs = computed(() => {
  // The store wins on duplicate IDs because it may contain a newer live snapshot.
  return mergeById(persistedLogs.value, store.logs);
});

const filteredLogs = computed(() => allLogs.value
  .filter((log) => matchesCurrentFilters(log))
  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));

const historyStatusVisible = computed(() => historyLoading.value || historyAvailable.value || Boolean(historyError.value));
const historyProgress = computed(() => locale.value.startsWith("zh")
  ? `已从磁盘加载 ${persistedLogs.value.length} / ${historyTotal.value} 条`
  : `Loaded ${persistedLogs.value.length} / ${historyTotal.value} from disk`);
const historyWarning = computed(() => {
  const malformed = historyMalformedLines.value;
  const oversized = historyOversizedLines.value;
  const invalid = historyInvalidRecords.value;
  if (!malformed && !oversized && !invalid) return "";
  if (locale.value.startsWith("zh")) return `已跳过 ${malformed} 条损坏日志、${oversized} 条超大日志、${invalid} 条结构无效记录`;
  return `Skipped ${malformed} malformed, ${oversized} oversized, and ${invalid} schema-invalid records`;
});
const loadingLabel = computed(() => locale.value.startsWith("zh") ? "正在读取磁盘日志…" : "Reading logs from disk…");
const loadMoreLabel = computed(() => locale.value.startsWith("zh") ? "加载更多" : "Load more");
const retryLabel = computed(() => locale.value.startsWith("zh") ? "重试" : "Retry");
const failureLabel = computed(() => locale.value.startsWith("zh") ? "历史日志加载失败" : "Failed to load log history");

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
    const scope: TaskGroup["scope"] = event.taskId ? "task" : event.serverId ? "server" : "unassigned";
    const taskKey = event.taskId || (scope === "server" ? "__server_events__" : "__unassigned__");
    let task = group.tasks.find((item) => item.key === taskKey);
    if (!task) {
      const currentTask = event.taskId ? store.tasks.find((item) => item.id === event.taskId) : undefined;
      task = {
        key: taskKey,
        taskId: event.taskId,
        title: event.taskTitle || currentTask?.title || (scope === "server" ? t("logs.serverEvents") : t("logs.unassignedTask")),
        scope,
        status: currentTask?.status,
        events: [],
      };
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
  query.value = ""; serverFilter.value = "all"; taskFilter.value = "all"; categoryFilter.value = "all"; levelFilter.value = "all"; fromFilter.value = ""; toFilter.value = "";
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
function auditText(value: string) { return localizeCoreText(value, locale.value); }
function auditDetail(log: AuditEvent) {
  return isInternalPlanDiagnostic(log.title)
    ? localizeCoreText(log.title, locale.value)
    : localizeCoreText(log.detail, locale.value);
}
function commandContent(log: AuditEvent) {
  if (log.category !== "command" || log.detail.trimStart().startsWith("{")) return undefined;
  const [command, ...output] = log.detail.split("\n");
  return { command, output: output.join("\n") };
}
</script>

<template>
  <div class="page logs-page">
    <header class="page-header logs-header">
      <div><span class="eyebrow">{{ zh ? "审计轨迹 / 开发者诊断" : "AUDIT TRAIL / DEVELOPER DIAGNOSTICS" }}</span><h1>{{ logMode === "audit" ? t("logs.title") : t("logs.developerTitle") }}</h1><p>{{ logMode === "audit" ? t("logs.subtitle") : t("logs.developerSubtitle") }}</p></div>
      <div class="log-header-actions">
        <div class="log-mode-tabs" :aria-label="t('logs.logMode')">
          <button type="button" :class="{ active: logMode === 'audit' }" @click="logMode = 'audit'"><ShieldCheck :size="14" />{{ t("logs.auditMode") }}</button>
          <button type="button" :class="{ active: logMode === 'developer' }" @click="logMode = 'developer'"><Bug :size="14" />{{ t("logs.developerMode") }}</button>
        </div>
        <div v-if="logMode === 'audit'" class="log-summary" :aria-label="locale.startsWith('zh') ? '日志统计' : 'Log summary'"><span><strong>{{ summary.total }}</strong>{{ t("logs.records") }}</span><span class="summary-success"><CheckCircle2 :size="14" />{{ summary.success }}</span><span class="summary-warning"><AlertTriangle :size="14" />{{ summary.warning }}</span><span class="summary-error"><XCircle :size="14" />{{ summary.error }}</span></div>
      </div>
    </header>

    <DeveloperLogsPanel v-if="logMode === 'developer'" />

    <template v-else>
      <section class="log-filters">
      <label class="search-box"><Search :size="16" /><input v-model="query" :placeholder="t('logs.searchPlaceholder')" /></label>
      <ParameterSelect v-model="serverFilter" class="log-filter-select" size="small" :options="serverFilterOptions" :ariaLabel="t('logs.serverFilter')" />
      <ParameterSelect v-model="taskFilter" class="log-filter-select" size="small" :options="taskFilterOptions" :ariaLabel="t('logs.taskFilter')" />
      <ParameterSelect v-model="categoryFilter" class="log-filter-select" size="small" :options="categoryFilterOptions" :ariaLabel="t('logs.categoryFilter')" />
      <ParameterSelect v-model="levelFilter" class="log-filter-select" size="small" :options="levelFilterOptions" :ariaLabel="t('logs.levelFilter')" />
      <label class="log-date-filter"><span>{{ locale.startsWith("zh") ? "开始" : "From" }}</span><input v-model="fromFilter" type="date" :aria-label="locale.startsWith('zh') ? '开始日期' : 'From date'" /></label>
      <label class="log-date-filter"><span>{{ locale.startsWith("zh") ? "结束" : "To" }}</span><input v-model="toFilter" type="date" :aria-label="locale.startsWith('zh') ? '结束日期' : 'To date'" /></label>
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
            <div class="task-list-heading"><span class="eyebrow">{{ zh ? "任务" : "TASKS" }}</span><strong>{{ t("logs.taskList") }}</strong><span>{{ selectedTasks.length }}</span></div>
            <button v-for="task in selectedTasks" :key="task.key" type="button" :class="['server-task-item', { active: selectedTask?.key === task.key }]" @click="selectTask(task)"><span class="task-marker"></span><span><strong>{{ task.title }}</strong><small>{{ task.taskId || (task.scope === "server" ? t("logs.serverScope") : t("logs.noTaskId")) }}</small></span><span class="task-item-count">{{ task.events.length }}</span></button>
            <div v-if="!selectedTasks.length" class="task-list-empty">{{ t("logs.noTaskForFilter") }}</div>
          </aside>
          <main class="task-process-panel">
            <template v-if="selectedTask">
              <header class="task-process-heading"><div><span class="eyebrow">{{ selectedTask.scope === "server" ? (zh ? "服务器 / 系统时间线" : "SERVER / SYSTEM TIMELINE") : (zh ? "任务执行 / 时间线" : "TASK EXECUTION / TIMELINE") }}</span><h2>{{ selectedTask.title }}</h2><p>{{ selectedTask.taskId || (selectedTask.scope === "server" ? t("logs.serverScope") : t("logs.noTaskId")) }}<span v-if="selectedTask.status"> · {{ t(`logs.taskStatus.${selectedTask.status}`) }}</span></p></div><span class="task-count">{{ selectedTask.events.length }} {{ t("logs.events") }}</span></header>
              <div class="complete-process-list">
                <article v-for="(log, index) in selectedTask.events" :key="log.id" class="complete-process-event">
                  <div class="process-rail"><span :class="['log-level', log.level]"></span><span v-if="index < selectedTask.events.length - 1" class="process-line"></span></div>
                  <div class="process-event-card"><header><div><span class="log-category">{{ categoryLabel(log.category) }}</span><strong>{{ auditText(log.title) }}</strong></div><div class="process-event-meta"><span :class="['log-level-label', log.level]">{{ levelLabel(log.level) }}</span><time>{{ formatTime(log.createdAt) }}</time></div></header><div class="process-event-identifiers"><span>{{ log.id }}</span><span v-if="log.stepId">{{ t("logs.stepId", { id: log.stepId }) }}</span><span v-if="log.executionId">{{ t("logs.executionId", { id: log.executionId }) }}</span></div><template v-if="commandContent(log)"><div class="process-output-block"><label>{{ t("logs.executionContent") }}</label><pre>{{ commandContent(log)?.command }}</pre></div><div class="process-output-block"><label>{{ t("logs.returnContent") }}</label><pre>{{ commandContent(log)?.output || t("logs.noDetail") }}</pre></div></template><pre v-else>{{ auditDetail(log) || t("logs.noDetail") }}</pre></div>
                </article>
              </div>
            </template>
            <div v-else class="empty-list task-process-empty"><ScrollText :size="28" /><strong>{{ t("logs.noTaskForFilter") }}</strong><span>{{ t("logs.noTaskForFilterHint") }}</span></div>
          </main>
        </div>
      </section>
      </Transition>

      <div v-if="historyStatusVisible" class="audit-log-history-status" aria-live="polite">
        <div class="audit-log-history-copy">
          <span v-if="historyAvailable">{{ historyProgress }}</span>
          <span v-if="historyLoading" class="audit-log-loading">{{ loadingLabel }}</span>
          <span v-if="historyWarning" class="audit-log-history-warning"><AlertTriangle :size="13" />{{ historyWarning }}</span>
          <span v-if="historyError" class="audit-log-history-error" role="alert"><XCircle :size="13" />{{ failureLabel }}：{{ historyError }}</span>
        </div>
        <button v-if="historyError" class="ghost-button audit-log-retry" type="button" :disabled="historyLoading" @click="loadPersistedLogs(true)">{{ retryLabel }}</button>
        <button v-else-if="historyAvailable && historyHasMore" class="ghost-button audit-log-load-more" type="button" :disabled="historyLoading" @click="loadPersistedLogs(false)">{{ historyLoading ? loadingLabel : loadMoreLabel }}</button>
      </div>
    </template>
  </div>
</template>
