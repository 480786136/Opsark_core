<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AlertTriangle, Check, Copy, RefreshCw, RotateCcw, Search } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { backend } from "@/services/backend";
import type { ModelTransportEvent } from "@/types";
import ParameterSelect from "@/components/ParameterSelect.vue";

const { locale } = useI18n();
const query = ref("");
const serverFilter = ref("all");
const taskFilter = ref("all");
const eventFilter = ref("all");
const fromFilter = ref("");
const toFilter = ref("");
const events = ref<ModelTransportEvent[]>([]);
const cursor = ref<string>();
const hasMore = ref(false);
const total = ref(0);
const malformedLines = ref(0);
const oversizedLines = ref(0);
const invalidRecords = ref(0);
const loading = ref(false);
const resetPending = ref(false);
const available = ref(false);
const errorMessage = ref("");
const copiedId = ref("");
const PAGE_SIZE = 100;
const QUERY_DEBOUNCE_MS = 250;
const TRANSPORT_EVENTS = ["request_sent", "response_received", "request_failed", "response_failed", "unknown"] as const;
let reloadTimer: number | undefined;
let requestVersion = 0;
let reloadQueued = false;
let unmounted = false;
let requestSequence = 0;
let activeRequestId = 0;

function dateBoundaryIso(value: string, endOfDay: boolean) {
  if (!value) return undefined;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function optionalString(record: Record<string, unknown>, field: string) {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, field: string) {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeTransportEvent(value: unknown): ModelTransportEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.recordId !== "string" || !record.recordId
    || typeof record.event !== "string" || !TRANSPORT_EVENTS.includes(record.event as typeof TRANSPORT_EVENTS[number])
    || typeof record.timestampMs !== "number" || !Number.isFinite(record.timestampMs)) return undefined;
  const event: ModelTransportEvent = {
    recordId: record.recordId,
    event: record.event as ModelTransportEvent["event"],
    timestampMs: record.timestampMs,
  };
  for (const field of ["callId", "requestId", "upstreamRequestId", "requestName", "modelName", "taskId", "serverId", "roundId", "stepId", "contentType", "contentEncoding"] as const) {
    const item = optionalString(record, field);
    if (item !== undefined) Object.assign(event, { [field]: item });
  }
  for (const field of ["attempt", "status", "durationMs", "timeoutSeconds", "contentLength", "phaseIndex"] as const) {
    const item = optionalNumber(record, field);
    if (item !== undefined) Object.assign(event, { [field]: item });
  }
  const metrics = record.contextMetrics;
  if (metrics && typeof metrics === "object" && !Array.isArray(metrics)) {
    const source = metrics as Record<string, unknown>;
    const normalized: NonNullable<ModelTransportEvent["contextMetrics"]> = {};
    for (const field of ["requestBytes", "estimatedInputTokens", "stablePrefixBytes"] as const) {
      const item = optionalNumber(source, field);
      if (item !== undefined) Object.assign(normalized, { [field]: item });
    }
    const fingerprint = optionalString(source, "stablePrefixFingerprint");
    if (fingerprint !== undefined) normalized.stablePrefixFingerprint = fingerprint;
    if (Array.isArray(source.sections)) {
      normalized.sections = source.sections.flatMap((section) => {
        if (!section || typeof section !== "object" || Array.isArray(section)) return [];
        const item = section as Record<string, unknown>;
        const normalizedSection: NonNullable<NonNullable<ModelTransportEvent["contextMetrics"]>["sections"]>[number] = {};
        for (const field of ["messageIndex", "characters", "utf8Bytes"] as const) {
          const number = optionalNumber(item, field);
          if (number !== undefined) Object.assign(normalizedSection, { [field]: number });
        }
        const role = optionalString(item, "role");
        if (role !== undefined) normalizedSection.role = role;
        return [normalizedSection];
      });
    }
    event.contextMetrics = normalized;
  }
  const usage = record.tokenUsage;
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    const item = usage as Record<string, unknown>;
    const input = optionalNumber(item, "input");
    const output = optionalNumber(item, "output");
    const usageTotal = optionalNumber(item, "total");
    if (input !== undefined && output !== undefined && usageTotal !== undefined && item.source === "api") {
      event.tokenUsage = { input, output, total: usageTotal, source: "api" };
      const cacheHit = optionalNumber(item, "cacheHit");
      const cacheMiss = optionalNumber(item, "cacheMiss");
      if (cacheHit !== undefined) event.tokenUsage.cacheHit = cacheHit;
      if (cacheMiss !== undefined) event.tokenUsage.cacheMiss = cacheMiss;
    }
  }
  return event;
}

