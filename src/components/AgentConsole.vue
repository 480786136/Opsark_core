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
  X,
  Search,
} from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import type { ObservationStatus, OpsTask, PlanStep, TaskPlanHistory } from "@/types";
import type { PendingUserInput } from "@/features/tools/types";
import AgentExecutionPhase from "@/components/AgentExecutionPhase.vue";
import ModelSettingsModal from "@/components/ModelSettingsModal.vue";
import ParameterSelect from "@/components/ParameterSelect.vue";
import TaskKnowledgeUpload from "@/features/knowledge/TaskKnowledgeUpload.vue";
import { isAdjustmentProgressMessage, isPlanProgressMessage } from "@/features/agent/taskMessages";
import { useAgentWorkspaceStore } from "@/features/agent/agentWorkspaceStore";
import { useWorkspaceLinkStore } from "@/features/workspace/workspaceLinkStore";
import { conversationHistoryRounds } from "@/features/agent/conversationHistory";
import { localizeCoreText } from "@/features/preferences/coreText";

const props = defineProps<{ serverId: string; active?: boolean }>();
const showDevelopmentFeatures = import.meta.env.DEV;
const store = useOpsStore();
const connectionReady = computed(() => store.isServerConnected(props.serverId));
const agentWorkspaces = useAgentWorkspaceStore();
const workspaceLinks = useWorkspaceLinkStore();
const { t, locale } = useI18n();
const taskMenuTrigger = ref<HTMLElement>();
const taskMenu = ref<HTMLElement>();
const workspaceState = agentWorkspaces.ensureServer(props.serverId);
watch(() => props.active, (active) => {
  if (active !== false) agentWorkspaces.updateServer(props.serverId, { activeTaskId: "", showTasks: false });
}, { immediate: true });
const taskQuery = ref("");
const persistedField = <K extends keyof typeof workspaceState>(key: K) => computed({
  get: () => workspaceState[key],
  set: (value: typeof workspaceState[K]) => agentWorkspaces.updateServer(props.serverId, { [key]: value }),
});
const input = persistedField("draft");
const permission = persistedField("permission");
const modelId = persistedField("modelId");
const automationEnabled = persistedField("automationEnabled");
const checkingModels = ref(false);
const submissionError = ref("");
const showModelSettings = ref(false);
const showTasks = persistedField("showTasks");
const expandedSteps = ref<string[]>([]);
const expandedRounds = ref<string[]>([]);
const expandedRecords = ref<string[]>([]);
const terminalReference = ref("");
const secretInput = ref("");
const userInputValues = ref<Record<string, string>>({});
const submittingUserInputs = ref(new Set<PendingUserInput>());
const submittingApprovals = ref(new Set<string>());
const timeline = ref<HTMLElement>();
const pendingFreshRequirement = ref("");
const modelOptions = computed(() => [
  ...store.models.map((model) => ({
    value: model.id,
    label: modelOptionText(model.id, model.name),
    disabled: store.modelAvailability[model.id]?.status !== "available",
  })),
  { value: "__manage_models__", label: t("agent.manageModels") },
]);
const modelPlaceholder = computed(() => checkingModels.value
  ? t("agent.checkingModels")
  : !store.availableModels.length ? t("agent.noModels") : t("agent.modelSelectPlaceholder"));
const permissionOptions = computed(() => [
  { value: "observe", label: t("agent.permissionObserve") },
  { value: "safe", label: t("agent.permissionSafe") },
  { value: "managed", label: t("agent.permissionManaged") },
]);
const coreText = (value?: string | null) => localizeCoreText(value, locale.value);

const serverTasks = computed(() => store.tasks.filter((task) => task.serverId === props.serverId));
const task = computed(() => serverTasks.value.find((item) => item.id === workspaceState.activeTaskId));
const filteredTasks = computed(() => serverTasks.value.filter(item => item.title.toLowerCase().includes(taskQuery.value.toLowerCase())));
const conversationRounds = computed(() => task.value ? conversationHistoryRounds(serverTasks.value, task.value) : []);
const canApprovePlan = computed(() => Boolean(task.value
  && task.value.status === "awaiting_plan_approval"
  && !task.value.cancelRequested
  && !task.value.adjustmentInProgress));
const pendingApproval = computed(() => task.value?.status === "awaiting_step_approval"
  && !task.value.cancelRequested && !task.value.adjustmentInProgress
  ? task.value.plan.find((step) => step.status === "awaiting_approval")
  : undefined);
