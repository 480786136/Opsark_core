<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ClipboardCheck,
  Clock3,
  History,
  KeyRound,
  ListTree,
  LoaderCircle,
  MessageSquarePlus,
  Play,
  Quote,
  Send,
  ShieldAlert,
  Square,
  Sparkles,
  TerminalSquare,
  Trash2,
} from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import type { ObservationStatus, OpsTask, PlanStep } from "@/types";
import ModelSettingsModal from "@/components/ModelSettingsModal.vue";
import { useAgentWorkspaceStore } from "@/features/agent/agentWorkspaceStore";
import { useWorkspaceLinkStore } from "@/features/workspace/workspaceLinkStore";

const props = defineProps<{ serverId: string }>();
const store = useOpsStore();
const agentWorkspaces = useAgentWorkspaceStore();
const workspaceLinks = useWorkspaceLinkStore();
const { t, locale } = useI18n();
const taskMenuTrigger = ref<HTMLElement>();
const taskMenu = ref<HTMLElement>();
const workspaceState = agentWorkspaces.ensureServer(props.serverId);
const persistedField = <K extends keyof typeof workspaceState>(key: K) => computed({
  get: () => workspaceState[key],
  set: (value: typeof workspaceState[K]) => agentWorkspaces.updateServer(props.serverId, { [key]: value }),
});
const input = persistedField("draft");
const permission = persistedField("permission");
const modelId = persistedField("modelId");
const automationEnabled = persistedField("automationEnabled");
const checkingModels = ref(false);
const showModelSettings = ref(false);
const showTasks = persistedField("showTasks");
const expandedSteps = ref<string[]>([]);
const expandedRounds = ref<string[]>([]);
const expandedRecords = ref<string[]>([]);
const terminalReference = ref("");
const secretInput = ref("");
const userInputValues = ref<Record<string, string>>({});
const timeline = ref<HTMLElement>();

const serverTasks = computed(() => store.tasks.filter((task) => task.serverId === props.serverId));
const task = computed(() => serverTasks.value.find((item) => item.id === workspaceState.activeTaskId));
const pendingApproval = computed(() => task.value?.plan.find((step) => step.status === "awaiting_approval"));
const failedStep = computed(() => task.value?.plan.find((step) => step.status === "failed"));
const adjustmentLabel = computed(() =>
  failedStep.value?.result?.executionStatus === "failed"
    ? t("agent.executionPaused")
    : t("agent.validationPaused"),
);
const pendingSecretRequest = computed(() =>
  store.pendingSecret?.taskId === task.value?.id ? store.pendingSecret : undefined,
);
const pendingUserInputRequest = computed(() =>
  store.pendingUserInputs.find((request) => request.taskId === task.value?.id),
);
const isBusy = computed(() => task.value && ["planning", "running", "validating"].includes(task.value.status));
const canTerminate = computed(() =>
  Boolean(task.value && (
    task.value.currentExecutionId
    || ["planning", "running", "validating", "awaiting_input"].includes(task.value.status)
  )),
);

watch(() => pendingUserInputRequest.value?.callId, () => {
  userInputValues.value = {};
});

async function submitUserInput() {
  if (!task.value || !pendingUserInputRequest.value) return;
  const submitted = await store.provideUserInput(task.value.id, userInputValues.value);
  if (submitted) userInputValues.value = {};
}
const currentConversationMessages = computed(() => {
  if (!task.value) return [];
  const start = task.value.messages
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === "user" && message.kind === "message")?.index ?? 0;
  return task.value.messages.slice(start).filter((message) => message.kind === "message");
});
const currentRecords = computed(() => {
  if (!task.value) return [];
  const start = task.value.messages
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === "user" && message.kind === "message")?.index ?? -1;
  return task.value.messages.slice(start + 1).filter((message) => message.kind === "event");
});
const activeRecordId = computed(() => isBusy.value
  ? currentRecords.value[currentRecords.value.length - 1]?.id
  : undefined);

watch(
  () => [task.value?.messages.length, task.value?.plan.length, task.value?.status],
  async () => {
    await nextTick();
    timeline.value?.scrollTo({ top: timeline.value.scrollHeight, behavior: "smooth" });
  },
);