function mergeEvents(current: ModelTransportEvent[], incoming: ModelTransportEvent[]) {
  const merged = new Map(current.map((event) => [event.recordId, event]));
  incoming.forEach((event) => merged.set(event.recordId, event));
  return [...merged.values()];
}

function matchesFilters(event: ModelTransportEvent) {
  if (serverFilter.value !== "all" && event.serverId !== serverFilter.value) return false;
  if (taskFilter.value !== "all" && event.taskId !== taskFilter.value) return false;
  if (eventFilter.value !== "all" && event.event !== eventFilter.value) return false;
  const from = dateBoundaryIso(fromFilter.value, false);
  const to = dateBoundaryIso(toFilter.value, true);
  if (from && event.timestampMs < Date.parse(from)) return false;
  if (to && event.timestampMs > Date.parse(to)) return false;
  const needle = query.value.trim().toLowerCase();
  return !needle || JSON.stringify(event).toLowerCase().includes(needle);
}

const filteredEvents = computed(() => events.value
  .filter(matchesFilters)
  .sort((left, right) => right.timestampMs - left.timestampMs));
const serverOptions = computed(() => [...new Set(events.value.map((event) => event.serverId).filter((value): value is string => Boolean(value)))].sort());
const taskOptions = computed(() => [...new Set(events.value
  .filter((event) => serverFilter.value === "all" || event.serverId === serverFilter.value)
  .map((event) => event.taskId)
  .filter((value): value is string => Boolean(value)))].sort());
const eventOptions = computed(() => [...new Set([...TRANSPORT_EVENTS, ...events.value.map((event) => event.event)])]);
const serverFilterOptions = computed(() => [
  { value: "all", label: locale.value.startsWith("zh") ? "全部服务器" : "All servers" },
  ...serverOptions.value.map((server) => ({ value: server, label: server })),
]);
const taskFilterOptions = computed(() => [
  { value: "all", label: locale.value.startsWith("zh") ? "全部任务" : "All tasks" },
  ...taskOptions.value.map((task) => ({ value: task, label: task })),
]);
const eventFilterOptions = computed(() => [
  { value: "all", label: locale.value.startsWith("zh") ? "全部事件" : "All events" },
  ...eventOptions.value.map((event) => ({ value: event, label: event })),
]);
const skippedRecords = computed(() => malformedLines.value + oversizedLines.value + invalidRecords.value);

watch(serverFilter, () => {
  if (taskFilter.value !== "all" && !taskOptions.value.includes(taskFilter.value)) taskFilter.value = "all";
});
watch([query, serverFilter, taskFilter, eventFilter, fromFilter, toFilter], scheduleReload, { flush: "sync" });

function historyQuery(pageCursor?: string) {
  return {
    stream: "model-calls" as const,
    cursor: pageCursor,
    limit: PAGE_SIZE,
    serverId: serverFilter.value === "all" ? undefined : serverFilter.value,
    taskId: taskFilter.value === "all" ? undefined : taskFilter.value,
    event: eventFilter.value === "all" ? undefined : eventFilter.value,
    search: query.value.trim() || undefined,
    from: dateBoundaryIso(fromFilter.value, false),
    to: dateBoundaryIso(toFilter.value, true),
  };
}