const failedStep = computed(() => task.value?.plan.find((step) => step.status === "failed"));
const adjustmentLabel = computed(() =>
  task.value?.status === "awaiting_continuation"
    ? t("agent.continuationRequired")
    : task.value?.protocolRepair
    ? t("agent.planAdjustmentPaused")
    : !failedStep.value && /(?:调整|后续)计划生成失败|计划生成未通过/.test(task.value?.pauseReason ?? "")
    ? t("agent.planAdjustmentPaused")
    : failedStep.value?.result?.executionStatus === "failed"
    ? t("agent.executionPaused")
    : t("agent.validationPaused"),
);
const pendingSecretRequest = computed(() =>
  store.pendingSecret?.taskId === task.value?.id ? store.pendingSecret : undefined,
);
const pendingUserInputRequest = computed(() => {
  const current = task.value;
  if (!current || current.status !== "awaiting_input" || current.cancelRequested || current.adjustmentInProgress) return undefined;
  return store.pendingUserInputs.find((request) => {
    const step = current.plan.find((item) => item.id === request.stepId);
    return request.taskId === current.id && step?.status === "awaiting_input"
      && (request.roundId === undefined || request.roundId === current.currentRoundId)
      && (request.workflowEpoch === undefined || request.workflowEpoch === (current.workflowEpoch ?? 0))
      && (request.serverId === undefined || request.serverId === (current.executionTargetServerId || current.serverId))
      && (request.command === undefined || request.command === step.command);
  });
});
const isSubmittingUserInput = computed(() => Boolean(pendingUserInputRequest.value
  && submittingUserInputs.value.has(pendingUserInputRequest.value)));
const isUserInputIncomplete = computed(() => pendingUserInputRequest.value?.fields.some((field) => {
  const value = String(userInputValues.value[field.key] ?? "");
  return (field.required && !value.trim())
    || (field.type === "select" && Boolean(value) && !field.options?.some((option) => option.value === value));
}));
const hasCredentialUserInput = computed(() => pendingUserInputRequest.value?.fields.some((field) =>
  field.type === "password" || Boolean(field.credential)));
const approvalKey = computed(() => task.value && (canApprovePlan.value || pendingApproval.value)
  ? JSON.stringify([task.value.id, task.value.currentRoundId, task.value.workflowEpoch, pendingApproval.value?.id ?? null])
  : undefined);
const isSubmittingApproval = computed(() => Boolean(approvalKey.value && submittingApprovals.value.has(approvalKey.value)));
const isBusy = computed(() => task.value && (
  task.value.requirementProcessing || task.value.adjustmentInProgress
  || ["planning", "running", "validating"].includes(task.value.status)
));
const canTerminate = computed(() =>
  Boolean(task.value && (
    task.value.currentExecutionId
    || ["planning", "running", "validating", "awaiting_input"].includes(task.value.status)
  )),
);
// Persisted incidents describe why a task paused, not whether a recovery worker
// is still running. Only live recovery work should keep the console spinning.
const hasTransportRecovery = computed(() => Boolean(task.value && (
  task.value.adjustmentIncident?.kind === "transport"
  || task.value.managedAdjustmentPhase === "waiting_transport"
  || task.value.managedStopReason === "transport_recovery"
)));
const isWaitingForTerminalRecovery = computed(() => Boolean(task.value
  && hasTransportRecovery.value
  && task.value.managedAdjustmentPhase !== "manual_required"
  && store.transportRecoveryTaskIds.includes(task.value.id)));
const needsTransportRecoveryCheck = computed(() => hasTransportRecovery.value
  && !isWaitingForTerminalRecovery.value
  && !task.value?.adjustmentInProgress
  && task.value?.managedAdjustmentPhase !== "generating");
const showManualAdjustmentButton = computed(() => Boolean(task.value && (
  task.value.permission !== "managed"
  || task.value.managedAdjustmentPhase === "manual_required"
  || needsTransportRecoveryCheck.value
)));
const canRequestAdjustment = computed(() => Boolean(task.value
  && ["needs_adjustment", "awaiting_continuation"].includes(task.value.status)
  && showManualAdjustmentButton.value
  && (!task.value.autoAdjustmentSeconds || needsTransportRecoveryCheck.value)
  && !task.value.adjustmentInProgress
  && task.value.managedAdjustmentPhase !== "generating"
  && !isWaitingForTerminalRecovery.value));
const needsUserAction = computed(() => Boolean(
  canApprovePlan.value
  || pendingApproval.value
  || pendingUserInputRequest.value
  || pendingSecretRequest.value
  || task.value?.status === "planning_failed"
  || canRequestAdjustment.value
));

