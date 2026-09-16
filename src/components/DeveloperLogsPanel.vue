<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AlertTriangle, Bug, Check, ChevronLeft, ChevronRight, Copy, RotateCcw, Search, Server } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import { backend } from "@/services/backend";
import type { DeveloperLogEntry } from "@/types";
import ModelTransportLogsPanel from "@/components/ModelTransportLogsPanel.vue";
import ParameterSelect from "@/components/ParameterSelect.vue";

const store = useOpsStore();
const { t, locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const logSource = ref<"diagnostic" | "transport">("diagnostic");
const query = ref(""); const serverFilter = ref("all"); const taskFilter = ref("all");
const operationFilter = ref("all"); const levelFilter = ref("all");
const fromFilter = ref(""); const toFilter = ref("");
const selectedServerId = ref<string | null>(null); const selectedTaskId = ref(""); const copiedId = ref("");
const diskLogs = ref<DeveloperLogEntry[]>([]); const diskState = ref<"unknown" | "available" | "unavailable">("unknown");
const diskLoading = ref(false); const diskError = ref(""); const diskTotal = ref(0);
const diskResetPending = ref(false);
const diskCursor = ref<string>(); const diskHasMore = ref(false);
const malformedLines = ref(0); const oversizedLines = ref(0); const invalidRecords = ref(0);
const DISK_PAGE_SIZE = 100; const QUERY_DEBOUNCE_MS = 180;
let reloadTimer: number | undefined; let queryVersion = 0; let reloadQueued = false; let unmounted = false;
let requestSequence = 0; let activeRequestId = 0;
type TaskGroup = { key: string; taskId?: string; title: string; entries: DeveloperLogEntry[] };
type ServerGroup = { key: string; serverId?: string; name: string; host?: string; entries: DeveloperLogEntry[]; tasks: TaskGroup[] };

function mergeLogEntries(...groups: DeveloperLogEntry[][]) {
  const merged = new Map<string, DeveloperLogEntry>();
  groups.forEach(entries => entries.forEach(entry => merged.set(entry.id, entry)));
  return [...merged.values()];
}

function dateBoundaryIso(value: string, endOfDay: boolean) {
  if (!value) return undefined;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeDeveloperLogEntry(value: unknown): DeveloperLogEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const level = record.level;
  if (typeof record.id !== "string" || !record.id
    || typeof level !== "string"
    || !["info", "warning", "error", "success"].includes(level)
    || typeof record.operation !== "string"
    || typeof record.title !== "string"
    || typeof record.summary !== "string"
    || typeof record.createdAt !== "string"
    || !Number.isFinite(Date.parse(record.createdAt))) return undefined;
  const entry: DeveloperLogEntry = {
    id: record.id,
    level: level as DeveloperLogEntry["level"],
    operation: record.operation,
    title: record.title,
    summary: record.summary,
    createdAt: record.createdAt,
  };
  for (const field of ["request", "response", "trace", "error", "stack", "serverId", "serverName", "taskId", "taskTitle", "modelProfileId", "modelName", "endpoint"] as const) {
    if (typeof record[field] === "string") Object.assign(entry, { [field]: record[field] });
  }
  if (typeof record.durationMs === "number" && Number.isFinite(record.durationMs)) entry.durationMs = record.durationMs;
  const usage = record.tokenUsage;
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    const item = usage as Record<string, unknown>;
    if (typeof item.input === "number" && Number.isFinite(item.input)
      && typeof item.output === "number" && Number.isFinite(item.output)
      && typeof item.total === "number" && Number.isFinite(item.total)
      && (item.source === "api" || item.source === "estimated")) {
      entry.tokenUsage = { input: item.input, output: item.output, total: item.total, source: item.source };
    }
  }
  return entry;
}

