<script setup lang="ts">
import { computed } from "vue";
import { ClipboardCheck, Database, LoaderCircle, ShieldAlert } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import type { ExecutionLedgerRecovery, ExecutionLedgerRecoveryAction, ExecutionLedgerRecoveryItem } from "@/features/agent/executionLedgerRecovery";

defineProps<{ recovery?: ExecutionLedgerRecovery; taskId?: string }>();
const emit = defineEmits<{ action: [action: ExecutionLedgerRecoveryAction, item: ExecutionLedgerRecoveryItem] }>();
const { locale } = useI18n();
const english = computed(() => locale.value.startsWith("en"));
const title = (item: ExecutionLedgerRecoveryItem) => ({
  uncertain: english.value ? "Execution result needs reconciliation" : "执行结果待核对",
  recorded_result: item.origin === "direct"
    ? (english.value ? "Operation result needs review" : "操作结果待核对")
    : (english.value ? "Execution receipt needs review" : "执行回执待复核"),
  storage_failed: english.value ? "Record commit failed" : "记录提交失败",
  incompatible: english.value ? "Record cannot be read safely" : "记录版本待恢复",
})[item.kind];
const actionTitle = (action: ExecutionLedgerRecoveryAction) => ({
  reconcile: english.value ? "Check current state" : "只读核对当前状态",
  verify: english.value ? "Check current state" : "只读核对当前状态",
  retry_storage: english.value ? "Retry saving record" : "重试保存记录",
  none: "",
})[action];
</script>

<template>
  <section v-if="recovery && (recovery.items.length || recovery.error)" class="execution-ledger-recovery" aria-live="polite">
    <article v-for="(item, index) in recovery.items" :key="`${item.operationId}:${item.attemptId ?? index}:${item.kind}`"
      class="ledger-recovery-item" :data-recovery-kind="item.kind">
      <div class="ledger-recovery-heading">
        <Database v-if="item.kind === 'storage_failed'" :size="16" />
        <ClipboardCheck v-else-if="item.kind === 'recorded_result'" :size="16" />
        <ShieldAlert v-else :size="16" />
        <strong>{{ title(item) }}</strong>
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
