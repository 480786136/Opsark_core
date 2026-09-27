<script setup lang="ts">
import { computed, ref } from "vue";
import { ClipboardCheck, Database, LoaderCircle, ShieldAlert } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import type { ExecutionLedgerRecovery, ExecutionLedgerRecoveryAction, ExecutionLedgerRecoveryItem } from "@/features/agent/executionLedgerRecovery";

import { backend } from "@/services/backend";
const props = defineProps<{ recovery?: ExecutionLedgerRecovery; taskId?: string }>();
const evidenceText = ref("");
const visibleReadCount = ref(20);
const evidenceError = ref("");
const readingEvidence = ref(false);
async function readEvidence(evidenceId: string) {
  if (!props.taskId || readingEvidence.value) return;
  readingEvidence.value = true; evidenceError.value = ""; evidenceText.value = "";
  try {
    const result = await backend.readTaskEvidence(props.taskId, evidenceId, 0, 8000);
    evidenceText.value = JSON.stringify(result, null, 2);
  } catch { evidenceError.value = english.value ? "Could not read saved evidence. No remote command was sent." : "暂时无法读取已保存证据，未发送远端命令。"; }
  finally { readingEvidence.value = false; }
}
const emit = defineEmits<{ action: [action: ExecutionLedgerRecoveryAction, item: ExecutionLedgerRecoveryItem] }>();
const { locale } = useI18n();
const english = computed(() => locale.value.startsWith("en"));
const title = (kind: ExecutionLedgerRecoveryItem["kind"]) => ({
  uncertain: english.value ? "Execution result needs reconciliation" : "执行结果待核对",
  recorded_result: english.value ? "Task result needs review" : "任务结果待确认",
  storage_failed: english.value ? "Record commit failed" : "记录提交失败",
  incompatible: english.value ? "Record cannot be read safely" : "记录版本待恢复",
})[kind];
const actionTitle = (action: ExecutionLedgerRecoveryAction) => ({
  reconcile: english.value ? "Check current state" : "只读核对当前状态",
  verify: english.value ? "Check current state" : "只读核对当前状态",
  retry_storage: english.value ? "Retry saving record" : "重试保存记录",
  none: "",
})[action];
</script>

<template>
  <section v-if="recovery && (recovery.items.length || recovery.recordedReads?.length)" class="execution-ledger-recovery" aria-live="polite">
    <article v-for="(item, index) in recovery.items" :key="`${item.operationId}:${item.attemptId ?? index}:${item.kind}`"
      class="ledger-recovery-item" :data-recovery-kind="item.kind">
      <div class="ledger-recovery-heading">
        <Database v-if="item.kind === 'storage_failed'" :size="16" />
        <ClipboardCheck v-else-if="item.kind === 'recorded_result'" :size="16" />
        <ShieldAlert v-else :size="16" />
        <strong>{{ title(item.kind) }}</strong>
      </div>
      <p v-if="item.title"><strong>{{ item.title }}</strong></p>
      <p>{{ item.summary }}</p>
      <ul v-if="item.knownFacts.length"><li v-for="fact in item.knownFacts" :key="fact">{{ fact }}</li></ul>
      <p v-if="item.cancelRequested" class="ledger-cancellation-note">
        {{ english ? 'Cancellation was requested. This does not confirm the remote operation has stopped.' : '取消请求已记录，不代表远端操作已停止。' }}
      </p>
      <details v-if="item.attemptId || item.operationId" class="ledger-attempt-details">
        <summary>{{ english ? 'Execution record identity' : '查看执行记录标识' }}</summary>
        <dl>
          <template v-if="item.operationId"><dt>{{ english ? 'Operation' : '操作' }}</dt><dd>{{ item.operationId }}</dd></template>
          <template v-if="item.attemptId"><dt>{{ english ? 'Attempt' : '尝试' }}</dt><dd>{{ item.attemptId }}</dd></template>
        </dl>
      </details>
      <button v-if="item.action !== 'none'" type="button" class="button secondary" :data-ledger-action="item.action"
        :disabled="Boolean(recovery.busyAttemptId)" @click="emit('action', item.action, item)">
        <LoaderCircle v-if="recovery.busyAttemptId && recovery.busyAttemptId === item.attemptId" class="spin" :size="13" />
        {{ actionTitle(item.action) }}
      </button>
    </article>
    <details v-if="recovery.recordedReads?.length" class="recorded-read-evidence">
      <summary>{{ english ? `Saved inspection results (${recovery.recordedReads.length})` : `已保存的检查结果（${recovery.recordedReads.length}）` }}</summary>
      <p>{{ english ? 'Historical observations, not a new check or task acceptance.' : '以下为历史检查证据，采集时间不代表当前状态，也不代表任务目标已完成。' }}</p>
      <ul>
        <li v-for="receipt in recovery.recordedReads.slice(-visibleReadCount).reverse()" :key="receipt.attemptId">
          <strong>{{ receipt.title }}</strong>
          <span>{{ receipt.status === 'succeeded' ? (english ? 'Result saved' : '结果已保存') : (english ? 'Failed inspection recorded' : '检查失败已记录') }}</span>
          <time v-if="receipt.recordedAt">{{ new Date(receipt.recordedAt).toLocaleString() }}</time>
          <span v-if="receipt.late">{{ english ? 'Late result; not applied to current task' : '迟到结果，未推进当前任务' }}</span>
          <button v-for="id in receipt.evidenceRefs" v-show="taskId" :key="id" type="button" class="button secondary"
            :disabled="readingEvidence" @click="readEvidence(id)">{{ english ? 'View saved evidence' : '查看已保存证据' }}</button>
        </li>
      </ul>
      <button v-if="recovery.recordedReads.length > visibleReadCount" type="button" class="button secondary" @click="visibleReadCount += 20">{{ english ? 'Show earlier results' : '显示更早的结果' }}</button>
      <p v-if="evidenceError" role="alert">{{ evidenceError }}</p>
      <pre v-if="evidenceText" class="saved-evidence-preview">{{ evidenceText }}</pre>
    </details>
    <p v-if="recovery.error" class="ledger-recovery-error" role="alert">{{ recovery.error }}</p>
  </section>
</template>

<style scoped>
.execution-ledger-recovery { display: grid; gap: 10px; margin: 14px 0; }
.ledger-recovery-item { border: 1px solid var(--border-color, #c8cdd5); border-radius: 10px; padding: 14px; background: var(--surface, transparent); }
.ledger-recovery-heading { display: flex; align-items: center; gap: 8px; }
.ledger-recovery-item p, .ledger-recovery-item li { font-size: 12px; line-height: 1.6; }
.ledger-recovery-item ul { margin: 8px 0; padding-left: 20px; }
.ledger-cancellation-note, .ledger-recovery-error { color: var(--warning-color, #a45a11); }
.ledger-attempt-details { margin: 10px 0; font-size: 11px; }
.ledger-attempt-details summary { cursor: pointer; }
.ledger-attempt-details dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 10px; }
.ledger-attempt-details dd { margin: 0; overflow-wrap: anywhere; }
</style>

<style scoped>
.recorded-read-evidence { font-size: 12px; }
.recorded-read-evidence li { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.saved-evidence-preview { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
</style>