async function loadEvents(append: boolean, version: number) {
  if (unmounted || version !== requestVersion) return;
  if (loading.value) {
    if (!append) {
      resetPending.value = true;
      reloadQueued = true;
    }
    return;
  }
  if (append && (resetPending.value || reloadTimer !== undefined || reloadQueued || !cursor.value)) return;
  const requestId = ++requestSequence;
  activeRequestId = requestId;
  const pageCursor = append ? cursor.value : undefined;
  loading.value = true;
  errorMessage.value = "";
  if (!append) {
    resetPending.value = false;
    events.value = [];
    cursor.value = undefined;
    hasMore.value = false;
    total.value = 0;
    malformedLines.value = 0;
    oversizedLines.value = 0;
    invalidRecords.value = 0;
  }
  try {
    const result = await backend.queryTaskLogs<unknown>(historyQuery(pageCursor));
    if (requestId !== activeRequestId || version !== requestVersion) return;
    if (result === null) {
      available.value = false;
      return;
    }
    available.value = true;
    const normalized = result.items.map(normalizeTransportEvent).filter((event): event is ModelTransportEvent => Boolean(event));
    invalidRecords.value += result.items.length - normalized.length;
    events.value = append ? mergeEvents(events.value, normalized) : normalized;
    cursor.value = result.nextCursor;
    hasMore.value = result.hasMore && Boolean(result.nextCursor);
    total.value = result.total;
    malformedLines.value = result.malformedLines;
    oversizedLines.value = result.oversizedLines;
  } catch (error) {
    if (requestId !== activeRequestId || version !== requestVersion) return;
    available.value = true;
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestId !== activeRequestId) return;
    activeRequestId = 0;
    loading.value = false;
    if (reloadQueued && !unmounted) {
      reloadQueued = false;
      if (reloadTimer !== undefined) {
        window.clearTimeout(reloadTimer);
        reloadTimer = undefined;
      }
      void loadEvents(false, requestVersion);
    }
  }
}

function scheduleReload() {
  if (reloadTimer !== undefined) window.clearTimeout(reloadTimer);
  resetPending.value = true;
  const version = ++requestVersion;
  reloadTimer = window.setTimeout(() => {
    reloadTimer = undefined;
    if (version !== requestVersion) return;
    if (loading.value) {
      reloadQueued = true;
      return;
    }
    void loadEvents(false, version);
  }, QUERY_DEBOUNCE_MS);
}

function loadMore() {
  if (loading.value || resetPending.value || reloadTimer !== undefined || reloadQueued) return;
  void loadEvents(true, requestVersion);
}

function requestFreshPage() {
  if (reloadTimer !== undefined) {
    window.clearTimeout(reloadTimer);
    reloadTimer = undefined;
  }
  reloadQueued = false;
  resetPending.value = true;
  const version = ++requestVersion;
  if (loading.value) {
    reloadQueued = true;
    return;
  }
  void loadEvents(false, version);
}

// Snapshot cursors are deliberately short-lived and bounded server-side.
// A retry starts a fresh view instead of repeatedly submitting an expired token.
function retry() { requestFreshPage(); }
function refresh() { requestFreshPage(); }

function resetFilters() {
  query.value = "";
  serverFilter.value = "all";
  taskFilter.value = "all";
  eventFilter.value = "all";
  fromFilter.value = "";
  toFilter.value = "";
}

function eventLevel(event: ModelTransportEvent) {
  if (event.event === "request_failed" || event.event === "response_failed") return "error";
  if (event.event === "response_received") return event.status !== undefined && event.status >= 400 ? "error" : "success";
  return "info";
}

