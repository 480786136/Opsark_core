<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import type { ExecutionLedgerRecovery, ExecutionLedgerRecoveryAction, ExecutionLedgerRecoveryItem } from "@/features/agent/executionLedgerRecovery";
import type { ExecutionTargetRef } from "@/types";
import ExecutionLedgerRecoveryCard from "./ExecutionLedgerRecoveryCard.vue";
import PreparedExecutionTargets from "./PreparedExecutionTargets.vue";

const store = useOpsStore();
const { locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const expanded = ref(false);
const loading = ref(false);
const error = ref("");
const issues = computed(() => [...new Set([error.value, store.taskCacheReadError, store.executionLedgerReadError].filter(Boolean))]);
const groups = computed(() => {
  const byTask = new Map<string, { taskId: string; title: string; targets: ExecutionTargetRef[]; recovery: ExecutionLedgerRecovery }>();
  // A refreshed task projection replaces its historical recovery snapshot,
  // including an empty projection after resolution. Unioning them resurrects
  // resolved attempts and stale errors/busy flags from the recovery queue.
  const projectedTaskIds = new Set(store.tasks.filter(task => task.executionLedgerRecovery).map(task => task.id));
  const candidates = [
    ...store.tasks.filter(task => task.executionLedgerRecovery).map(task => ({ taskId: task.id, title: task.title,
      targets: task.plan.flatMap(step => step.executionIntent?.semantic.targets ?? []), recovery: task.executionLedgerRecovery! })),
    ...store.executionRecoveryCases.filter(item => !projectedTaskIds.has(item.taskId)),
  ];
  for (const item of candidates) {
    const previous = byTask.get(item.taskId);
    const items = [...(previous?.recovery.items ?? []), ...item.recovery.items];
    const unique = new Map<string, ExecutionLedgerRecoveryItem>();
    for (const record of items) {
      const key = JSON.stringify([record.operationId, record.attemptId, record.kind, record.operationId ? undefined : record.summary]);
      if (!unique.has(key)) unique.set(key, record);
    }
    byTask.set(item.taskId, { taskId: item.taskId, title: previous?.title ?? item.title,
      targets: [...new Map([...(previous?.targets ?? []), ...item.targets].map(target => [JSON.stringify(target), target])).values()],
      recovery: { ...item.recovery, ...previous?.recovery, items: [...unique.values()],
        busyAttemptId: previous?.recovery.busyAttemptId ?? item.recovery.busyAttemptId,
        error: previous?.recovery.error ?? item.recovery.error } });
  }
  return [...byTask.values()].filter(item => item.recovery.items.length || item.recovery.error);
});
async function refresh() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try { await store.restoreExecutionLedgerTasks(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { loading.value = false; }
}
function toggle(event: Event) {
  expanded.value = (event.target as HTMLDetailsElement).open;
  if (expanded.value) void refresh();
}
async function act(taskId: string, action: ExecutionLedgerRecoveryAction, item: ExecutionLedgerRecoveryItem) {
  error.value = "";
  try {
    if (action === "retry_storage") await store.retryExecutionLedgerStorage(taskId, item.attemptId);
    else if ((action === "verify" || action === "reconcile") && item.attemptId) await store.reconcileExecutionAttempt(taskId, item.attemptId);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
</script>

<template>
  <details class="execution-diagnostics" @toggle="toggle">
    <summary>{{ zh ? '执行诊断' : 'Execution diagnostics' }}</summary>
    <div v-if="expanded" class="execution-diagnostics-content">
      <p>{{ zh ? '查看执行台账和恢复详情。历史记录不代表当前服务器状态。' : 'Inspect execution receipts and recovery details. Historical records do not establish current server state.' }}</p>
      <button class="button secondary" type="button" :disabled="loading" @click="refresh">{{ zh ? '刷新诊断' : 'Refresh diagnostics' }}</button>
      <p v-for="issue in issues" :key="issue" role="alert">{{ issue }}</p>
      <article v-for="item in groups" :key="item.taskId" :data-diagnostic-task="item.taskId">
        <h3>{{ item.title }}</h3>
        <PreparedExecutionTargets :targets="item.targets" />
        <ExecutionLedgerRecoveryCard :task-id="item.taskId" :recovery="item.recovery" @action="(action, record) => act(item.taskId, action, record)" />
      </article>
      <p v-if="!loading && !groups.length && !issues.length">{{ zh ? '暂无需要核对的执行异常。' : 'No execution exceptions need reconciliation.' }}</p>
    </div>
  </details>
</template>

<style scoped>
.execution-diagnostics { margin: 0 0 18px; color: var(--muted); font-size: 12px; }
.execution-diagnostics > summary { cursor: pointer; width: fit-content; }
.execution-diagnostics-content { margin-top: 12px; }
.execution-diagnostics-content article { padding-top: 12px; }
.execution-diagnostics-content h3 { color: var(--text); font-size: 13px; overflow-wrap: anywhere; }
.execution-diagnostics-content [role="alert"] { color: var(--orange); }
</style>