watch(
  () => workspaceLinks.terminalModelReferences[props.serverId],
  (reference) => {
    if (!reference) return;
    terminalReference.value = reference.content;
    workspaceLinks.consumeTerminalModelReference(props.serverId, reference.id);
    void nextTick(() => document.querySelector<HTMLTextAreaElement>(`.agent-workspace-stack textarea`)?.focus());
  },
  { immediate: true },
);

watch(
  () => serverTasks.value.map(({ id }) => id),
  (taskIds) => agentWorkspaces.reconcileTasks(props.serverId, taskIds),
  { immediate: true },
);

function toggleStep(id: string) {
  expandedSteps.value = expandedSteps.value.includes(id)
    ? expandedSteps.value.filter((item) => item !== id)
    : [...expandedSteps.value, id];
}

async function submit() {
  const value = input.value.trim();
  if (!value || !automationEnabled.value || isBusy.value || !modelId.value || !store.connectedServerIds.includes(props.serverId)) return;
  showTasks.value = false;
  let selectedTask = task.value;
  if (!selectedTask) {
    selectedTask = store.createTask(props.serverId, permission.value, modelId.value);
    agentWorkspaces.updateServer(props.serverId, { activeTaskId: selectedTask.id });
  }
  input.value = "";
  await store.submitRequirement(
    props.serverId,
    value,
    permission.value,
    modelId.value,
    terminalReference.value,
    selectedTask.id,
  );
  terminalReference.value = "";
}

function selectFirstAvailableModel() {
  if (!store.availableModels.some((model) => model.id === modelId.value)) {
    modelId.value = store.availableModels[0]?.id ?? "";
  }
}

async function enableAutomation() {
  automationEnabled.value = true;
  checkingModels.value = true;
  await store.refreshModelAvailability();
  selectFirstAvailableModel();
  checkingModels.value = false;
}

async function restoreAutomation() {
  if (!automationEnabled.value) return;
  checkingModels.value = true;
  await store.refreshModelAvailability();
  selectFirstAvailableModel();
  checkingModels.value = false;
}

function handleModelSelection(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value !== "__manage_models__") return;
  showModelSettings.value = true;
  selectFirstAvailableModel();
}

function modelOptionText(modelIdValue: string, name: string) {
  const availability = store.modelAvailability[modelIdValue];
  if (availability?.status === "available") return `${name} · ${t("agent.modelAvailable")}`;
  if (availability?.status === "checking") return `${name} · ${t("agent.modelChecking")}`;
  return `${name} · ${availability?.reason ?? t("agent.modelUnavailable")}`;
}

function handleModelsSaved() {
  selectFirstAvailableModel();
}

function referenceTerminal() {
  terminalReference.value = store.terminalLines.slice(-14).join("\n");
}

function riskText(step: PlanStep) {
  return t(`agent.risk${step.risk === "low" ? "Low" : step.risk === "medium" ? "Medium" : "High"}`);
}

function executionText(step: PlanStep) {
  const labels = {
    success: "agent.executionSuccess",
    failed: "agent.executionFailed",
    cancelled: "agent.executionCancelled",
    blocked: "agent.executionBlocked",
  };
  return step.result ? t(labels[step.result.executionStatus]) : t("agent.executionPending");
}

function factsText(step: PlanStep) {
  return JSON.stringify(step.result?.facts ?? {}, null, 2);
}

function stepObservationText(step: PlanStep) {
  if (step.result?.executionStatus === "failed") return t("agent.observationMissing");
  const keys: Record<ObservationStatus, string> = {
    matched: "agent.observationMatched",
    not_found: "agent.observationNotFound",
    healthy: "agent.observationHealthy",
    unhealthy: "agent.observationUnhealthy",
    warning: "agent.observationWarning",
    unknown: "agent.observationUnknown",
  };
  return step.result?.observationStatus ? t(keys[step.result.observationStatus]) : t("agent.observationNone");
}