function eventTitle(event: ModelTransportEvent) {
  const requestName = event.requestName || (locale.value.startsWith("zh") ? "模型调用" : "Model call");
  if (event.event === "request_sent") return `${requestName} · ${locale.value.startsWith("zh") ? "请求已发送" : "request sent"}`;
  if (event.event === "response_received") return `${requestName} · ${locale.value.startsWith("zh") ? "收到响应" : "response received"}${event.status !== undefined ? ` HTTP ${event.status}` : ""}`;
  if (event.event === "request_failed") return `${requestName} · ${locale.value.startsWith("zh") ? "请求传输失败" : "request transport failed"}`;
  if (event.event === "response_failed") return `${requestName} · ${locale.value.startsWith("zh") ? "响应读取失败" : "response read failed"}`;
  return `${requestName} · ${locale.value.startsWith("zh") ? "未知传输事件" : "unknown transport event"}`;
}

function eventSummary(event: ModelTransportEvent) {
  const parts: string[] = [event.event];
  if (event.attempt !== undefined) parts.push(`attempt ${event.attempt}`);
  if (event.status !== undefined) parts.push(`HTTP ${event.status}`);
  if (event.durationMs !== undefined) parts.push(`${event.durationMs} ms`);
  if (event.contentLength !== undefined) parts.push(`${event.contentLength} bytes`);
  return parts.join(" · ");
}

function tokenText(event: ModelTransportEvent) {
  const usage = event.tokenUsage;
  if (!usage) return undefined;
  const cache = [usage.cacheHit !== undefined ? `cache hit ${usage.cacheHit}` : "", usage.cacheMiss !== undefined ? `miss ${usage.cacheMiss}` : ""].filter(Boolean).join(" / ");
  return `${usage.total.toLocaleString()} tokens (${usage.input.toLocaleString()} → ${usage.output.toLocaleString()})${cache ? ` · ${cache}` : ""}`;
}

function formatTime(timestampMs: number) {
  const date = new Date(timestampMs);
  return Number.isNaN(date.getTime()) ? String(timestampMs) : date.toLocaleString(locale.value, { hour12: false });
}

async function copyMetadata(event: ModelTransportEvent) {
  await navigator.clipboard?.writeText(JSON.stringify(event, null, 2));
  copiedId.value = event.recordId;
  window.setTimeout(() => {
    if (copiedId.value === event.recordId) copiedId.value = "";
  }, 1500);
}

onMounted(requestFreshPage);
onBeforeUnmount(() => {
  unmounted = true;
  reloadQueued = false;
  requestVersion += 1;
  if (reloadTimer !== undefined) window.clearTimeout(reloadTimer);
});
</script>