async function requestTaskAdjustment() {
  if (!task.value || !canRequestAdjustment.value) return;
  if (needsTransportRecoveryCheck.value) {
    await store.routeAutomaticAdjustment(task.value.id, { transportRecovery: true });
  } else {
    await store.requestAdjustment(task.value.id);
  }
}

function planProgressText(current: OpsTask) {
  const completed = current.plan.filter((step) => step.status === "completed").length;
  const safetyBlocked = current.plan.filter((step) => (
    step.status === "failed" && step.result?.facts.category === "plan_safety_rejection"
  )).length;
  if (safetyBlocked) {
    const pending = current.plan.filter((step) => ["pending", "awaiting_approval", "awaiting_input"].includes(step.status)).length;
    return t("agent.safetyProgress", { completed, blocked: safetyBlocked, pending });
  }
  const processed = current.plan.filter((step) => ["completed", "skipped", "failed"].includes(step.status)).length;
  return t("agent.processed", { done: processed, total: current.plan.length });
}

function archivedRoundResponse(round: TaskPlanHistory) {
  if (round.response?.content) return coreText(round.response.content);
  return round.plan.length
    ? t("agent.generatedSteps", { count: round.plan.length })
    : t("agent.planGenerationIncomplete");
}

function archivedFinalPlan(round: TaskPlanHistory) {
  if (round.finalPlan) return round.finalPlan;
  const phaseStepIds = new Set((round.phases ?? []).flatMap((phase) => phase.plan.map((step) => step.id)));
  return round.plan.filter((step) => !phaseStepIds.has(step.id));
}

function conversationMessageContent(content: string) {
  return isAdjustmentProgressMessage(content) ? t("agent.nextPhaseReady") : content;
}

watch(() => [task.value?.id, task.value?.currentRoundId, pendingUserInputRequest.value], () => {
  userInputValues.value = {};
}, { flush: "sync" });

async function submitUserInput() {
  const current = task.value;
  const request = pendingUserInputRequest.value;
  if (!current || !request || submittingUserInputs.value.has(request) || isUserInputIncomplete.value) return;
  const values = userInputValues.value;
  const roundId = current.currentRoundId;
  submittingUserInputs.value.add(request);
  try {
    const submitted = await store.provideUserInput(current.id, { ...values }, request.callId);
    if (submitted && task.value === current && task.value.currentRoundId === roundId
      && pendingUserInputRequest.value === request && userInputValues.value === values) {
      userInputValues.value = {};
    }
  } finally {
    submittingUserInputs.value.delete(request);
  }
}

async function submitApproval() {
  const current = task.value;
  const key = approvalKey.value;
  const step = pendingApproval.value;
  if (!current || !key || submittingApprovals.value.has(key)) return;
  submittingApprovals.value.add(key);
  try {
    if (step) await store.approveStep(current.id, step.id);
    else if (canApprovePlan.value) await store.approvePlan(current.id);
  } finally {
    submittingApprovals.value.delete(key);
  }
}

async function submitSecret() {
  if (!secretInput.value) return;
  const submitted = await store.provideSecret(secretInput.value);
  if (submitted) secretInput.value = "";
}
const currentConversationMessages = computed(() => {
  if (!task.value) return [];
  const start = task.value.messages
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === "user" && message.kind === "message")?.index ?? 0;
  const messages = task.value.messages.slice(start).filter((message) => message.kind === "message");
  let latestPlanProgressIndex = -1;
  messages.forEach((message, index) => {
    if (isPlanProgressMessage(message.content)) latestPlanProgressIndex = index;
  });
  return messages.filter((message, index) => (
    !isPlanProgressMessage(message.content) || index === latestPlanProgressIndex
  ));
});
const currentPhases = computed(() => pendingFreshRequirement.value ? [] : (task.value?.phaseHistory ?? [])
  .filter((phase) => phase.roundId === task.value?.currentRoundId));
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
const currentRecordPreview = computed(() => currentRecords.value.slice(-3));

type SummaryBlock =
  | { type: "heading" | "paragraph"; text: string }
  | { type: "list"; items: string[] };