function statusText(status?: string) {
  const labels: Record<string, string> = {
    draft: "agent.statusDraft",
    planning: "agent.statusPlanning",
    awaiting_plan_approval: "agent.statusAwaitingPlan",
    running: "agent.statusRunning",
    awaiting_step_approval: "agent.statusAwaitingStep",
    awaiting_input: "agent.statusAwaitingInput",
    validating: "agent.statusValidating",
    needs_adjustment: "agent.statusAdjustment",
    completed: "agent.statusCompleted",
    failed: "agent.statusFailed",
    cancelled: "agent.statusCancelled",
  };
  return status ? (labels[status] ? t(labels[status]) : status) : "";
}

function summaryTitle(status?: string) {
  const labels: Record<string, string> = {
    completed: "agent.summaryCompleted",
    failed: "agent.summaryFailed",
    cancelled: "agent.summaryCancelled",
    needs_adjustment: "agent.summaryAdjustment",
  };
  return t(status && labels[status] ? labels[status] : "agent.summaryDefault");
}

function messageAuthor(role: "user" | "assistant" | "system") {
  return role === "user" ? t("agent.you") : role === "assistant" ? "Opsark" : t("agent.executionRecord");
}

function toggleRound(id: string) {
  expandedRounds.value = expandedRounds.value.includes(id)
    ? expandedRounds.value.filter((item) => item !== id)
    : [...expandedRounds.value, id];
}

function toggleRecords(id: string) {
  expandedRecords.value = expandedRecords.value.includes(id)
    ? expandedRecords.value.filter((item) => item !== id)
    : [...expandedRecords.value, id];
}

function taskCanBeDeleted(item: OpsTask) {
  return !item.currentExecutionId && !["planning", "running", "validating"].includes(item.status);
}

async function deleteTaskItem(item: OpsTask) {
  if (!taskCanBeDeleted(item)) {
    await store.terminateTask(item.id);
  }
  store.deleteTask(item.id);
  agentWorkspaces.reconcileTasks(props.serverId, serverTasks.value.map(({ id }) => id));
}

function selectTaskItem(taskId: string) {
  store.selectTask(taskId);
  agentWorkspaces.updateServer(props.serverId, { activeTaskId: taskId, showTasks: false });
}

function startNewTask() {
  agentWorkspaces.updateServer(props.serverId, { activeTaskId: "", showTasks: false });
}

function closeTaskMenuOnOutsidePointer(event: PointerEvent) {
  const target = event.target as Node;
  if (showTasks.value && !taskMenu.value?.contains(target) && !taskMenuTrigger.value?.contains(target)) {
    showTasks.value = false;
  }
}

onMounted(() => {
  document.addEventListener("pointerdown", closeTaskMenuOnOutsidePointer);
  void restoreAutomation();
});
onBeforeUnmount(() => document.removeEventListener("pointerdown", closeTaskMenuOnOutsidePointer));
</script>

