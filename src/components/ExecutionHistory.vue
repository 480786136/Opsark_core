<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import SavedEvidenceViewer from "./SavedEvidenceViewer.vue";
import type { OpsTask } from "@/types";
const props = defineProps<{ taskId?: string }>();
const emit = defineEmits<{ opened: [task: OpsTask] }>();
const store = useOpsStore();
const { locale } = useI18n();
const en = computed(() => locale.value.startsWith("en"));
const open = ref(false), loading = ref(false), error = ref("");
const groups = ref<Awaited<ReturnType<typeof store.loadExecutionHistory>>>([]);
const groupLimit = ref(20), receiptLimit = ref<Record<string, number>>({});
let generation = 0;
watch(() => props.taskId, () => { generation++; open.value = false; groups.value = []; error.value = ""; loading.value = false; });
async function toggle() {
  open.value = !open.value;
  const current = ++generation;
  error.value = ""; loading.value = false;
  if (!open.value) return;
  loading.value = true; groups.value = []; groupLimit.value = 20; receiptLimit.value = {};
  try { const rows = await store.loadExecutionHistory(props.taskId); if (current === generation) groups.value = rows; }
  catch (failure) { if (current === generation) error.value = String(failure); }
  finally { if (current === generation) loading.value = false; }
}
async function openTask(taskId: string) {
  loading.value = true; error.value = "";
  try { emit("opened", await store.openArchivedTask(taskId)); }
  catch (failure) { error.value = String(failure); }
  finally { loading.value = false; }
}
</script>
<template>
  <div class="execution-history">
    <button type="button" class="button secondary" :aria-expanded="open" @click="toggle">{{ en ? 'Historical archive' : '历史归档' }}</button>
    <section v-if="open" class="execution-history-panel" :aria-label="en ? 'Historical archive' : '历史归档'">
      <p>{{ en ? 'Saved observations describe their collection time, not the current state or task completion.' : '历史证据反映采集时的情况，不代表当前状态或任务目标已完成。' }}</p>
      <p v-if="loading" role="status">{{ en ? 'Loading…' : '读取中…' }}</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="!loading && !error && !groups.length">{{ en ? 'No saved records.' : '暂无执行记录。' }}</p>
      <article v-for="group in groups.slice(0, groupLimit)" :key="group.taskId">
        <p v-if="group.archiveIssue" role="alert">{{ group.archiveIssue }}</p>
        <h3>{{ group.title }} <small v-if="group.removed">{{ en ? '(Removed from task list)' : '（已从任务列表移除）' }}</small></h3>
        <details><summary>{{ en ? 'Record identity' : '记录归属标识' }}</summary><code>{{ group.taskId }}</code></details>
        <button v-if="group.canOpen" class="button secondary" :disabled="loading" @click="openTask(group.taskId)">{{ en ? 'Open original task' : '打开原任务' }}</button>
        <p v-if="!group.receipts.length">{{ en ? 'Task snapshot saved; no execution receipt.' : '已保存任务快照，暂无执行回执。' }}</p>
        <ul>
          <li v-for="receipt in group.receipts.slice(0, receiptLimit[group.taskId] ?? 20)" :key="receipt.attemptId">
            <strong>{{ receipt.title }}</strong>
            <span>{{ en ? receipt.status : ({ succeeded: '成功', failed: '失败', unknown: '结果未知', dispatching: '结果待返回', not_dispatched: '未派发' }[receipt.status] ?? receipt.status) }}</span>
            <time>{{ new Date(receipt.recordedAt).toLocaleString() }}</time>
            <details><summary>{{ en ? 'Record details' : '记录详情' }}</summary>
              <p>{{ receipt.operationId }} / {{ receipt.attemptId }}</p>
              <pre>{{ JSON.stringify({ action: receipt.action, targets: receipt.targets, expected: receipt.expected }, null, 2) }}</pre>
            </details>
            <span v-if="receipt.late">{{ en ? 'Late result' : '迟到结果' }}</span>
            <SavedEvidenceViewer :task-id="group.taskId" :evidence-refs="receipt.evidenceRefs" />
          </li>
        </ul>
        <button v-if="group.receipts.length > (receiptLimit[group.taskId] ?? 20)" class="button secondary" @click="receiptLimit[group.taskId] = (receiptLimit[group.taskId] ?? 20) + 20">{{ en ? 'Show earlier records' : '显示更早的记录' }}</button>
      </article>
      <button v-if="groups.length > groupLimit" class="button secondary" @click="groupLimit += 20">{{ en ? 'Show more' : '显示更多' }}</button>
    </section>
  </div>
</template>
<style scoped>
.execution-history { margin: 10px 0; }
.execution-history-panel { margin-top: 10px; padding: 14px; border: 1px solid var(--border-color, #c8cdd5); border-radius: 10px; }
p, li, details { font-size: 12px; line-height: 1.6; }
h3 { font-size: 13px; }
li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 10px 0; }
ul { padding: 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
code { overflow-wrap: anywhere; }
</style>