const allLogs = computed(() => mergeLogEntries(diskLogs.value, store.developerLogs));
const serverOptions = computed(() => { const out = new Map<string, string>(); allLogs.value.forEach(e => { if (e.serverId) out.set(e.serverId, e.serverName || e.serverId); }); return [...out].map(([id, name]) => ({ id, name })); });
const taskOptions = computed(() => { const out = new Map<string, { title: string; serverId?: string }>(); allLogs.value.forEach(e => { if (e.taskId) out.set(e.taskId, { title: e.taskTitle || e.taskId, serverId: e.serverId }); }); return [...out].map(([id, v]) => ({ id, ...v })).filter(e => serverFilter.value === "all" || e.serverId === serverFilter.value); });
const operations = computed(() => [...new Set(allLogs.value.map(e => e.operation))].sort());
const serverFilterOptions = computed(() => [
  { value: "all", label: t("logs.allServers") },
  ...serverOptions.value.map((server) => ({ value: server.id, label: server.name })),
]);
const taskFilterOptions = computed(() => [
  { value: "all", label: t("logs.allTasks") },
  ...taskOptions.value.map((task) => ({ value: task.id, label: task.title })),
]);
const operationFilterOptions = computed(() => [
  { value: "all", label: t("logs.allDeveloperOperations") },
  ...operations.value.map((operation) => ({ value: operation, label: operation })),
]);
const levelFilterOptions = computed(() => [
  { value: "all", label: t("logs.allLevels") },
  ...(["success", "info", "warning", "error"] as const).map((level) => ({ value: level, label: t(`logs.levels.${level}`) })),
]);
const filteredLogs = computed(() => { const needle = query.value.trim().toLowerCase(); return allLogs.value.filter(e => {
  if (serverFilter.value !== "all" && e.serverId !== serverFilter.value) return false;
  if (taskFilter.value !== "all" && e.taskId !== taskFilter.value) return false;
  if (operationFilter.value !== "all" && e.operation !== operationFilter.value) return false;
  if (levelFilter.value !== "all" && e.level !== levelFilter.value) return false;
  const createdAt = Date.parse(e.createdAt);
  const from = dateBoundaryIso(fromFilter.value, false);
  const to = dateBoundaryIso(toFilter.value, true);
  if (from && (!Number.isFinite(createdAt) || createdAt < Date.parse(from))) return false;
  if (to && (!Number.isFinite(createdAt) || createdAt > Date.parse(to))) return false;
  // Rust searches the complete structured record; mirror that behavior here
  // so client-side validation cannot discard a legitimate disk match.
  return !needle || JSON.stringify(e).toLowerCase().includes(needle);
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
const skippedLines = computed(() => malformedLines.value + oversizedLines.value + invalidRecords.value);
watch(selectedTasks, tasks => { if (!tasks.some(task => task.key === selectedTaskId.value)) selectedTaskId.value = tasks[0]?.key ?? ""; }, { immediate: true });
watch(serverFilter, value => { selectedServerId.value = value === "all" ? null : value; taskFilter.value = "all"; });
watch([query, serverFilter, taskFilter, operationFilter, levelFilter, fromFilter, toFilter], () => scheduleDiskReload(), { flush: "sync" });

function diskQuery(cursor?: string) {
  return {
    stream: "developer-events" as const,
    cursor,
    limit: DISK_PAGE_SIZE,
    serverId: serverFilter.value === "all" ? undefined : serverFilter.value,
    taskId: taskFilter.value === "all" ? undefined : taskFilter.value,
    operation: operationFilter.value === "all" ? undefined : operationFilter.value,
    level: levelFilter.value === "all" ? undefined : levelFilter.value,
    search: query.value.trim() || undefined,
    from: dateBoundaryIso(fromFilter.value, false),
    to: dateBoundaryIso(toFilter.value, true),
  };
}
async function loadDiskLogs(append: boolean, version: number) {
  if (unmounted || version !== queryVersion) return;
  if (diskLoading.value) {
    if (!append) {
      diskResetPending.value = true;
      reloadQueued = true;
    }
    return;
  }
  if (append && (diskResetPending.value || reloadTimer !== undefined || reloadQueued || !diskCursor.value)) return;
  const requestId = ++requestSequence;
  activeRequestId = requestId;
  const pageCursor = append ? diskCursor.value : undefined;
  diskLoading.value = true; diskError.value = "";
  if (!append) {
    diskResetPending.value = false;
    diskLogs.value = []; diskTotal.value = 0; diskCursor.value = undefined; diskHasMore.value = false;
    malformedLines.value = 0; oversizedLines.value = 0; invalidRecords.value = 0;
  }
  try {
    const result = await backend.queryTaskLogs<DeveloperLogEntry>(diskQuery(pageCursor));
    if (requestId !== activeRequestId || version !== queryVersion) return;
    if (result === null) { diskState.value = "unavailable"; return; }
    diskState.value = "available";
    const items = result.items.map(normalizeDeveloperLogEntry).filter((entry): entry is DeveloperLogEntry => Boolean(entry));
    invalidRecords.value += result.items.length - items.length;
    diskLogs.value = append ? mergeLogEntries(diskLogs.value, items) : items;
    diskTotal.value = result.total; diskCursor.value = result.nextCursor;
    diskHasMore.value = result.hasMore && Boolean(result.nextCursor);
    malformedLines.value = result.malformedLines;
    oversizedLines.value = result.oversizedLines;
  } catch {
    if (requestId !== activeRequestId || version !== queryVersion) return;
    diskState.value = "available";
    diskError.value = "read_failed";
  } finally {
    if (requestId !== activeRequestId) return;
    activeRequestId = 0;
    diskLoading.value = false;
    if (reloadQueued && !unmounted) {
      reloadQueued = false;
      if (reloadTimer !== undefined) {
        window.clearTimeout(reloadTimer);
        reloadTimer = undefined;
      }
      void loadDiskLogs(false, queryVersion);
    }
  }
}
function scheduleDiskReload() {
  if (reloadTimer !== undefined) window.clearTimeout(reloadTimer);
  diskResetPending.value = true;
  const version = ++queryVersion;
  reloadTimer = window.setTimeout(() => {
    reloadTimer = undefined;
    if (version !== queryVersion) return;
    if (diskLoading.value) {
      reloadQueued = true;
      return;
    }
    void loadDiskLogs(false, version);
  }, QUERY_DEBOUNCE_MS);
}
function loadMoreDiskLogs() {
  if (diskLoading.value || diskResetPending.value || reloadTimer !== undefined || reloadQueued) return;
  void loadDiskLogs(true, queryVersion);
}
function requestFreshPage() {
  if (reloadTimer !== undefined) { window.clearTimeout(reloadTimer); reloadTimer = undefined; }
  reloadQueued = false;
  diskResetPending.value = true;
  const version = ++queryVersion;
  if (diskLoading.value) {
    reloadQueued = true;
    return;
  }
  void loadDiskLogs(false, version);
}
// A failed pagination cursor may refer to an expired backend snapshot.
// Restarting at page one always recovers and establishes a fresh snapshot.
function retryDiskLogs() { requestFreshPage(); }
function resetFilters() { query.value = ""; serverFilter.value = "all"; taskFilter.value = "all"; operationFilter.value = "all"; levelFilter.value = "all"; fromFilter.value = ""; toFilter.value = ""; }
function openServer(key: string) { selectedServerId.value = key; selectedTaskId.value = ""; if (key !== "__unassigned__") serverFilter.value = key; }
function closeServer() { selectedServerId.value = null; selectedTaskId.value = ""; serverFilter.value = "all"; taskFilter.value = "all"; }
function formatTime(value: string) { return new Date(value).toLocaleString(locale.value, { hour12: false }); }
async function copyLog(entry: DeveloperLogEntry) { await navigator.clipboard?.writeText(JSON.stringify(entry, null, 2)); copiedId.value = entry.id; window.setTimeout(() => { if (copiedId.value === entry.id) copiedId.value = ""; }, 1500); }
function tokenText(entry: DeveloperLogEntry) { const u = entry.tokenUsage; return u && [u.input, u.output, u.total].every(Number.isFinite) ? `${u.source === "api" ? t("logs.tokenExact") : t("logs.tokenEstimated")} ${u.total.toLocaleString()} (${u.input.toLocaleString()} → ${u.output.toLocaleString()})` : t("logs.tokenUnavailable"); }
const diskErrorLabel = computed(() => diskError.value ? (zh.value ? "读取磁盘日志失败，请稍后重试" : "Failed to read disk logs. Try again later.") : "");
const diskProgressLabel = computed(() => zh.value ? `磁盘已加载 ${diskLogs.value.length} / ${diskTotal.value}` : `Loaded ${diskLogs.value.length} / ${diskTotal.value} from disk`);
const skippedLinesLabel = computed(() => zh.value ? `已跳过 ${skippedLines.value} 条无法读取的日志` : `Skipped ${skippedLines.value} unreadable logs`);
onMounted(requestFreshPage);
onBeforeUnmount(() => {
  unmounted = true;
  reloadQueued = false;
  queryVersion += 1;
  if (reloadTimer !== undefined) window.clearTimeout(reloadTimer);
});
</script>

<template><section class="developer-log-panel">
  <div class="developer-log-source-tabs" role="tablist" :aria-label="locale.startsWith('zh') ? '开发者日志数据源' : 'Developer log source'">
    <button type="button" role="tab" :aria-selected="logSource === 'diagnostic'" :class="{ active: logSource === 'diagnostic' }" @click="logSource = 'diagnostic'">{{ locale.startsWith("zh") ? "脱敏业务诊断" : "Redacted diagnostics" }}</button>
    <button type="button" role="tab" :aria-selected="logSource === 'transport'" :class="{ active: logSource === 'transport' }" @click="logSource = 'transport'">{{ locale.startsWith("zh") ? "模型传输元数据" : "Model transport metadata" }}</button>
  </div>
  <ModelTransportLogsPanel v-if="logSource === 'transport'" />
  <template v-else>
  <div class="developer-log-toolbar">
    <label class="search-box"><Search :size="16"/><input v-model="query" :placeholder="t('logs.developerSearchPlaceholder')"/></label>
    <ParameterSelect v-model="serverFilter" class="developer-log-select" size="small" :options="serverFilterOptions" :ariaLabel="t('logs.serverFilter')" />
    <ParameterSelect v-model="taskFilter" class="developer-log-select" size="small" :options="taskFilterOptions" :ariaLabel="t('logs.taskFilter')" />
    <ParameterSelect v-model="operationFilter" class="developer-log-select" size="small" :options="operationFilterOptions" :ariaLabel="t('logs.developerOperation')" />
    <ParameterSelect v-model="levelFilter" class="developer-log-select" size="small" :options="levelFilterOptions" :ariaLabel="t('logs.levelFilter')" />
    <label class="log-date-filter"><span>{{ locale.startsWith("zh") ? "开始" : "From" }}</span><input v-model="fromFilter" type="date" :aria-label="locale.startsWith('zh') ? '开始日期' : 'From date'" /></label>
    <label class="log-date-filter"><span>{{ locale.startsWith("zh") ? "结束" : "To" }}</span><input v-model="toFilter" type="date" :aria-label="locale.startsWith('zh') ? '结束日期' : 'To date'" /></label>
    <button class="ghost-button" type="button" @click="resetFilters"><RotateCcw :size="14"/>{{ t("logs.reset") }}</button>
  </div>
  <div class="developer-log-hint"><Bug :size="15"/><span>{{ t("logs.developerPrivacyHint") }}</span><strong>{{ summary.total }} {{ t("logs.records") }} · {{ t("logs.tokenTotal", { count: summary.tokens.toLocaleString() }) }}</strong><span v-if="diskState==='available' && !diskError">{{ diskProgressLabel }}</span><span v-if="diskLoading">{{ zh ? "正在读取磁盘日志…" : "Reading logs from disk…" }}</span><em v-if="diskError"><AlertTriangle :size="13"/>{{ diskErrorLabel }}</em><em v-else-if="skippedLines"><AlertTriangle :size="13"/>{{ skippedLinesLabel }}</em><em v-if="summary.errors"><AlertTriangle :size="13"/>{{ summary.errors }} {{ t("logs.levels.error") }}</em></div>
  <div class="developer-log-content">
    <div v-if="!selectedServerId" key="overview" class="log-overview"><div v-if="groupedLogs.length" class="log-groups"><article v-for="server in groupedLogs" :key="server.key" class="log-server-group"><button class="log-server-summary developer-server-summary" type="button" @click="openServer(server.key)"><span class="server-icon"><Server :size="16"/></span><span class="server-identity"><strong>{{ server.name }}</strong><small>{{ server.host || server.serverId || t("logs.localSource") }}</small></span><span class="server-count">{{ server.entries.length }} {{ t("logs.records") }}</span><ChevronRight :size="17"/></button><div class="server-task-preview"><span v-for="task in server.tasks.slice(0,4)" :key="task.key"><span class="task-marker"/>{{ task.title }} <small>{{ task.entries.length }}</small></span></div></article></div><div v-else class="empty-list developer-log-empty"><Bug :size="28"/><strong>{{ t("logs.developerEmpty") }}</strong><span>{{ t("logs.developerEmptyHint") }}</span></div></div>
    <section v-else :key="selectedServerId" class="server-log-workspace developer-log-workspace"><header class="server-log-toolbar"><button class="ghost-button" type="button" @click="closeServer"><ChevronLeft :size="15"/>{{ t("logs.backToServers") }}</button><div class="selected-server-heading"><span class="server-icon"><Server :size="16"/></span><div><strong>{{ selectedServer?.name }}</strong><small>{{ selectedServer?.host || selectedServer?.serverId || t("logs.localSource") }}</small></div></div><span class="server-count">{{ selectedServer?.entries.length }} {{ t("logs.records") }}</span></header>
      <div class="server-log-columns"><aside class="server-task-list"><div class="task-list-heading"><span class="eyebrow">{{ zh ? "任务" : "TASKS" }}</span><strong>{{ t("logs.taskList") }}</strong><span>{{ selectedTasks.length }}</span></div><button v-for="task in selectedTasks" :key="task.key" type="button" :class="['server-task-item',{active:selectedTask?.key===task.key}]" @click="selectedTaskId=task.key"><span class="task-marker"/><span><strong>{{ task.title }}</strong><small>{{ task.taskId || t("logs.noTaskId") }}</small></span><span class="task-item-count">{{ task.entries.length }}</span></button></aside>
      <main class="task-process-panel"><template v-if="selectedTask"><header class="task-process-heading"><div><span class="eyebrow">{{ zh ? "开发者诊断 / 时间线" : "DEVELOPER DIAGNOSTICS / TIMELINE" }}</span><h2>{{ selectedTask.title }}</h2><p>{{ selectedTask.taskId || t("logs.noTaskId") }}</p></div><span class="task-count">{{ selectedTask.entries.length }} {{ t("logs.events") }}</span></header><div class="complete-process-list"><article v-for="(entry,index) in selectedTask.entries" :key="entry.id" class="complete-process-event"><div class="process-rail"><span :class="['log-level',entry.level]"/><span v-if="index<selectedTask.entries.length-1" class="process-line"/></div><div class="process-event-card developer-detail-card"><header><div><span class="log-category">{{ entry.operation }}</span><strong>{{ entry.title }}</strong></div><div class="process-event-meta"><span :class="['log-level-label',entry.level]">{{ t(`logs.levels.${entry.level}`) }}</span><time>{{ formatTime(entry.createdAt) }}</time></div></header><p class="developer-event-summary">{{ entry.summary }}</p><div class="developer-log-identifiers"><span>{{ entry.id }}</span><span v-if="entry.modelName">{{ entry.modelName }}</span><span v-if="entry.durationMs!==undefined">{{ entry.durationMs }} ms</span><span class="developer-token-usage">{{ tokenText(entry) }}</span><button type="button" @click="copyLog(entry)"><Check v-if="copiedId===entry.id" :size="13"/><Copy v-else :size="13"/>{{ copiedId===entry.id?t("logs.copiedDeveloperLog"):t("logs.copyDeveloperLog") }}</button></div><section v-if="entry.request"><label>{{ t("logs.developerRequest") }}</label><pre tabindex="0">{{ entry.request }}</pre></section><section v-if="entry.trace"><label>{{ t("logs.developerTrace") }}</label><pre tabindex="0">{{ entry.trace }}</pre></section><section v-if="entry.response"><label>{{ t("logs.developerResponse") }}</label><pre tabindex="0">{{ entry.response }}</pre></section><section v-if="entry.error"><label>{{ t("logs.developerError") }}</label><pre tabindex="0">{{ entry.error }}</pre></section><section v-if="entry.stack"><label>{{ t("logs.developerStack") }}</label><pre tabindex="0">{{ entry.stack }}</pre></section></div></article></div></template></main></div>
    </section>
  </div>
  <div v-if="diskState==='available' && (diskError || diskHasMore || diskLoading)" class="developer-log-toolbar">
    <button class="ghost-button" type="button" :disabled="diskLoading || diskResetPending" @click="diskError ? retryDiskLogs() : loadMoreDiskLogs()">{{ diskLoading ? (zh ? "正在读取…" : "Loading…") : diskError ? (zh ? "重试" : "Retry") : (zh ? "加载更多" : "Load more") }}</button>
  </div>
  </template>
</section></template>