<template>
  <section class="work-panel agent-panel">
    <header class="agent-header">
      <div class="agent-title">
        <span class="agent-title-icon"><Bot :size="17" /></span>
        <span class="agent-title-copy"><strong>{{ t("agent.title") }}</strong><small v-if="task">{{ task.title }}</small></span>
        <span class="beta">CORE</span>
        <span v-if="isBusy" class="agent-activity"><i></i>{{ statusText(task?.status) }}</span>
      </div>
      <button ref="taskMenuTrigger" :class="['text-icon-button', 'task-menu-trigger', { active: showTasks }]" @click="showTasks = !showTasks">
        <span class="task-menu-trigger-icon"><History :size="14" /></span>
        <span class="task-menu-trigger-copy"><strong>{{ t("agent.tasks") }}</strong><small>{{ task ? statusText(task.status) : t("agent.noActiveTask") }}</small></span>
        <b>{{ serverTasks.length }}</b>
      </button>
    </header>

    <div v-if="!automationEnabled" class="agent-welcome">
      <div class="agent-welcome-ambient" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="agent-orb">
        <span class="agent-orb-ring ring-one" aria-hidden="true"></span>
        <span class="agent-orb-ring ring-two" aria-hidden="true"></span>
        <span class="agent-orb-scan" aria-hidden="true"></span>
        <Bot :size="28" />
      </div>
      <h2>{{ t("agent.enableTitle") }}</h2>
      <p>{{ t("agent.enableSubtitle") }}</p>
      <div class="context-list">
        <span><Check :size="14" />{{ t("agent.contextEnvironment") }}</span>
        <span><Check :size="14" />{{ t("agent.contextMetrics") }}</span>
        <span><Check :size="14" />{{ t("agent.contextSecurity") }}</span>
      </div>
      <button class="button primary wide agent-launch-button" :disabled="!store.connectedServerIds.includes(serverId)" @click="enableAutomation"><span class="agent-launch-shine" aria-hidden="true"></span><Play :size="15" />{{ t("agent.enableTitle") }}</button>
      <small class="agent-connection-hint" :class="{ connected: store.connectedServerIds.includes(serverId) }"><i></i>{{ t(store.connectedServerIds.includes(serverId) ? "agent.liveHint" : "agent.disconnectedHint") }}</small>
    </div>

    <template v-else>
      <Transition name="task-pop">
      <div v-if="showTasks" ref="taskMenu" class="task-strip">
        <header class="task-strip-head">
          <span class="task-strip-heading"><History :size="14" /><span><strong>{{ t("agent.taskListTitle") }}</strong><small>{{ t("agent.taskListHint") }}</small></span></span>
          <strong>{{ serverTasks.length }}</strong>
        </header>
        <div class="task-strip-list">
        <TransitionGroup name="task-list">
        <div v-for="item in serverTasks" :key="item.id" :class="['task-strip-item', item.status, { active: item.id === task?.id }]">
          <button class="task-select" @click="selectTaskItem(item.id)">
            <span :class="['task-status-mini', item.status]"></span>
            <span><strong>{{ item.title }}</strong><small>{{ t("agent.rounds", { count: (item.planHistory?.length ?? 0) + (item.messages.some((message) => message.role === 'user' && message.kind === 'message') ? 1 : 0), status: statusText(item.status) }) }}</small></span>
          </button>
          <button
            class="task-delete"
            type="button"
            :title="t('agent.removeTask')"
            :aria-label="t('agent.removeTaskNamed', { name: item.title })"
            @click.stop="deleteTaskItem(item)"
          ><Trash2 :size="13" /></button>
        </div>
        </TransitionGroup>
        <div v-if="!serverTasks.length" class="task-strip-empty">{{ t("agent.emptyTitle") }}</div>
        </div>
        <button class="new-task" @click="startNewTask"><MessageSquarePlus :size="14" />{{ t("agent.newTask") }}</button>
      </div>
      </Transition>

      <div ref="timeline" class="agent-timeline">
        <div v-if="!task" class="empty-agent">
          <div class="mini-orb"><Bot :size="22" /></div>
          <h3>{{ t("agent.emptyTitle") }}</h3>
          <p>{{ t("agent.emptyHint") }}</p>
          <button @click="input = t('agent.requestSystem')">{{ t("agent.suggestSystem") }}</button>
          <button @click="input = t('agent.requestDisk')">{{ t("agent.suggestDisk") }}</button>
        </div>

        <template v-else>
          <template v-for="round in task.planHistory ?? []" :key="round.id">
            <div class="task-message user message user-aligned">
              <div class="message-body">
                <div class="message-meta">
                  <strong>{{ t("agent.you") }}</strong>
                  <time>{{ new Date(round.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) }}</time>
                </div>
                <p>{{ round.requirement }}</p>
              </div>
            </div>
            <div class="task-message assistant message">
              <div class="message-avatar"><Bot :size="15" /></div>
              <div class="message-body">
                <div class="message-meta">
                  <strong>Opsark</strong>
                  <time>{{ new Date(round.response?.createdAt ?? round.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) }}</time>
                </div>
                <p>{{ round.response?.content ?? t("agent.generatedSteps", { count: round.plan.length }) }}</p>
              </div>
            </div>

            <div v-if="round.plan.length" :class="['plan-card', 'archived-plan', `task-card-${round.status}`]">
              <button class="plan-card-head archived-head" @click="toggleRound(round.id)">
                <span>
                  <ClipboardCheck :size="15" />
                  <span><strong>{{ t("agent.archivedPlan") }}</strong><small>{{ round.requirement }}</small></span>
                </span>
                <span>
                  <span class="history-time">{{ new Date(round.completedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) }}</span>
                  <span :class="['task-state-pill', round.status]">{{ statusText(round.status) }}</span>
                  <ChevronDown v-if="expandedRounds.includes(round.id)" :size="15" />
                  <ChevronRight v-else :size="15" />
                </span>
              </button>
              <template v-if="expandedRounds.includes(round.id)">
                <div class="steps">
                  <div v-for="(step, index) in round.plan" :key="step.id" :class="['plan-step', step.status]">
                    <button class="step-main" @click="toggleStep(`history-${round.id}-${step.id}`)">
                      <span class="step-icon"><CheckCircle2 v-if="step.status === 'completed'" :size="17" /><LoaderCircle v-else-if="['running', 'validating'].includes(step.status)" class="spin" :size="17" /><Circle v-else :size="17" /></span>
                      <span class="step-copy"><strong>{{ index + 1 }}. {{ step.title }}</strong><small>{{ step.description }}</small></span>
                      <span v-if="step.result" :class="['observation-tag', step.result.observationStatus]">{{ stepObservationText(step) }}</span>
                      <span :class="['risk-tag', step.risk]">{{ riskText(step) }}</span>
                      <ChevronDown v-if="expandedSteps.includes(`history-${round.id}-${step.id}`)" :size="15" />
                      <ChevronRight v-else :size="15" />
                    </button>
                    <div v-if="expandedSteps.includes(`history-${round.id}-${step.id}`)" class="step-detail">
                      <label>{{ t("agent.command") }}</label><code>{{ step.command }}</code>
                      <label>{{ t("agent.expectedValidation") }}</label><p>{{ step.expected }} · {{ step.validation }}</p>
                      <template v-if="step.result">
                        <label>{{ t("agent.executionObservation") }}</label>
                        <div class="step-result-line">
                          <span :class="['execution-tag', step.result.executionStatus]">{{ executionText(step) }}</span>
                          <span :class="['observation-tag', step.result.observationStatus]">{{ stepObservationText(step) }}</span>
                        </div>
                        <label>{{ t("agent.evidence") }}</label><pre>{{ factsText(step) }}</pre>
                      </template>
                      <template v-if="step.review"><label>{{ t("agent.review") }}</label><p class="review-result">{{ step.review.summary }}（{{ step.review.reason }}）</p></template>
                    </div>
                  </div>
                </div>
              </template>
            </div>

            <div v-if="round.records?.length || round.plan.some((step) => step.output)" class="plan-card execution-record-card">
              <button class="plan-card-head archived-head" @click="toggleRecords(round.id)">
                <span><ListTree :size="15" /><span><strong>{{ t("agent.archivedRecords") }}</strong><small>{{ t("agent.recordCount", { count: round.records?.length ?? 0 }) }}</small></span></span>
                <span><ChevronDown v-if="expandedRecords.includes(round.id)" :size="15" /><ChevronRight v-else :size="15" /></span>
              </button>
              <div v-if="expandedRecords.includes(round.id)" class="execution-record-body">
                <div v-for="record in round.records ?? []" :key="record.id" class="execution-event-row">
                  <time>{{ new Date(record.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) }}</time>
                  <span>{{ record.content }}</span>
                </div>
                <div v-for="step in round.plan.filter((item) => item.output)" :key="`output-${step.id}`" class="execution-output">
                  <strong>{{ step.title }}</strong><code>{{ step.command }}</code><pre>{{ step.output }}</pre>
                  <p v-if="step.review" class="execution-review">{{ t("agent.reviewPrefix", { summary: step.review.summary, reason: step.review.reason }) }}</p>
                </div>
              </div>
            </div>

            <div
              v-if="(round.summary || round.pauseReason) && ['completed', 'failed', 'cancelled', 'needs_adjustment'].includes(round.status)"
              :class="['summary-card', 'archived-summary', `summary-${round.status}`]"
            >
              <div class="summary-card-icon">
                <Sparkles v-if="round.status === 'completed'" :size="17" />
                <ShieldAlert v-else-if="['failed', 'needs_adjustment'].includes(round.status)" :size="17" />
                <Square v-else :size="15" />
              </div>
              <div><span>{{ summaryTitle(round.status) }}</span><p>{{ round.summary ?? round.pauseReason }}</p></div>
            </div>
          </template>

          <div
            v-for="message in currentConversationMessages"
            :key="message.id"
            :class="['task-message', message.role, message.kind, { 'user-aligned': message.role === 'user' }]"
          >
            <div v-if="message.role !== 'user'" class="message-avatar">
              <Bot v-if="message.role === 'assistant'" :size="15" />
              <TerminalSquare v-else :size="15" />
            </div>
            <div class="message-body">
              <div class="message-meta">
                <strong>{{ messageAuthor(message.role) }}</strong>
                <time>{{ new Date(message.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) }}</time>
              </div>
              <p>{{ message.content }}</p>
            </div>
          </div>

          <div v-if="task.plan.length" :class="['plan-card', 'current-plan-card', `task-card-${task.status}`]">
            <div class="plan-card-head">
              <span class="plan-title-block">
                <span class="plan-title-line">
                  <LoaderCircle v-if="isBusy" class="spin plan-title-loading" :size="15" />
                  <strong>{{ t("agent.currentPlan") }}</strong>
                  <span v-if="!isBusy" :class="['task-state-pill', task.status]">
                    <Clock3 v-if="task.status.includes('awaiting')" :size="13" />
                    <CheckCircle2 v-else-if="task.status === 'completed'" :size="13" />
                    {{ statusText(task.status) }}
                  </span>
                  <small class="plan-processed">{{ t("agent.processed", { done: task.plan.filter((step) => ["completed", "skipped", "failed"].includes(step.status)).length, total: task.plan.length }) }}</small>
                  <button
                    v-if="canTerminate"
                    class="terminate-business"
                    type="button"
                    :title="t('agent.terminateTitle')"
                    @click.stop="store.terminateTask(task.id)"
                  ><Square :size="11" />{{ t("agent.terminate") }}</button>
                </span>
              </span>
            </div>
            <div class="steps">
              <div v-for="(step, index) in task.plan" :key="step.id" :class="['plan-step', step.status]">
                <button class="step-main" @click="toggleStep(step.id)">
                  <span class="step-icon">
                    <CheckCircle2 v-if="step.status === 'completed'" :size="17" />
                    <LoaderCircle v-else-if="['running', 'validating'].includes(step.status)" class="spin" :size="17" />
                    <ShieldAlert v-else-if="step.status === 'awaiting_approval'" :size="17" />
                    <KeyRound v-else-if="step.status === 'awaiting_input'" :size="17" />
                    <Circle v-else :size="17" />
                  </span>
                  <span class="step-copy"><strong>{{ index + 1 }}. {{ step.title }}</strong><small>{{ step.description }}</small></span>
                  <span v-if="step.result" :class="['observation-tag', step.result.observationStatus]">{{ stepObservationText(step) }}</span>
                  <span :class="['risk-tag', step.risk]">{{ riskText(step) }}</span>
                  <ChevronDown v-if="expandedSteps.includes(step.id)" :size="15" />
                  <ChevronRight v-else :size="15" />
                </button>
                <div v-if="expandedSteps.includes(step.id)" class="step-detail">
                  <label>{{ t("agent.willExecute") }}</label><code>{{ step.command }}</code>
                  <label>{{ t("agent.expectedValidation") }}</label><p>{{ step.expected }} · {{ step.validation }}</p>
                  <template v-if="step.result">
                    <label>{{ t("agent.executionObservation") }}</label>
                    <div class="step-result-line">
                      <span :class="['execution-tag', step.result.executionStatus]">{{ executionText(step) }}</span>
                      <span :class="['observation-tag', step.result.observationStatus]">{{ stepObservationText(step) }}</span>
                    </div>
                    <label>{{ t("agent.evidence") }}</label><pre>{{ factsText(step) }}</pre>
                    <p v-if="step.result.warnings.length" class="evidence-warning">{{ step.result.warnings.join("；") }}</p>
                  </template>
                  <template v-if="step.output"><label>{{ t("agent.output") }}</label><pre>{{ step.output }}</pre></template>
                  <p v-if="step.status === 'running' && step.progressMessage" class="step-progress">
                    <LoaderCircle class="spin" :size="13" />{{ step.progressMessage }}
                  </p>
                  <template v-if="step.review"><label>{{ t("agent.review") }}</label><p class="review-result">{{ step.review.summary }}（{{ step.review.reason }}）</p></template>
                </div>
              </div>
            </div>
            <div v-if="task.status === 'awaiting_plan_approval'" class="approval-bar">
              <button class="button secondary" @click="store.rejectTask(task.id)"><Square :size="13" />{{ t("common.cancel") }}</button>
              <button class="button primary" @click="store.approvePlan(task.id)"><Play :size="13" />{{ t("agent.approvePlan") }}</button>
            </div>
            <div v-else-if="pendingApproval" class="approval-bar warning">
              <span><ShieldAlert :size="15" />{{ t("agent.stepApproval") }}</span>
              <button class="button secondary" @click="store.rejectTask(task.id)">{{ t("agent.stop") }}</button>
              <button class="button primary" @click="store.approveStep(task.id, pendingApproval.id)">{{ t("agent.executeStep") }}</button>
            </div>
            <form v-else-if="pendingUserInputRequest" class="user-input-card" @submit.prevent="submitUserInput">
              <div class="user-input-head">
                <span><MessageSquarePlus :size="16" /></span>
                <div>
                  <strong>{{ pendingUserInputRequest.title }}</strong>
                  <small>{{ pendingUserInputRequest.description || t('agent.userInputDefaultDescription') }}</small>
                </div>
              </div>
              <div class="user-input-fields">
                <label v-for="field in pendingUserInputRequest.fields" :key="field.key">
                  <span class="user-input-label">
                    <strong>{{ field.label }}</strong>
                    <i>{{ field.required ? t('agent.requiredParameter') : t('agent.optionalParameter') }}</i>
                  </span>
                  <small>{{ field.description }}</small>
                  <input
                    v-model="userInputValues[field.key]"
                    :type="field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'"
                    :autocomplete="field.type === 'password' ? 'new-password' : 'off'"
                    :placeholder="field.placeholder || t('agent.parameterPlaceholder', { label: field.label })"
                  />
                  <em v-if="field.type === 'password'"><KeyRound :size="11" />{{ t('agent.passwordParameterHint') }}</em>
                </label>
              </div>
              <p v-if="pendingUserInputRequest.error" class="user-input-error">{{ pendingUserInputRequest.error }}</p>
              <div class="user-input-actions">
                <span>{{ t('agent.userInputSecurityHint') }}</span>
                <button class="button primary" type="submit">{{ t('agent.confirmParameters') }}</button>
              </div>
            </form>
            <form v-else-if="pendingSecretRequest" class="secret-input-bar" @submit.prevent="store.provideSecret(secretInput); secretInput = ''">
              <span><KeyRound :size="14" />{{ pendingSecretRequest.key }}</span>
              <input v-model="secretInput" type="password" autocomplete="off" :placeholder="t('agent.secretPlaceholder')" autofocus />
              <button class="button primary" type="submit" :disabled="!secretInput">{{ t("agent.submitSecret") }}</button>
            </form>
            <div v-else-if="task.status === 'needs_adjustment'" class="approval-bar warning">
              <span class="adjustment-copy">
                <ShieldAlert :size="15" />
                <span><strong>{{ adjustmentLabel }}</strong><small v-if="task.pauseReason">{{ task.pauseReason }}</small></span>
              </span>
              <button class="button secondary" @click="store.rejectTask(task.id)">{{ t("agent.endTask") }}</button>
              <button class="button primary" @click="store.requestAdjustment(task.id)">
                {{ t((task.adjustmentCount ?? 0) < 1 ? "agent.adjustOnce" : "agent.adjustAgain") }}
              </button>
            </div>
          </div>

          <div v-if="currentRecords.length || task.plan.some((step) => step.output)" class="plan-card execution-record-card">
            <button class="plan-card-head archived-head" @click="toggleRecords('current')">
              <span><LoaderCircle v-if="isBusy" class="spin execution-record-running" :size="15" /><ListTree v-else :size="15" /><span><strong>{{ t("agent.executionRecord") }}</strong><small>{{ t("agent.recordsHint", { count: currentRecords.length }) }}</small></span></span>
              <span><ChevronDown v-if="expandedRecords.includes('current')" :size="15" /><ChevronRight v-else :size="15" /></span>
            </button>
            <div v-if="expandedRecords.includes('current')" class="execution-record-body">
              <div v-for="record in currentRecords" :key="record.id" :class="['execution-event-row', { active: record.id === activeRecordId }]">
                <time>{{ new Date(record.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) }}</time>
                <span><i v-if="record.id === activeRecordId" class="execution-event-pulse" />{{ record.content }}</span>
              </div>
              <div v-for="step in task.plan.filter((item) => item.output)" :key="`current-output-${step.id}`" class="execution-output">
                <strong>{{ step.title }}</strong><code>{{ step.command }}</code><pre>{{ step.output }}</pre>
                <p v-if="step.review" class="execution-review">{{ t("agent.reviewPrefix", { summary: step.review.summary, reason: step.review.reason }) }}</p>
              </div>
            </div>
          </div>

          <div
            v-if="(task.summary || task.pauseReason) && ['completed', 'failed', 'cancelled', 'needs_adjustment'].includes(task.status)"
            :class="['summary-card', `summary-${task.status}`]"
          >
            <div class="summary-card-icon">
              <Sparkles v-if="task.status === 'completed'" :size="17" />
              <ShieldAlert v-else-if="['failed', 'needs_adjustment'].includes(task.status)" :size="17" />
              <Square v-else :size="15" />
            </div>
            <div><span>{{ summaryTitle(task.status) }}</span><p>{{ task.summary ?? task.pauseReason }}</p></div>
          </div>
        </template>
      </div>

      <form class="composer" @submit.prevent="submit">
        <div v-if="terminalReference" class="context-chip">
          <Quote :size="12" /><span>{{ t("agent.referencedTerminal", { count: terminalReference.split('\n').length }) }}</span>
          <button type="button" @click="terminalReference = ''">×</button>
        </div>
        <textarea
          v-model="input"
          :disabled="Boolean(isBusy)"
          rows="3"
          :placeholder="t(task ? 'agent.continuePlaceholder' : 'agent.newPlaceholder')"
        ></textarea>
        <div class="composer-tools">
          <button class="context-button" type="button" :title="t('agent.referenceTerminal')" @click="referenceTerminal"><Quote :size="13" />{{ t("agent.terminal") }}</button>
          <select v-model="modelId" :title="t('agent.model')" :class="{ 'model-select-empty': !modelId }" @change="handleModelSelection">
            <option v-if="checkingModels" value="" disabled>{{ t("agent.checkingModels") }}</option>
            <option v-else-if="!store.availableModels.length" value="" disabled>{{ t("agent.noModels") }}</option>
            <option
              v-for="model in store.models"
              :key="model.id"
              :value="model.id"
              :disabled="store.modelAvailability[model.id]?.status !== 'available'"
            >{{ modelOptionText(model.id, model.name) }}</option>
            <option value="__manage_models__">{{ t("agent.manageModels") }}</option>
          </select>
          <select v-model="permission" :title="t('agent.permission')">
            <option value="observe">{{ t("agent.permissionObserve") }}</option>
            <option value="safe">{{ t("agent.permissionSafe") }}</option>
            <option value="managed">{{ t("agent.permissionManaged") }}</option>
          </select>
          <button class="send-button" type="submit" :disabled="!input.trim() || Boolean(isBusy) || !modelId"><Send :size="16" /></button>
        </div>
      </form>
    </template>
    <ModelSettingsModal
      :open="showModelSettings"
      @close="showModelSettings = false"
      @saved="handleModelsSaved"
    />
  </section>
</template>