<template>
  <section class="model-transport-panel">
    <div class="developer-log-toolbar model-transport-toolbar">
      <label class="search-box"><Search :size="16" /><input v-model="query" :placeholder="locale.startsWith('zh') ? '搜索调用 ID、请求名称或安全元数据' : 'Search call IDs, request names, or safe metadata'" /></label>
      <ParameterSelect v-model="serverFilter" class="model-transport-select" size="small" :options="serverFilterOptions" :ariaLabel="locale.startsWith('zh') ? '按服务器筛选' : 'Filter by server'" />
      <ParameterSelect v-model="taskFilter" class="model-transport-select" size="small" :options="taskFilterOptions" :ariaLabel="locale.startsWith('zh') ? '按任务筛选' : 'Filter by task'" />
      <ParameterSelect v-model="eventFilter" class="model-transport-select" size="small" :options="eventFilterOptions" :ariaLabel="locale.startsWith('zh') ? '按传输事件筛选' : 'Filter by transport event'" />
      <label class="log-date-filter"><span>{{ locale.startsWith("zh") ? "开始" : "From" }}</span><input v-model="fromFilter" type="date" :aria-label="locale.startsWith('zh') ? '开始日期' : 'From date'" /></label>
      <label class="log-date-filter"><span>{{ locale.startsWith("zh") ? "结束" : "To" }}</span><input v-model="toFilter" type="date" :aria-label="locale.startsWith('zh') ? '结束日期' : 'To date'" /></label>
      <button class="ghost-button" type="button" @click="resetFilters"><RotateCcw :size="14" />{{ locale.startsWith("zh") ? "重置" : "Reset" }}</button>
      <button class="ghost-button" type="button" :disabled="loading || resetPending" @click="refresh"><RefreshCw :size="14" />{{ locale.startsWith("zh") ? "刷新" : "Refresh" }}</button>
    </div>

    <div class="developer-log-hint model-transport-warning" role="note">
      <AlertTriangle :size="15" />
      <span>{{ locale.startsWith("zh") ? "底层传输文件可能含业务上下文；Rust 强制只向此页返回元数据，不向页面传输、展示或复制 prompt、response 和错误正文。" : "Transport files may contain business context. Rust returns metadata only; prompts, responses, and error bodies are never sent to this view, displayed, or copied." }}</span>
      <strong>{{ events.length }} / {{ total }}</strong>
      <em v-if="errorMessage"><AlertTriangle :size="13" />{{ errorMessage }}</em>
      <em v-else-if="skippedRecords"><AlertTriangle :size="13" />{{ locale.startsWith("zh") ? `已跳过 ${skippedRecords} 条无法读取的记录` : `Skipped ${skippedRecords} unreadable records` }}</em>
      <span v-if="loading">{{ locale.startsWith("zh") ? "正在读取磁盘元数据…" : "Reading transport metadata…" }}</span>
    </div>

    <div class="model-transport-list">
      <article v-for="event in filteredEvents" :key="event.recordId" class="process-event-card model-transport-event">
        <header>
          <div><span class="log-category">{{ event.event }}</span><strong>{{ eventTitle(event) }}</strong></div>
          <div class="process-event-meta"><span :class="['log-level-label', eventLevel(event)]">{{ eventLevel(event) }}</span><time>{{ formatTime(event.timestampMs) }}</time></div>
        </header>
        <p>{{ eventSummary(event) }}</p>
        <div class="developer-log-identifiers">
          <span>{{ event.recordId }}</span>
          <span v-if="event.callId">call {{ event.callId }}</span>
          <span v-if="event.requestId">request {{ event.requestId }}</span>
          <span v-if="event.upstreamRequestId">upstream {{ event.upstreamRequestId }}</span>
          <span v-if="event.serverId">server {{ event.serverId }}</span>
          <span v-if="event.taskId">task {{ event.taskId }}</span>
          <span v-if="tokenText(event)">{{ tokenText(event) }}</span>
          <button type="button" @click="copyMetadata(event)"><Check v-if="copiedId === event.recordId" :size="13" /><Copy v-else :size="13" />{{ copiedId === event.recordId ? (locale.startsWith("zh") ? "已复制" : "Copied") : (locale.startsWith("zh") ? "复制元数据" : "Copy metadata") }}</button>
        </div>
        <details v-if="event.contextMetrics"><summary>{{ locale.startsWith("zh") ? "上下文体积元数据" : "Context size metadata" }}</summary><pre>{{ JSON.stringify(event.contextMetrics, null, 2) }}</pre></details>
      </article>
      <div v-if="!filteredEvents.length && !loading" class="empty-list developer-log-empty">
        <strong>{{ locale.startsWith("zh") ? "没有匹配的模型传输元数据" : "No matching model transport metadata" }}</strong>
        <span v-if="!available">{{ locale.startsWith("zh") ? "仅桌面端可读取本机磁盘日志。" : "Local disk history is available in the desktop app only." }}</span>
      </div>
    </div>

    <div v-if="errorMessage || hasMore || loading" class="model-transport-footer">
      <button class="ghost-button" type="button" :disabled="loading || resetPending" @click="errorMessage ? retry() : loadMore()">{{ loading ? (locale.startsWith("zh") ? "正在读取…" : "Loading…") : errorMessage ? (locale.startsWith("zh") ? "重试" : "Retry") : (locale.startsWith("zh") ? "加载更多" : "Load more") }}</button>
    </div>
  </section>
</template>
