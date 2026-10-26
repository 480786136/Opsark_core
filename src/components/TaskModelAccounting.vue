<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { OpsTask } from "@/types";
import { createTaskModelBudget, DEFAULT_TASK_MODEL_TOKENS } from "@/features/agent/taskModelBudget";
import type { TaskModelBudgetPolicy } from "@/features/agent/taskModelBudget";
import { modelRequestStateLabel } from "@/services/taskModelRequests";
import { modelServiceError, modelServiceErrorMessage } from "@/services/backend";
import { useOpsStore } from "@/stores/ops";

const props = defineProps<{ task?: OpsTask | null; draftPolicy: TaskModelBudgetPolicy }>();
const emit = defineEmits<{ policy: [value: TaskModelBudgetPolicy] }>();
const store = useOpsStore();
const taskTokens = ref(DEFAULT_TASK_MODEL_TOKENS);
const roundTokens = ref(DEFAULT_TASK_MODEL_TOKENS);
const error = ref("");
const busy = ref(false);
const locked = computed(() => Boolean(props.task?.modelTokenBudget?.lockedAt));
const snapshot = computed(() => props.task?.modelBudgetSnapshot);
const pending = computed(() => props.task?.modelRequests?.filter(item =>
  ["dispatching", "accepted", "unknown"].includes(item.state) || item.cancelRequested || item.late
  || item.requestId === props.task?.modelPlanningBlocker?.error.requestKey) ?? []);
watch(() => [props.task?.id, props.task?.modelTokenBudget, props.draftPolicy] as const, () => {
  const policy = props.task?.modelTokenBudget ?? props.draftPolicy;
  taskTokens.value = policy.maxTaskTokens;
  roundTokens.value = policy.maxRoundTokens;
  error.value = "";
}, { immediate: true });
function save() {
  try {
    const policy = createTaskModelBudget(Number(taskTokens.value), Number(roundTokens.value));
    if (props.task) store.configureTaskModelTokens(props.task.id, policy.maxTaskTokens, policy.maxRoundTokens);
    else emit("policy", policy);
    error.value = "";
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
}
async function refresh(requestId?: string) {
  const taskId = props.task?.id;
  if (!taskId || busy.value) return;
  busy.value = true;
  try {
    if (requestId) await store.recoverTaskModelRequest(taskId, requestId);
    else await store.refreshTaskModelAccounting(taskId);
    error.value = "";
  } catch (failure) {
    const classified = modelServiceError(failure);
    error.value = classified ? modelServiceErrorMessage(classified) : "原请求暂时无法核对，现有记录已保留。";
  } finally { busy.value = false; }
}
</script>

<template>
  <details class="model-accounting">
    <summary>Token 额度与模型请求<span v-if="pending.length"> · {{ pending.length }} 条待查看</span></summary>
    <p v-if="!task?.modelTokenBudget && task">此任务的历史消耗未登记。请设置从现在起允许使用的额度；历史消耗不会计为零。</p>
    <p v-else-if="task?.modelTokenBudget?.coverage === 'from_registration'">额度仅覆盖本次登记后的调用，历史消耗未知。</p>
    <div class="budget-fields">
      <label>任务额度<input v-model.number="taskTokens" type="number" min="1" max="32000000" step="1" :disabled="locked" /></label>
      <label>每轮额度<input v-model.number="roundTokens" type="number" min="1" :max="taskTokens" step="1" :disabled="locked" /></label>
      <button v-if="!locked" type="button" @click="save">保存额度</button>
      <button v-if="task" type="button" :disabled="busy" @click="refresh()">刷新记录</button>
    </div>
    <p v-if="locked">额度已冻结。重规划与重启继续累计；缺失用量的请求保留预估占用。</p>
    <p v-else>默认任务与每轮各 1,000,000 Token。开始请求后额度固定，完整输入与输出预留共同占用额度。</p>
    <p v-if="snapshot">已知用量 {{ snapshot.task.knownUsageTokens.toLocaleString() }}；预留 {{ snapshot.task.estimatedReservedTokens.toLocaleString() }}；任务剩余可用 {{ Math.max(0, snapshot.task.maxTotalTokens - snapshot.task.accountedTokens).toLocaleString() }} Token。</p>
    <p v-if="snapshot && !snapshot.task.exactTokens">含未知用量或在途预留，以上不是最终费用。</p>
    <p v-if="snapshot && snapshot.task.accountedTokens > snapshot.task.maxTotalTokens" role="alert">登记占用已超过任务额度 {{ (snapshot.task.accountedTokens - snapshot.task.maxTotalTokens).toLocaleString() }} Token，后续模型调用将停止。实际用量可能高于派发前估计，请核对原请求。</p>
    <ul v-if="pending.length">
      <li v-for="request in pending" :key="request.requestId">
        {{ modelRequestStateLabel(request) }}
        <button v-if="['unknown', 'accepted', 'dispatching'].includes(request.state)" type="button" :disabled="busy" @click="refresh(request.requestId)">查询原请求</button>
        <small>{{ request.requestId }}</small>
      </li>
    </ul>
    <p v-if="pending.length">查询只更新原请求记录与用量，迟到响应不会自动启动执行。</p>
    <p v-if="error || task?.modelAccountingError" role="alert">{{ error || task?.modelAccountingError }}</p>
  </details>
</template>

<style scoped>
.model-accounting { color: var(--muted); font-size: 12px; margin: 8px 0; }
.model-accounting summary { cursor: pointer; }
.budget-fields { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-top: 8px; }
.budget-fields label { display: grid; gap: 4px; }
.budget-fields input { max-width: 140px; padding: 5px; color: var(--text); background: var(--surface); border: 1px solid var(--border); }
.model-accounting button { padding: 5px 8px; cursor: pointer; }
.model-accounting li { margin: 8px 0; }
.model-accounting small { display: block; overflow-wrap: anywhere; }
</style>