function summaryBlocks(value?: string): SummaryBlock[] {
  const lines = (value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const blocks: SummaryBlock[] = [];
  let listItems: string[] = [];
  const flushList = () => {
    if (!listItems.length) return;
    blocks.push({ type: "list", items: listItems });
    listItems = [];
  };
  for (const line of lines) {
    const listMatch = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/u);
    if (listMatch) { listItems.push(listMatch[1]); continue; }
    flushList();
    const headingMatch = line.match(/^#{1,4}\s+(.+)$/u);
    const labelledHeading = line.match(/^([^:：]{2,12})[:：]\s*$/u);
    if (headingMatch || labelledHeading) {
      blocks.push({ type: "heading", text: headingMatch?.[1] ?? labelledHeading?.[1] ?? line });
    } else {
      blocks.push({ type: "paragraph", text: line });
    }
  }
  flushList();
  return blocks.length ? blocks : [{ type: "paragraph", text: value || "-" }];
}

watch(needsUserAction, (awaitingUser) => {
  if (awaitingUser) {
    expandedRecords.value = expandedRecords.value.filter((id) => id !== "current");
  }
}, { immediate: true });

watch(
  () => [task.value?.messages.length, task.value?.plan.length, task.value?.phaseHistory?.length, task.value?.status],
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
  submissionError.value = "";
  showTasks.value = false;
  let selectedTask = task.value;
  if (!selectedTask) {
    selectedTask = store.createTask(props.serverId, permission.value, modelId.value);
    agentWorkspaces.updateServer(props.serverId, { activeTaskId: selectedTask.id });
  }
  const startsAfterFinishedTask = ["completed", "failed", "cancelled"].includes(selectedTask.status);
  if (startsAfterFinishedTask) {
    pendingFreshRequirement.value = value;
  }
  input.value = "";
  try {
    await store.submitRequirement(
      props.serverId,
      value,
      permission.value,
      modelId.value,
      terminalReference.value,
      selectedTask.id,
    );
    if (store.activeTaskId && store.activeTaskId !== workspaceState.activeTaskId) {
      agentWorkspaces.updateServer(props.serverId, { activeTaskId: store.activeTaskId });
    }
  } catch (error) {
    if (!input.value) input.value = value;
    submissionError.value = error instanceof Error ? error.message : String(error);
    return;
  } finally {
    pendingFreshRequirement.value = "";
  }
  terminalReference.value = "";
}

async function retryPlanning() {
  const current = task.value;
  if (!current) return;
  input.value = current.currentInstruction
    || current.rootGoal
    || [...current.messages].reverse().find((message) => message.role === "user")?.content
    || "";
  await submit();
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

function handleModelSelection(value: string) {
  if (value !== "__manage_models__") {
    modelId.value = value;
    return;
  }
  showModelSettings.value = true;
  selectFirstAvailableModel();
}

function handlePermissionSelection(value: string) {
  if (["observe", "safe", "managed"].includes(value)) {
    permission.value = value as "observe" | "safe" | "managed";
  }
}

function modelOptionText(modelIdValue: string, name: string) {
  const availability = store.modelAvailability[modelIdValue];
  if (availability?.status === "available") return `${name} · ${t("agent.modelAvailable")}`;
  if (availability?.status === "checking") return `${name} · ${t("agent.modelChecking")}`;
  return `${name} · ${availability?.reason ? coreText(availability.reason) : t("agent.modelUnavailable")}`;
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
    planning_failed: "agent.statusPlanningFailed",
    awaiting_plan_approval: "agent.statusAwaitingPlan",
    running: "agent.statusRunning",
    awaiting_step_approval: "agent.statusAwaitingStep",
    awaiting_input: "agent.statusAwaitingInput",
    validating: "agent.statusValidating",
    awaiting_continuation: "agent.statusContinuation",
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
    awaiting_continuation: "agent.summaryContinuation",
    planning_failed: "agent.summaryPlanningFailed",
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
  if (store.deleteTask(item.id)) startNewTask();
}

function selectTaskItem(taskId: string) {
  store.selectTask(taskId);
  agentWorkspaces.updateServer(props.serverId, { activeTaskId: taskId, showTasks: false });
}

function startNewTask() {
  agentWorkspaces.updateServer(props.serverId, { activeTaskId: "", showTasks: false });
  input.value = "";
  terminalReference.value = "";
  taskQuery.value = "";
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
        <span class="agent-title-copy"><strong>{{ t("agent.title") }}</strong><small v-if="pendingFreshRequirement" :title="pendingFreshRequirement">{{ t("agent.recognizingRequirement", { requirement: pendingFreshRequirement }) }}</small><small v-else-if="task" :title="task.title">{{ task.title }}</small></span>
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
      <div v-if="showTasks" ref="taskMenu" class="task-strip" @keydown.esc.stop="showTasks = false">
        <header class="task-strip-head">
          <span class="task-strip-heading"><History :size="14" /><span><strong>{{ t("agent.taskListTitle") }}</strong><small>{{ t("agent.taskListHint") }}</small></span></span>
          <strong>{{ serverTasks.length }}</strong>
          <button class="icon-button" type="button" :aria-label="t('agent.closeTaskList')" @click="showTasks = false"><X :size="14"/></button>
        </header>
        <label class="task-menu-search"><Search :size="14"/><input v-model="taskQuery" :aria-label="t('agent.searchTasks')" :placeholder="t('agent.searchTasks')"/></label>
        <div class="task-strip-list">
        <TransitionGroup name="task-list">
        <div v-for="item in filteredTasks" :key="item.id" :class="['task-strip-item', item.status, { active: item.id === task?.id }]">
          <button class="task-select" :title="item.title" @click="selectTaskItem(item.id)">
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
        <div v-else-if="!filteredTasks.length" class="task-strip-empty">{{ t("agent.noMatchingTasks") }}</div>
        </div>
        <button class="new-task" @click="startNewTask"><MessageSquarePlus :size="14" />{{ t("agent.newTask") }}</button>
      </div>
      </Transition>

      <div ref="timeline" class="agent-timeline">
        <TaskKnowledgeUpload v-if="showDevelopmentFeatures && task && !pendingFreshRequirement" :key="task.id" :task="task" />
        <div v-if="!task" class="empty-agent">
          <div class="mini-orb"><Bot :size="22" /></div>
          <h3>{{ t("agent.emptyTitle") }}</h3>
          <p>{{ t("agent.emptyHint") }}</p>
          <button @click="input = t('agent.requestSystem')">{{ t("agent.suggestSystem") }}</button>
          <button @click="input = t('agent.requestDisk')">{{ t("agent.suggestDisk") }}</button>
        </div>

        <template v-else>
          <template v-for="round in conversationRounds" :key="round.id">
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
                <p>{{ archivedRoundResponse(round) }}</p>
              </div>
            </div>

            <AgentExecutionPhase
              v-for="(phase, phaseIndex) in round.phases ?? []"
              :key="phase.id"
              :phase="phase"
              :index="phaseIndex + 1"
            />

            <div v-if="archivedFinalPlan(round).length" :class="['plan-card', 'archived-plan', `task-card-${round.status}`]">
              <button class="plan-card-head archived-head" @click="toggleRound(round.id)">
                <span>
                  <ClipboardCheck :size="15" />
                  <span>
                    <strong>{{ round.phases?.length ? t("agent.finalPhasePlan", { index: round.phases.length + 1 }) : t("agent.archivedPlan") }}</strong>
                    <small>{{ round.requirement }}</small>
                  </span>
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
                  <div v-for="(step, index) in archivedFinalPlan(round)" :key="step.id" :class="['plan-step', step.status]">
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
                      <label>{{ t("agent.expectedValidation") }}</label><p>{{ step.expected }} · {{ step.kind === "observe" ? t("agent.commandResultEvidence") : step.validation }}</p>
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
                  <span>{{ coreText(record.content) }}</span>
                </div>
                <div v-for="step in round.plan.filter((item) => item.output)" :key="`output-${step.id}`" class="execution-output">
                  <strong>{{ step.title }}</strong><code>{{ step.command }}</code><pre>{{ step.output }}</pre>
                  <p v-if="step.review" class="execution-review">{{ t("agent.reviewPrefix", { summary: step.review.summary, reason: step.review.reason }) }}</p>
                </div>
              </div>
            </div>

            <div
              v-if="(round.summary || round.pauseReason) && ['completed', 'failed', 'cancelled', 'needs_adjustment', 'awaiting_continuation', 'planning_failed'].includes(round.status)"
              :class="['summary-card', 'archived-summary', `summary-${round.status}`]"
            >
              <div class="summary-card-icon">
                <Sparkles v-if="round.status === 'completed'" :size="17" />
                <ShieldAlert v-else-if="['failed', 'needs_adjustment', 'awaiting_continuation', 'planning_failed'].includes(round.status)" :size="17" />
                <Square v-else :size="15" />
              </div>
              <div class="summary-card-content">
                <span class="summary-eyebrow">{{ summaryTitle(round.status) }}</span>
                <div class="summary-content">
                  <template v-for="(block, index) in summaryBlocks(coreText(round.summary ?? round.pauseReason))" :key="index">
                    <h4 v-if="block.type === 'heading'">{{ block.text }}</h4>
                    <ul v-else-if="block.type === 'list'"><li v-for="item in block.items" :key="item">{{ item }}</li></ul>
                    <p v-else>{{ block.text }}</p>
                  </template>
                </div>
              </div>
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
              <p>{{ conversationMessageContent(message.content) }}</p>
            </div>
          </div>

          <AgentExecutionPhase
            v-for="(phase, phaseIndex) in currentPhases"
            :key="phase.id"
            :phase="phase"
            :index="phaseIndex + 1"
          />

          <div v-if="(task.plan.length || hasTransportRecovery || needsUserAction) && !pendingFreshRequirement" :class="['plan-card', 'current-plan-card', `task-card-${task.status}`]">
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
                  <small class="plan-processed">{{ planProgressText(task) }}</small>
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
                    <ShieldAlert v-else-if="step.status === 'awaiting_approval' || step.result?.facts.category === 'plan_safety_rejection'" :size="17" />
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
                  <label>{{ t("agent.expectedValidation") }}</label><p>{{ step.expected }} · {{ step.kind === "observe" ? t("agent.commandResultEvidence") : step.validation }}</p>
                  <template v-if="step.protocolReplanApproval">
                    <label>{{ t('agent.replanDecisionReview') }}</label>
                    <p>{{ step.protocolReplanApproval.decisionSummary }}</p>
                    <p class="evidence-warning">{{ t('agent.replanApprovalNotice') }}</p>
                  </template>
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
                    <LoaderCircle class="spin" :size="13" />{{ coreText(step.progressMessage) }}
                  </p>
                  <template v-if="step.review"><label>{{ t("agent.review") }}</label><p class="review-result">{{ t("agent.reviewDetails", { summary: step.review.summary, reason: step.review.reason }) }}</p></template>
                </div>
              </div>
            </div>
            <div v-if="canApprovePlan" class="approval-bar">
              <button class="button secondary" @click="store.rejectTask(task.id)"><Square :size="13" />{{ t("common.cancel") }}</button>
              <button class="button primary" :disabled="isSubmittingApproval" @click="submitApproval"><Play :size="13" />{{ t("agent.approvePlan") }}</button>
            </div>
            <div v-else-if="pendingApproval" class="approval-bar warning">
              <span><ShieldAlert :size="15" />{{ pendingApproval.authenticationGate?.reason ? coreText(pendingApproval.authenticationGate.reason) : t(pendingApproval.protocolReplanApproval ? 'agent.replanApprovalNotice' : 'agent.stepApproval') }}</span>
              <span v-if="pendingApproval.protocolReplanApproval">{{ pendingApproval.protocolReplanApproval.decisionSummary }}</span>
              <button class="button secondary" @click="store.rejectTask(task.id)">{{ t("agent.stop") }}</button>
              <button class="button primary" :disabled="isSubmittingApproval" @click="submitApproval">{{ t("agent.executeStep") }}</button>
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
                <component
                  :is="field.type === 'select' ? 'div' : 'label'"
                  v-for="field in pendingUserInputRequest.fields"
                  :key="field.key"
                  :class="{ 'user-input-select-field': field.type === 'select' }"
                >
                  <span class="user-input-label">
                    <strong>{{ field.label }}</strong>
                    <i>{{ field.required ? t('agent.requiredParameter') : t('agent.optionalParameter') }}</i>
                  </span>
                  <small>{{ field.description }}</small>
                  <ParameterSelect
                    v-if="field.type === 'select'"
                    :model-value="userInputValues[field.key] ?? ''"
                    :options="field.options ?? []"
                    :ariaLabel="field.label"
                    :placeholder="field.placeholder || t('agent.parameterSelectPlaceholder', { label: field.label })"
                    :required="field.required"
                    :clearable="!field.required"
                    :clear-label="t('common.clear')"
                    :disabled="isSubmittingUserInput"
                    @update:model-value="userInputValues[field.key] = $event"
                  />
                  <input
                    v-else
                    v-model="userInputValues[field.key]"
                    :type="field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'"
                    :autocomplete="field.type === 'password' ? 'new-password' : 'off'"
                    :placeholder="field.placeholder || t('agent.parameterPlaceholder', { label: field.label })"
                    :disabled="isSubmittingUserInput"
                    :required="field.required"
                  />
                  <em v-if="field.type === 'password'"><KeyRound :size="11" />{{ t('agent.passwordParameterHint') }}</em>
                </component>
              </div>
              <p v-if="pendingUserInputRequest.error" class="user-input-error">{{ coreText(pendingUserInputRequest.error) }}</p>
              <div class="user-input-actions">
                <span v-if="hasCredentialUserInput">{{ t('agent.userInputSecurityHint') }}</span>
                <button class="button primary" type="submit" :disabled="isSubmittingUserInput || isUserInputIncomplete">{{ t('agent.confirmParameters') }}</button>
              </div>
            </form>
            <form v-else-if="pendingSecretRequest" class="secret-unlock-card" @submit.prevent="submitSecret">
              <div class="secret-unlock-head">
                <span><KeyRound :size="16" /></span>
                <div>
                  <strong>{{ pendingSecretRequest.label }}</strong>
                  <small>{{ pendingSecretRequest.description }}</small>
                </div>
                <code>{{ pendingSecretRequest.key }}</code>
              </div>
              <label class="secret-unlock-input">
                <span>{{ t('agent.secretValueLabel') }}</span>
                <input v-model="secretInput" type="password" autocomplete="new-password" :placeholder="t('agent.secretPlaceholder')" autofocus />
              </label>
              <p v-if="pendingSecretRequest.error" class="user-input-error">{{ coreText(pendingSecretRequest.error) }}</p>
              <div class="secret-unlock-actions">
                <span><ShieldAlert :size="13" />{{ pendingSecretRequest.unlockDescription }}</span>
                <button class="button primary" type="submit" :disabled="!secretInput">{{ t("agent.submitSecret") }}</button>
              </div>
            </form>
            <div v-else-if="task.status === 'planning_failed'" class="approval-bar warning">
              <span class="adjustment-copy">
                <ShieldAlert :size="15" />
                <span><strong>{{ t("agent.summaryPlanningFailed") }}</strong><small v-if="task.pauseReason">{{ coreText(task.pauseReason) }}</small></span>
              </span>
              <button class="button secondary" @click="store.rejectTask(task.id)">{{ t("agent.endTask") }}</button>
              <button class="button primary" @click="retryPlanning">{{ t("agent.retryPlanning") }}</button>
            </div>
            <div v-else-if="['needs_adjustment', 'awaiting_continuation'].includes(task.status)" class="approval-bar warning">
              <span class="adjustment-copy">
                <ShieldAlert :size="15" />
                <span><strong>{{ adjustmentLabel }}</strong><small v-if="task.pauseReason">{{ coreText(task.pauseReason) }}</small></span>
              </span>
              <button class="button secondary" @click="store.rejectTask(task.id)">{{ t(task.protocolRepair ? "agent.keepResultsAndEnd" : "agent.endTask") }}</button>
              <span v-if="isWaitingForTerminalRecovery" class="managed-approval-countdown">
                <LoaderCircle class="spin" :size="13" />{{ t('agent.waitingTerminalRecovery') }}
              </span>
              <span v-else-if="task.autoAdjustmentSeconds && !needsTransportRecoveryCheck" class="managed-approval-countdown">
                <LoaderCircle class="spin" :size="13" />{{ t('agent.managedAdjustmentCountdown', { seconds: task.autoAdjustmentSeconds }) }}
              </span>
              <span v-else-if="task.adjustmentInProgress || task.managedAdjustmentPhase === 'generating'" class="managed-approval-countdown">
                <LoaderCircle class="spin" :size="13" />{{ t('agent.generatingAdjustment') }}
              </span>
              <span v-else-if="task.permission === 'managed' && !showManualAdjustmentButton" class="managed-approval-countdown">
                <LoaderCircle class="spin" :size="13" />{{ t('agent.managedAutoContinuing') }}
              </span>
              <button v-else-if="canRequestAdjustment" class="button primary" @click="requestTaskAdjustment">
                {{ t(needsTransportRecoveryCheck ? 'agent.checkTerminalRecovery' : task.protocolRepair ? 'agent.generateBusinessReplan' : 'agent.generateAdjustment') }}
              </button>
            </div>
          </div>

          <div v-if="currentRecords.length || task.plan.some((step) => step.output)" class="plan-card execution-record-card">
            <button class="plan-card-head archived-head" @click="toggleRecords('current')">
              <span><LoaderCircle v-if="isBusy" class="spin execution-record-running" :size="15" /><ListTree v-else :size="15" /><span><strong>{{ t("agent.executionRecord") }}</strong><small>{{ t("agent.recordsHint", { count: currentRecords.length }) }}</small></span></span>
              <span><ChevronDown v-if="expandedRecords.includes('current')" :size="15" /><ChevronRight v-else :size="15" /></span>
            </button>
            <div v-if="!expandedRecords.includes('current') && currentRecordPreview.length" class="execution-record-preview">
              <div v-for="record in currentRecordPreview" :key="`preview-${record.id}`" :class="['execution-preview-row', { active: record.id === activeRecordId }]">
                <i></i><span>{{ coreText(record.content) }}</span><time>{{ new Date(record.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) }}</time>
              </div>
            </div>
            <div v-if="expandedRecords.includes('current')" class="execution-record-body">
              <div v-for="record in currentRecords" :key="record.id" :class="['execution-event-row', { active: record.id === activeRecordId }]">
                <time>{{ new Date(record.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) }}</time>
                <span><i v-if="record.id === activeRecordId" class="execution-event-pulse" />{{ coreText(record.content) }}</span>
              </div>
              <div v-for="step in task.plan.filter((item) => item.output)" :key="`current-output-${step.id}`" class="execution-output">
                <strong>{{ step.title }}</strong><code>{{ step.command }}</code><pre>{{ step.output }}</pre>
                <p v-if="step.review" class="execution-review">{{ t("agent.reviewPrefix", { summary: step.review.summary, reason: step.review.reason }) }}</p>
              </div>
            </div>
          </div>

          <div
            v-if="(task.summary || task.pauseReason) && ['completed', 'failed', 'cancelled', 'needs_adjustment', 'awaiting_continuation', 'planning_failed'].includes(task.status)"
            :class="['summary-card', `summary-${task.status}`]"
          >
            <div class="summary-card-icon">
              <Sparkles v-if="task.status === 'completed'" :size="17" />
              <ShieldAlert v-else-if="['failed', 'needs_adjustment', 'awaiting_continuation', 'planning_failed'].includes(task.status)" :size="17" />
              <Square v-else :size="15" />
            </div>
            <div class="summary-card-content">
              <span class="summary-eyebrow">{{ summaryTitle(task.status) }}</span>
              <div class="summary-content">
                <template v-for="(block, index) in summaryBlocks(coreText(task.summary ?? task.pauseReason))" :key="index">
                  <h4 v-if="block.type === 'heading'">{{ block.text }}</h4>
                  <ul v-else-if="block.type === 'list'"><li v-for="item in block.items" :key="item">{{ item }}</li></ul>
                  <p v-else>{{ block.text }}</p>
                </template>
              </div>
            </div>
          </div>
        </template>
      </div>

      <form class="composer" @submit.prevent="submit">
        <p v-if="submissionError" class="agent-connection-hint" role="alert">{{ coreText(submissionError) }} · {{ t("agent.draftPreserved") }}</p>
        <div v-if="terminalReference" class="context-chip">
          <Quote :size="12" /><span>{{ t("agent.referencedTerminal", { count: terminalReference.split('\n').length }) }}</span>
          <button type="button" @click="terminalReference = ''">×</button>
        </div>
        <textarea
          v-model="input"
          :disabled="Boolean(isBusy) || !connectionReady"
          rows="3"
          :placeholder="t(task ? 'agent.continuePlaceholder' : 'agent.newPlaceholder')"
        ></textarea>
        <div class="composer-tools">
          <button class="context-button" type="button" :title="t('agent.referenceTerminal')" @click="referenceTerminal"><Quote :size="13" />{{ t("agent.terminal") }}</button>
          <ParameterSelect
            class="composer-model-select"
            :model-value="modelId"
            :options="modelOptions"
            :ariaLabel="t('agent.model')"
            :title="t('agent.model')"
            :placeholder="modelPlaceholder"
            :popup-min-width="280"
            size="compact"
            @update:model-value="handleModelSelection"
          />
          <ParameterSelect
            class="composer-permission-select"
            :model-value="permission"
            :options="permissionOptions"
            :ariaLabel="t('agent.permission')"
            :title="t('agent.permission')"
            size="compact"
            @update:model-value="handlePermissionSelection"
          />
          <button class="send-button" type="submit" :disabled="!input.trim() || Boolean(isBusy) || !modelId || !connectionReady" :title="connectionReady ? undefined : t('agent.sshReconnectRequired')"><Send :size="16" /></button>
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

<style scoped>
.user-input-select-field { min-width: 0; display: grid; align-content: start; gap: 5px; }
.user-input-select-field > small { min-height: 2.7em; color: var(--muted); font-size: 7.5px; line-height: 1.35; }
.user-input-select-field :deep(summary) { height: 32px; padding: 0 9px; border-radius: 4px; background: var(--surface); font-size: 8px; }
.user-input-select-field :deep(.parameter-options) { position: static; margin-top: 5px; font-size: 8px; }
.user-input-actions .button { margin-left: auto; }
</style>
