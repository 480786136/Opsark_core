import { currentRequestCompleted, TaskEvidenceError } from "@/features/agent/taskDecisionResolution";
import { activateRequirementReviewForRetry, applyTaskRequirementUpdate, appendLegacyTaskRequirement, mergeRequirementExecutionConstraints } from "@/features/agent/taskRequirements";
import { archiveTasks, preserveContinuedLegacyTask, listTaskArchives, markTaskArchived, readTaskArchive } from "@/services/taskArchive";
import type { TaskArchiveEntry } from "@/services/taskArchive";
import type { ExecutionLedgerRecovery } from "@/features/agent/executionLedgerRecovery";
import type { ExecutionTargetRef } from "@/types";
import { buildOperationsCommand, parseOperationsOutput } from "@/features/tools/operationsInspection";
import { MODEL_PLAN_CONTRACT_REVISION, modelIntegrationConfig } from "@/features/agent/modelIntegration";
import { directExecutionLedgerOwner } from "@/services/directExecutionLedger";
import { ExecutionLedgerError, deriveExecutionAttemptReview, acknowledgeExecutionAttempt, runRecordedExecution, listExecutionLedger, cancelExecutionLedger, flushPendingReceipts, pendingExecutionReceipts, resolveExecutionOperation } from "@/services/executionLedger";
import { readTaskProjection, isUntouchedRecoveryShell, executionRecordTitle, executionReceiptSteps, readExecutionLedger, projectExecutionLedgerRecovery, buildReadOnlyReconciliation } from "@/features/agent/executionLedgerRecovery";
import { ToolExecutionError } from "@/features/tools/toolFailure";
import { stableProtocolValue } from "@/services/planProtocolRepair";
import { executionDigest, preparePlanForApproval } from "@/features/agent/planPreparation";
import type { ExecutionIntentSnapshot, PreparedPlan } from "@/types";
import { effectiveToolSemanticContract, prepareFinalToolArguments, resolveUniqueServer, resolveUniqueServerEndpoint } from "@/features/tools/toolPreparation";
import { createModelRecoveryContext, isExplicitModelPlanningRetryable, isModelRecoveryScopeRejection } from "@/services/modelRecovery";
import { assertToolStepBoundary, hasToolStepBoundaryConflict, stepOperationText, ToolStepBoundaryError } from "@/features/agent/stepAction";
import { validateModelConfiguration } from "@/features/agent/modelCapabilities";
import { defineStore } from "pinia";
import { useAccountStore } from "@/features/account/accountStore";
import { textFingerprint } from "@/features/agent/longRunningReviewOutput";
import { watch } from "vue";
import { useConnectionStore, isConnectionTransportFailure } from "@/features/connection/connectionStore";
import { modelLogContext } from "@/features/agent/modelLogContext";
import { requirementConversationContext, restoreConversationLinks } from "@/features/agent/conversationHistory";
import { archiveToolEvidence } from "@/features/agent/evidenceArchive";
import { StaleWorkflowError, workflowLifetime } from "@/features/agent/workflowLifetime";
import { restoreUserInputRequests } from "@/features/agent/restoreUserInputRequests";
import { automaticContinuationStop, renewAutomaticPhaseBudget, workflowProgress } from "@/features/agent/workflowProgress";
import { failureDependencyBlocker, holdFailureDependents } from "@/features/agent/failureDisposition";
import { reconciliationBlocker, recordExecutionUncertainty, retryBlocker } from "@/features/agent/operationalRecovery";
import { toolFailureFallback } from "@/features/agent/toolFallback";
import { assertTaskPlanAuthorization, ExecutionPolicyError, executionPolicyBlocker, recoveryHistory, validateRecoveryReferences } from "@/features/agent/recoveryContract";
import { backend, isTauri, ModelInvocationError, modelServiceError, modelServiceErrorMessage, PlanProtocolError, restoreLegacyPlanProtocolFailure } from "@/services/backend";
import type { RuntimeConnection } from "@/services/backend";
import {
  classifyStepResult,
  normalizeStepValidation,
} from "@/features/agent/evidenceReview";
import {
  applyCommandFailure,
  applyValidatedStepResult,
} from "@/features/agent/commandStepResult";
import { resolveInteractivePtyCredential } from "@/features/agent/interactiveSshCredential";
import {
  allocateCredentialPairKeys,
  collectServerCredentialGroups,
  credentialUsernameValidationError,
  findMatchingCredentialGroup,
  inferCredentialInputPair,
  normalizeCredentialStorageKey,
} from "@/features/agent/serverCredentialGroup";
import { applyPeriodicReviewAdjustment } from "@/features/agent/reviewCoordination";
import { observationBoundary } from "@/features/agent/observationBoundary";
import { commandExecutionScope, restoreCommandEvidenceScopes } from "@/features/agent/commandEvidenceScope";
import {
  createToolOverrides,
  parseToolOverrides,
  resetToolDefinition,
  resolveToolRegistry,
} from "@/features/tools/toolRegistry";
import { normalizeToolDefinition, validateToolDefinition } from "@/features/tools/toolValidation";
import {
  executeToolCall as executeRegisteredToolCall,
  parseUserInputArguments,
  parseToolAction,
} from "@/features/tools/toolExecutor";
import { selectPlanningTools } from "@/features/tools/toolContext";
import { taskAttemptContext } from "@/features/agent/attemptState";
import { confirmedInputScope } from "@/features/agent/confirmedUserInputs";
import { authenticationChannelFailure, gitAuthenticationRetryBlocker, repeatedAuthenticationInputBlocker } from "@/features/agent/authenticationRetry";
import { activeProtocolRepair } from "@/features/agent/protocolReplan";
import { refreshProtocolReplanApproval } from "@/features/agent/protocolReplanApproval";
import { requirementExecutionContext } from "@/features/agent/requirementExecutionContext";
import { planningSkills } from "@/features/skills/skillPlanning";
import { retrieveTaskKnowledge, moveTaskKnowledge } from "@/features/knowledge/retrieval";
import {
  buildAgentContext,
  extractKnownExecutionFacts,
  nextStagePolicyFingerprint,
} from "@/features/agent/agentContext";
import { normalizePermissionLevel, requiresStepApproval } from "@/features/agent/approvalPolicy";
import { beginRequirementPlanning, transitionTask, canTransitionTask } from "@/features/agent/taskMachine";
import { transitionStep } from "@/features/agent/stepMachine";
import {
  cancelStep,
  failValidationProtocol,
  failToolCommandParsing,
  failSecretPurposeMismatch,
  failInteractiveCredentialResolution,
  failPlanSafetyCheck,
  resumeStepAfterSecret,
} from "@/features/agent/stepInterruption";
import {
  runToolStepLifecycle,
} from "@/features/agent/toolStepLifecycle";
import {
  applyStepExecutionEntry,
  applyStepExecutionException,
} from "@/features/agent/stepExecutionEntry";
import { createAuditEvent, prependAuditEvent } from "@/features/agent/auditTrail";
import {
  compactDeveloperLogs,
  createDeveloperLog,
  MAX_DEVELOPER_LOGS,
  prependDeveloperLog,
  type DeveloperLogDraft,
} from "@/features/agent/developerLog";
import {
  buildPeriodicReviewAudit,
} from "@/features/agent/reviewAudit";
import {
  latestTaskRequirement,
  resolveTaskProgression,
} from "@/features/agent/taskProgression";
import {
  archiveActivePhase,
  beginRequirementRound,
  capturePreviousRound,
  captureWorkflowState,
  mergeTaskSkillIds,
  normalizeRequirementRelation,
  restoreWorkflowState,
  taskGoal,
  taskRequirementSnapshot,
} from "@/features/agent/taskGoal";
import { initializeTaskHistoryCheckpoint } from "@/features/agent/taskHistoryCheckpoint";
import { isPlanProgressMessage } from "@/features/agent/taskMessages";
import {
  decideTaskNextStage,
  planTaskAdjustment,
  summarizeFailedTask,
} from "@/features/agent/agentService";
import {
  runCommandFailureReviewPipeline,
  runEvidenceReviewPipeline,
} from "@/features/agent/stepReviewPipeline";
import {
  acceptStepApproval,
  acceptPreparedPlanApproval,
  hasCurrentStepApproval,
  stepMatchesExecutionIntent,
  requestStepApproval,
} from "@/features/agent/stepApproval";
import {
  runCommandLifecycle,
  runValidationLifecycle,
} from "@/features/agent/executionLifecycle";
import { freezeCommandExecutionPolicy } from "@/features/agent/executionPolicy";
import { prepareStepExecution } from "@/features/agent/executionPreparation";
import { executeStepCommand, executeStepValidation } from "@/features/agent/executionRunner";
import { authenticationBlocker, authenticationFingerprint, recordAuthentication } from "@/features/agent/authenticationEvidence";
import { credentialGroupContext } from "@/features/agent/serverCredentialGroup";
import { buildShellStartupTransaction } from "@/features/agent/shellStartupConfig";
import { redactExecutionOutput } from "@/features/agent/secretTool";
import { findSecretKeys } from "@/features/agent/secretTool";
import { secretPurposeMismatch } from "@/features/agent/secretPurpose";
import { buildSecretUnlockRequest } from "@/features/agent/secretUnlockPrompt";
import {
  adjustmentFingerprint,
  buildAdjustmentBlockerSnapshot,
  isSameAdjustmentIncident,
  isTerminalTransportFailure,
  isSshConnectionSetupFailure,
  openAdjustmentIncident,
  recordAdjustmentPlan,
  recordAdjustmentExecution,
  type AdjustmentTargetState,
} from "@/features/agent/adjustmentIncident";
import { buildSoftwareCheckCommand, parseSoftwareCheckOutput } from "@/features/tools/softwareCheck";
import {
  buildCommandResultAudit,
  buildValidationResultAudit,
} from "@/features/agent/executionAudit";
import { resolveStepDispatch } from "@/features/agent/executionDispatch";
import type { PlanStepSafetyAnalysis } from "@/features/agent/planSafety";
import {
  appendCommandCompletion,
  appendTerminalBlock,
  appendTerminalStream,
} from "@/features/agent/terminalBuffer";
import {
  appendFirstValidationFailureOutput,
  assembleFinalValidationOutput,
} from "@/features/agent/validationOutput";
import type {
  AiGenerationSettings,
  AuditEvent,
  DeveloperLogEntry,
  Metrics,
  ModelAvailability,
  ModelProfile,
  ModelServiceError,
  OpsTask,
  PermissionLevel,
  PlanStep,
  ServerProfile,
  SecretMetadata,
  SubmittedSecretBinding,
  TaskMessage,
} from "@/types";
import type {
  FileStructureRequest,
  FileStructureResult,
  FileContentRequest,
  FileContentResult,
  ServerFileTransferRequest,
  ServerConnectionLookupRequest,
  ServerConnectionLookupResult,
  ServerConnectRequest,
  ServerConnectResult,
  ToolCall,
  PendingUserInput,
  PendingSecretRequest,
} from "@/features/tools/types";
import { useFileWorkspaceStore } from "@/features/files/fileWorkspaceStore";
import { useAgentWorkspaceStore } from "@/features/agent/agentWorkspaceStore";
import { useAgentTerminalStore } from "@/features/terminal/agentTerminalStore";
import { agentSandboxTerminalV1Enabled } from "@/features/terminal/agentSandboxFeature";
import { mergeAgentSessionContext, normalizePlanStepExecutionScope } from "@/features/agent/executionScope";
import {
  createCustomSkill,
  buildSkillContext,
  normalizeSkillRegistry,
  resetSkillDefinition,
  resolveTaskSkills,
} from "@/features/skills/skillRegistry";
import { validateSkillDefinition } from "@/features/skills/skillValidation";
import { loadOwnedSkills, persistOwnedSkills, enforceSystemSkills, pinTaskSkills } from "@/features/skills/ownedSkills";
import { executionCapabilityBlocker, shellAllowed } from "@/features/tools/executionPermissions";
import { applyOfficialTools } from "@/features/support/officialContent";


const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type ProtocolReplanSource = "manual" | "system_initial" | "system_continuation";
type AutomaticPlanApprovalReason = "managed" | "protocol_replan";
const executionServerId = (task: Pick<OpsTask, "serverId" | "executionTargetServerId">) => (
  task.executionTargetServerId ?? task.serverId
);
let persistTimer: number | undefined;
let credentialHydration: Promise<void> | undefined;
const adjustingTaskIds = new Map<string, ReturnType<typeof workflowLifetime>>();
const explicitModelRetries = new Map<string, ReturnType<typeof workflowLifetime>>();
const managedAdjustmentSchedulers = new Map<string, { requested: boolean; current(): boolean }>();
const recoveringAdjustmentTasks = new WeakMap<OpsTask, ReturnType<typeof workflowLifetime>>();
const resumingTransportTaskIds = new Set<string>();
// Short-lived ownership, not persisted task state. Release before intentionally
// handing off to the next stage; an old finally must not release a newer owner.
const advancingTasks = new WeakMap<OpsTask, ReturnType<typeof workflowLifetime>>();
const executingTaskSteps = new WeakMap<OpsTask, ReturnType<typeof workflowLifetime>>();
interface ExecutionRecoveryCase { taskId: string; title: string; targets: ExecutionTargetRef[]; recovery: ExecutionLedgerRecovery }
const taskRemovals = new WeakSet<OpsTask>();
const ledgerScans = new WeakMap<object, Promise<void>>();
const ledgerScanQueued = new WeakSet<object>();
const archiveWrites = new WeakMap<object, Promise<void>>();
const persistRevisions = new WeakMap<object, number>();
const ledgerRefreshQueued = new WeakSet<OpsTask>();
const ledgerDispatchRevisions = new WeakMap<OpsTask, number>();
const submittingTaskInputs = new WeakMap<OpsTask, ReturnType<typeof workflowLifetime>>();
const submittingRequirements = new WeakMap<OpsTask, object>();
const requirementTasksByOwner = new WeakMap<object, Set<OpsTask>>();
const inputCredentialWrites = new WeakMap<object, Promise<void>>();

function releaseRequirementOwner(task: OpsTask) {
  const owner = submittingRequirements.get(task);
  if (!owner) return [];
  const ownedTasks = requirementTasksByOwner.get(owner) ?? new Set([task]);
  const released = [...ownedTasks].filter((ownedTask) => submittingRequirements.get(ownedTask) === owner);
  for (const ownedTask of released) {
    submittingRequirements.delete(ownedTask);
    ownedTask.requirementProcessing = false;
  }
  requirementTasksByOwner.delete(owner);
  return released;
}

/** Keep cancelled input rollback ahead of newer input writes, even across rounds. */
function reserveInputCredentialWrite(owner: object) {
  const ready = inputCredentialWrites.get(owner) ?? Promise.resolve();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  inputCredentialWrites.set(owner, done);
  return {
    ready, release() {
      finish();
      if (inputCredentialWrites.get(owner) === done) inputCredentialWrites.delete(owner);
    }
  };
}

function claimTaskOperation(owners: WeakMap<OpsTask, ReturnType<typeof workflowLifetime>>, task: OpsTask) {
  if (owners.get(task)?.current()) return undefined;
  const lifetime = workflowLifetime(task);
  owners.set(task, lifetime);
  return {
    ...lifetime,
    release() { if (owners.get(task) === lifetime) owners.delete(task); },
  };
}

function hasWaitingStep(task: OpsTask) {
  return task.plan.some(step => step.status === "awaiting_input" || step.status === "awaiting_approval");
}

/** An accepted empty decision either delivers this request or records a blocker. */
function isBlockedNoAction(task: OpsTask) {
  return task.status === "awaiting_continuation"
    && task.latestGoalReview?.decision.decision === "adjust"
    && Array.isArray(task.latestGoalReview.nextPlan)
    && task.latestGoalReview.nextPlan.length === 0;
}

function stopForBlockedNoAction(task: OpsTask) {
  if (!isBlockedNoAction(task)) return false;
  task.autoAdjustmentSeconds = undefined;
  if (task.permission === "managed") {
    task.managedAdjustmentPhase = "manual_required";
    task.managedStopReason = currentRequestCompleted(task) ? "request_completed" : "no_action";
  }
  return true;
}

/** Consuming a transport event must also consume its display/scheduler state. */
function clearTransportAdjustmentState(task: OpsTask, manualRequired = false) {
  if (task.adjustmentIncident?.kind === "transport") {
    task.adjustmentIncident = undefined;
    task.lastAdjustmentBlocker = undefined;
  }
  task.autoAdjustmentSeconds = undefined;
  task.managedAdjustmentPhase = manualRequired ? "manual_required" : undefined;
  task.managedStopReason = undefined;
}

const secretValueId = (serverId: string, key: string) => `${serverId}::${key}`;

function serverSecretValues(values: Record<string, string>, serverId: string) {
  const prefix = `${serverId}::`;
  return Object.fromEntries(
    Object.entries(values)
      .filter(([id]) => id.startsWith(prefix))
      .map(([id, value]) => [id.slice(prefix.length), value]),
  );
}

function markTaskCredentialRevision(tasks: OpsTask[], serverId: string, metadata: SecretMetadata[] = []) {
  metadata.filter(m => m.serverId === serverId).forEach(m => { m.authenticationEvidence = undefined; });
  tasks
    .filter((task) => executionServerId(task) === serverId)
    .forEach((task) => {
      task.credentialRevision = (task.credentialRevision ?? 0) + 1;
      task.authenticationEvidence = undefined;
      task.authenticationCredentials = undefined;
    });
}

function scrubPersistedCredentialValue<T>(value: T, raw: string, placeholder: string): T {
  if (!raw) return value;
  if (typeof value === "string") return value.split(raw).join(placeholder) as T;
  if (Array.isArray(value)) {
    return value.map((item) => scrubPersistedCredentialValue(item, raw, placeholder)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, scrubPersistedCredentialValue(item, raw, placeholder)])) as T;
  }
  return value;
}

function normalizeSubmittedInputs(value: OpsTask["submittedInputs"]): NonNullable<OpsTask["submittedInputs"]> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([, input]) => (
    input
    && (input.type === "text" || input.type === "number" || input.type === "select")
    && (typeof input.value === "string" || typeof input.value === "number")
    && (input.type !== "select" || typeof input.value === "string")
    && typeof input.label === "string"
    && typeof input.description === "string"
    && typeof input.groupId === "string"
    && typeof input.groupTitle === "string"
    && typeof input.submittedAt === "string"
  )));
}

function normalizeSubmittedSecretBindings(
  value: OpsTask["submittedSecretBindings"],
): NonNullable<OpsTask["submittedSecretBindings"]> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([, binding]) => (
    binding
    && typeof binding.key === "string"
    && typeof binding.label === "string"
    && typeof binding.description === "string"
    && typeof binding.groupId === "string"
    && typeof binding.groupTitle === "string"
    && typeof binding.submittedAt === "string"
  )));
}

function clearStepRuntime(step: PlanStep, id: string): PlanStep {
  return {
    ...step,
    id,
    status: "pending",
    output: undefined,
    review: undefined,
    result: undefined,
    evidence: undefined,
    startedAt: undefined,
    executionPolicy: undefined,
    elapsedSeconds: undefined,
    progressMessage: undefined,
    safetyApprovalSnapshot: undefined,
    approvedSafetySnapshot: undefined,
  };
}

async function inspectPlanSafety(command: string, validation: string, repair: boolean) {
  try {
    const analysis = await backend.analyzePlanStepSafety(command, validation, repair);
    const issues = Array.isArray(analysis.issues)
      ? analysis.issues
      : (analysis.issue ? [analysis.issue] : []);
    return { ...analysis, issues, issue: issues[0] };
  } catch {
    // Desktop analysis is the sole execution authority. If that boundary is
    // unavailable, fail closed instead of silently switching to a second ruleset.
    const unavailable: PlanStepSafetyAnalysis = {
      safe: false,
      normalizedCommand: command,
      normalizedValidation: validation,
      repairedFields: [],
      issues: [{
        field: "command",
        ruleId: "SAFETY_ANALYZER_UNAVAILABLE",
        reason: "统一执行前安全分析器暂不可用",
        snippet: "安全检查服务不可用",
        repairable: false,
      }],
    };
    unavailable.issue = unavailable.issues[0];
    return unavailable;
  }
}

const emptyServerInfo = {
  os: "等待采集…",
  kernel: "—",
  cpu: "—",
  cores: 0,
  memoryGb: 0,
  diskGb: 0,
  uptime: "—",
};

const defaultModels: ModelProfile[] = [];

const defaultAiGenerationSettings: AiGenerationSettings = {
  limitOutput: false,
  maxPlanSteps: 6,
  maxTextChars: 200,
  maxCommandChars: 4000,
};

function normalizeAiGenerationSettings(settings: Partial<AiGenerationSettings>) {
  const positiveInteger = (value: unknown, fallback: number, minimum = 1) => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? Math.max(minimum, Math.trunc(parsed)) : fallback;
  };
  return {
    limitOutput: settings.limitOutput === true,
    maxPlanSteps: positiveInteger(settings.maxPlanSteps, defaultAiGenerationSettings.maxPlanSteps),
    maxOutputTokens: settings.maxOutputTokens == null ? undefined : positiveInteger(settings.maxOutputTokens, 256, 256),
    maxTextChars: positiveInteger(settings.maxTextChars, defaultAiGenerationSettings.maxTextChars),
    maxCommandChars: positiveInteger(settings.maxCommandChars, defaultAiGenerationSettings.maxCommandChars),
  };
}

function initialAiGenerationSettings() {
  const saved = readSaved<Partial<AiGenerationSettings>>("opsark.aiGenerationSettings", {});
  try {
    if (localStorage.getItem("opsark.outputBudgetPolicy") !== "connection-limit-v1") {
      // Old clients persisted the implicit 5000 default as though the user chose it.
      if (saved.maxOutputTokens === 5000) delete saved.maxOutputTokens;
      localStorage.setItem("opsark.aiGenerationSettings", JSON.stringify(saved));
      localStorage.setItem("opsark.outputBudgetPolicy", "connection-limit-v1");
    }
  } catch { /* Storage can be unavailable; still use in-memory defaults. */ }
  return normalizeAiGenerationSettings(saved);
}

function initialTools() {
  if (!import.meta.env.DEV) return applyOfficialTools(resolveToolRegistry([]));
  return applyOfficialTools(resolveToolRegistry(parseToolOverrides(readSaved<unknown>("opsark.toolOverrides", []))));
}

function initialSkills() {
  return loadOwnedSkills();
}

function readSaved<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function initialServers() {
  return readSaved<ServerProfile[]>("opsark.servers", []).map((server) => ({
    ...server,
    info: {
      ...emptyServerInfo,
      ...(server.info ?? {}),
      cores: Number.isFinite(Number(server.info?.cores)) ? Number(server.info.cores) : 0,
      memoryGb: Number.isFinite(Number(server.info?.memoryGb)) ? Number(server.info.memoryGb) : 0,
      diskGb: Number.isFinite(Number(server.info?.diskGb)) ? Number(server.info.diskGb) : 0,
    },
  }));
}

function initialModels(): ModelProfile[] {
  const saved = readSaved<ModelProfile[]>("opsark.models", defaultModels)
    .filter((model) => model.source !== "official")
    .filter((model) => model.provider !== "Built-in" && model.id !== "model-local")
    .filter((model) => !(
      model.id === "model-deepseek"
      && model.name === "DeepSeek V4 Flash"
      && model.model === "deepseek-v4-flash"
      && model.hasApiKey !== true
    ));
  return (saved.length ? saved : defaultModels).map((model) => ({ timeoutSeconds: 90, ...model }));
}

function initialSecretMetadata() {
  const serverIds = new Set(initialServers().map(({ id }) => id));
  return readSaved<SecretMetadata[]>("opsark.secretMetadata", [])
    .filter((secret) => secret.scope !== "server" || Boolean(secret.serverId && serverIds.has(secret.serverId)));
}

function readTaskCache() {
  try { return readTaskProjection(JSON.parse(localStorage.getItem("opsark.tasks") ?? "null")); }
  catch { return { tasks: [] as OpsTask[], compatible: false, issues: ["任务缓存无法解析，原始记录已保留，停止覆盖。"] }; }
}

function initialTasks(savedTasks: OpsTask[]) {
  const tasks = savedTasks.map((task) => {
    task.executionLedgerLoading = false;
    if (task.executionLedgerRecovery) task.executionLedgerRecovery.busyAttemptId = undefined;
    task.requirementProcessing = false;
    task.permission = normalizePermissionLevel(task.permission);
    task.adjustmentInProgress = false;
    // Async workers do not survive application restart. Never restore a spinner
    // without an owner; an explicit check can start a fresh bounded recovery.
    if (task.managedAdjustmentPhase === "waiting_transport"
      && ["needs_adjustment", "awaiting_continuation", "failed"].includes(task.status)) {
      task.managedAdjustmentPhase = "manual_required";
      task.managedStopReason = "transport_recovery";
      task.autoAdjustmentSeconds = undefined;
      task.pauseReason = "上次终端恢复检查已中断，请检查终端后继续；原执行证据已保留，未确认结果的命令不会自动重放。";
    }
    if (task.adjustmentIncident) {
      // Older counters measured admitted plans, not dispatched executions.
      if (task.adjustmentIncident.planningAttemptCount === undefined) {
        task.adjustmentIncident.planningAttemptCount = task.adjustmentIncident.executionAttemptCount
          ?? task.adjustmentIncident.attemptCount ?? 0;
        task.adjustmentIncident.executionAttemptCount = 0;
        task.adjustmentCount = 0;
        if (task.adjustmentIncident.kind === "business"
          && task.adjustmentIncident.planningAttemptCount > 0
          && ["awaiting_plan_approval", "awaiting_step_approval"].includes(task.status)
          && task.plan.length > 0
          && task.plan.every(step => ["pending", "awaiting_approval"].includes(step.status)
            && !step.startedAt && !step.result && !step.evidence?.length)) {
          task.adjustmentIncident.activePlan = { stepIds: task.plan.map(step => step.id), executionCounted: false };
        }
      }
      task.adjustmentIncident.executionAttemptCount ??= 0;
      task.adjustmentIncident.generationFailureCount ??= 0;
      delete task.adjustmentIncident.attemptCount;
    }
    if (!["completed", "failed", "cancelled"].includes(task.status)
      && task.plan.some(step => !["completed", "failed", "skipped"].includes(step.status)
        && /^\s*opsark-tool(?:\s|$)/i.test(step.command))) {
      task.status = "needs_adjustment";
      task.plan.forEach(step => {
        if (["awaiting_input", "awaiting_approval"].includes(step.status)) step.status = "pending";
        step.safetyApprovalSnapshot = undefined;
        step.approvedSafetySnapshot = undefined;
      });
      task.pauseReason = "该未完成计划使用已停用的工具字符串协议。历史证据已保留，请重新生成剩余计划。";
      task.managedAdjustmentPhase = "manual_required";
      task.managedStopReason = "workflow_error";
      task.autoAdjustmentSeconds = undefined;
    }
    task.confirmedSecretKeys = [];
    task.submittedInputs = normalizeSubmittedInputs(task.submittedInputs);
    task.submittedSecretBindings = normalizeSubmittedSecretBindings(task.submittedSecretBindings);
    const interruptedReplans = task.protocolRepairHistory?.filter(record => record.status === "planning") ?? [];
    interruptedReplans.forEach(record => {
      record.status = "failed";
      record.outcome = "应用重启中断规划，原方案未执行，请手动重新规划";
    });
    if (interruptedReplans.length && task.protocolRepair && task.status === "planning") {
      task.status = "needs_adjustment";
      task.managedAdjustmentPhase = "manual_required";
      task.managedStopReason = "model_generation_failed";
      task.autoAdjustmentSeconds = undefined;
      task.pauseReason = "上次业务重新规划因应用重启中断，原计划和证据已保留；请重新规划并评估风险，不会自动执行旧方案。";
    }
    // Loading is an audit read, not admission of a new executable proposal.
    // Runtime identities and grants must be refreshed at the next execution boundary.
    task.preparedPlan = undefined;
    task.planApproval = undefined;
    task.plan.forEach(step => {
      if (["pending", "awaiting_approval", "awaiting_input"].includes(step.status)) {
        step.authenticationGate = undefined;
        step.executionIntent = undefined;
        step.approvalGrant = undefined;
        step.safetyApprovalSnapshot = undefined;
        step.approvedSafetySnapshot = undefined;
      }
    });
    // An explicit no-action decision survives restarts as a stopped state;
    // stale countdown/generating flags must not revive automatic planning.
    stopForBlockedNoAction(task);
    task.phaseHistory ??= [];
    task.planHistory?.forEach((round) => {
      if (round.status === "needs_adjustment" && round.summary) {
        round.pauseReason = round.summary;
        round.summary = undefined;
      }
    });
    initializeTaskHistoryCheckpoint(task);
    if (task.status === "needs_adjustment" && task.summary) {
      task.pauseReason = task.summary;
      task.summary = undefined;
    }
    // Do not guess whether a persisted validator was injected by an old Core
    // or authored elsewhere. Preserve the record and block unfinished calls.
    const conflictedTools = task.plan.filter(step =>
      ["pending", "awaiting_approval", "awaiting_input"].includes(step.status)
      && hasToolStepBoundaryConflict(step));
    if (conflictedTools.length && !["completed", "failed", "cancelled"].includes(task.status)) {
      task.status = "needs_adjustment";
      for (const step of conflictedTools) {
        step.status = "pending";
        step.safetyApprovalSnapshot = undefined;
        step.approvedSafetySnapshot = undefined;
      }
      task.pauseReason = "该未完成工具计划包含 Shell 命令或验收字段，无法继续执行。原计划与历史证据已保留，请重新生成剩余计划。";
      task.managedAdjustmentPhase = "manual_required";
      task.managedStopReason = "workflow_error";
      task.autoAdjustmentSeconds = undefined;
    }
    const latestRequirement = latestTaskRequirement(task);
    task.rootGoal ||= latestRequirement;
    // Restore only the old automatically shortened title; preserve custom names.
    if (task.rootGoal.length > 22 && task.title === task.rootGoal.slice(0, 22)) {
      task.title = task.rootGoal;
    }
    task.currentInstruction ||= [...task.messages]
      .reverse()
      .find((message) => message.role === "user" && message.kind === "message")?.content
      ?? task.rootGoal;
    task.currentRoundId ||= uid("round");
    if (task.modelPlanningBlocker && (task.modelPlanningBlocker.error.code === "MODEL_FORMAT_INVALID" || isModelRecoveryScopeRejection(task.modelPlanningBlocker.error))
      && ["planning_failed", "needs_adjustment", "awaiting_continuation"].includes(task.status)) {
      task.pauseReason = modelServiceErrorMessage(task.modelPlanningBlocker.error);
    }
    if (task.status === "needs_adjustment" && task.managedStopReason === "workflow_error"
      && !task.protocolRepair && !task.modelPlanningBlocker) {
      const failure = restoreLegacyPlanProtocolFailure(task.pauseReason);
      if (failure) {
        task.protocolRepair = { roundId: task.currentRoundId, serverId: executionServerId(task),
          repair: failure.repair, repairError: failure.repairError };
        task.pauseReason = failure.userMessage;
        task.managedAdjustmentPhase = "manual_required";
        task.autoAdjustmentSeconds = undefined;
      }
    }
    const interrupted = task.plan.find(step => ["running", "validating"].includes(step.status));
    if (interrupted) {
      recordExecutionUncertainty(task, interrupted, "应用重启中断执行，需核对远端进程与实际结果。");
      interrupted.status = "failed";
      holdFailureDependents(interrupted, task.plan.filter(item => item.status === "pending"));
      task.status = "needs_adjustment";
      task.managedAdjustmentPhase = "manual_required";
      task.autoAdjustmentSeconds = undefined;
      task.currentExecutionId = undefined;
      task.pauseReason = "上次执行因应用重启中断。已保存目标和执行证据；先核对远端进程及实际结果，不会自动重放变更。";
    } else if (["planning", "running", "validating"].includes(task.status) && !hasWaitingStep(task)) {
      // Planning, overall-goal review and the gap between steps have no live
      // owner after restart either. Preserve receipts and model uncertainty;
      // restoration itself never restarts a request or dispatches an action.
      const planning = task.status === "planning";
      task.status = planning ? "planning_failed" : "needs_adjustment";
      task.managedAdjustmentPhase = "manual_required";
      task.managedStopReason = task.modelPlanningBlocker ? "model_generation_failed" : "workflow_error";
      task.autoAdjustmentSeconds = undefined;
      task.pauseReason = planning
        ? "上次规划因应用重启中断，需求与已有记录已保留。请核对模型请求记录后重新生成；未自动续发模型请求或执行命令。"
        : "上次阶段衔接或整体验收因应用重启中断，已有步骤与执行证据已保留。请核对记录后继续；未自动重放操作，也未将未完成验收记为成功。";
    }
    return task;
  });
  return restoreConversationLinks(tasks, readSaved<AuditEvent[]>("opsark.logs", []));
}

function initialLogs() {
  return readSaved<AuditEvent[]>("opsark.logs", []).map((event) => ({
    ...event,
    // Older records may not have been written with snapshots. Keep them
    // readable after a server/task is renamed or removed.
    title: event.title || "未命名事件",
    detail: event.detail || "",
  }));
}

function initialDeveloperLogs() {
  return readSaved<DeveloperLogEntry[]>("opsark.developerLogs", []).map((event) => ({
    ...event,
    title: event.title || "未命名开发者事件",
    summary: event.summary || "无摘要",
  }));
}

function truncatePersistedText(value: string | undefined, limit: number) {
  if (!value || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…[持久化时已截断，完整实时输出不受影响]`;
}

function compactPersistedStep(step: PlanStep, aggressive: boolean): PlanStep {
  const outputLimit = aggressive ? 8_000 : 40_000;
  return {
    ...step,
    output: truncatePersistedText(step.output, outputLimit),
    evidence: step.evidence?.slice(-(aggressive ? 4 : 12)).map((evidence) => ({
      ...evidence,
      rawOutput: truncatePersistedText(evidence.rawOutput, aggressive ? 4_000 : 20_000) ?? "",
    })),
  };
}

function compactPersistedTasks(tasks: OpsTask[], aggressive = false): OpsTask[] {
  return tasks.slice(0, aggressive ? 20 : 50).map((task) => ({
    ...task,
    persistedRequirements: { version: 1, sources: taskRequirementSnapshot(task).requirements },
    messages: task.messages.slice(-(aggressive ? 80 : 240)).map((message) => ({
      ...message,
      content: truncatePersistedText(message.content, aggressive ? 4_000 : 16_000) ?? "",
    })),
    plan: task.plan.map((step) => compactPersistedStep(step, aggressive)),
    phaseHistory: task.phaseHistory?.slice(-(aggressive ? 3 : 12)).map((phase) => ({
      ...phase,
      plan: phase.plan.map((step) => compactPersistedStep(step, aggressive)),
    })),
    planHistory: task.planHistory?.slice(-(aggressive ? 2 : 8)).map((round) => ({
      ...round,
      plan: round.plan.map((step) => compactPersistedStep(step, aggressive)),
      messages: round.messages?.slice(-(aggressive ? 80 : 240)).map((message) => ({
        ...message,
        content: truncatePersistedText(message.content, aggressive ? 4_000 : 16_000) ?? "",
      })),
      records: round.records?.slice(-(aggressive ? 40 : 120)),
    })),
  }));
}

interface ServerMetricState {
  sample?: Metrics;
  loading: boolean;
  error?: string;
  stale: boolean;
  requestVersion: number;
  lastAttemptAt: number;
}

const connectionMonitors = new WeakMap<object, () => void>();
interface PendingServerCredential {
  connection: RuntimeConnection;
  remember: boolean;
  isCurrent?: () => boolean;
  committing?: Promise<void>;
}
const pendingServerCredentials = new WeakMap<object, Map<string, PendingServerCredential>>();
const serverCredentialWrites = new WeakMap<object, Map<string, Promise<void>>>();
// Runtime-only equality tracking: the snapshot contains the public revision,
// never a credential value or a hash derived from one. Restart clears grants.
const principalBindings = new WeakMap<object, Map<string, { value: string; revision: number }>>();
function principalVersion(owner: object, reference: string, value: string): number {
  let bindings = principalBindings.get(owner);
  if (!bindings) { bindings = new Map(); principalBindings.set(owner, bindings); }
  const previous = bindings.get(reference);
  if (previous?.value === value) return previous.revision;
  const revision = (previous?.revision ?? 0) + 1;
  bindings.set(reference, { value, revision });
  return revision;
}

function sameServerConnection(left: RuntimeConnection | undefined, right: RuntimeConnection) {
  return Boolean(left && left.host === right.host && left.port === right.port
    && left.username === right.username && left.password === right.password);
}

export const useOpsStore = defineStore("ops", {
  state: () => {
    const taskCache = readTaskCache();
    const tasks = initialTasks(taskCache.tasks);
    const tools = initialTools();
    return {
      servers: initialServers(),
      tasks,
      models: initialModels(),
      aiGenerationSettings: initialAiGenerationSettings(),
      tools,
      toolSaveError: "",
      skills: initialSkills(),
      skillSaveError: "",
      modelAvailability: {} as Record<string, ModelAvailability>,
      logs: initialLogs(),
      developerLogs: initialDeveloperLogs(),
      metricsByServer: {} as Record<string, ServerMetricState>,
      connectionClock: Date.now(),
      connectionSnapshots: {} as Record<string, string>,
      collectingServers: [] as string[],
      activeTaskId: null as string | null,
      serverPasswords: {} as Record<string, string>,
      modelApiKeys: {} as Record<string, string>,
      secretMetadata: initialSecretMetadata(),
      secretValues: {} as Record<string, string>,
      pendingSecret: null as PendingSecretRequest | null,
      pendingUserInputs: restoreUserInputRequests(tasks, tools, () => uid("tool-call")) as PendingUserInput[],
      terminalLines: [] as string[],
      // Runtime ownership only: this array is intentionally not persisted.
      transportRecoveryTaskIds: [] as string[],
      isCollecting: false,
      credentialsHydrated: false,
      credentialsLoading: false,
      credentialError: "",
      persistenceWarning: taskCache.issues.join("\n"),
      taskCacheReadError: taskCache.issues.join("\n"),
      executionLedgerReadError: "",
      executionRecoveryCases: [] as ExecutionRecoveryCase[],
    };
  },

  getters: {
    connectedServerIds(): string[] {
      return Object.entries(useConnectionStore().states)
        .filter(([, connection]) => connection.status === "connected").map(([id]) => id);
    },
    activeTask(state): OpsTask | undefined {
      return state.tasks.find((task) => task.id === state.activeTaskId);
    },
    enabledModels(state) {
      return state.models.filter((model) => model.enabled);
    },
    availableModels(state) {
      return state.models.filter(
        (model) => model.enabled && state.modelAvailability[model.id]?.status === "available",
      );
    },
    enabledTools(state) {
      return state.tools.filter((tool) => tool.enabled);
    },
    enabledSkills(state) {
      return state.skills.filter((skill) => skill.enabled);
    },
  },

  actions: {
    serverConnection(serverId: string) { return useConnectionStore().state(serverId); },

    isServerConnected(serverId: string) { return useConnectionStore().isConnected(serverId); },

    metricState(serverId: string) {
      const metric = this.metricsByServer[serverId];
      return {
        sample: metric?.sample,
        loading: metric?.loading ?? false,
        error: metric?.error,
        stale: !metric?.sample || Boolean(metric.stale || metric.error)
          || !this.isServerConnected(serverId)
          || this.connectionClock - Date.parse(metric.sample.sampledAt) > 30_000,
      };
    },

    contextMetrics(serverId: string): Metrics | undefined {
      const metric = this.metricState(serverId);
      return metric.stale ? undefined : metric.sample;
    },

    syncConnectionStates() {
      for (const server of this.servers) {
        const connection = this.serverConnection(server.id);
        const snapshot = `${connection.status}:${connection.generation}`;
        if (this.connectionSnapshots[server.id] === snapshot) continue;
        const previous = this.connectionSnapshots[server.id];
        this.connectionSnapshots[server.id] = snapshot;
        server.status = connection.status === "connected" ? "online"
          : ["connecting", "reconnecting", "suspect"].includes(connection.status) ? "testing" : "offline";
        if (connection.status !== "connected") {
          const metric = this.metricsByServer[server.id];
          if (metric && (!metric.stale || metric.loading)) {
            metric.stale = true;
            metric.requestVersion += 1;
            metric.loading = false;
          }
          useFileWorkspaceStore().markServerOffline(server.id);
        } else {
          void this.commitVerifiedServerCredential(server.id);
        }
        if (previous !== undefined && !snapshot.startsWith("idle:")) {
          this.addLog({
            category: "system", level: ["manual", "auth_failed"].includes(connection.status) ? "error"
              : connection.status === "connected" ? "success" : "info",
            title: `SSH 连接状态：${connection.phase}`,
            detail: JSON.stringify({
              status: connection.status, generation: connection.generation,
              attempt: connection.attempt, error: connection.error,
              elapsedMs: connection.startedAt ? Math.max(0, Date.now() - connection.startedAt) : undefined,
              lastSuccessAt: connection.lastSuccessAt
            }), serverId: server.id
          });
        }
      }
    },

    startConnectionMonitor() {
      if (connectionMonitors.has(this)) return;
      void this.restoreExecutionLedgerTasks();
      const connections = useConnectionStore();
      const stopWatch = watch(() => Object.values(connections.states)
        .map(connection => `${connection.status}:${connection.generation}`).join("|"),
        () => this.syncConnectionStates(), { flush: "post" });
      const tick = (force = false) => {
        this.connectionClock = Date.now();
        connections.tick(this.servers.map(server => server.id), force);
        this.syncConnectionStates();
        for (const id of this.connectedServerIds) {
          const metric = this.metricsByServer[id];
          if (!metric?.loading && (!metric || this.connectionClock - metric.lastAttemptAt >= 10_000)) {
            void this.refreshMetrics(id);
          }
        }
      };
      const interval = window.setInterval(() => tick(), 1000);
      const onWake = () => { if (!document.hidden) tick(true); };
      window.addEventListener("focus", onWake);
      window.addEventListener("online", onWake);
      document.addEventListener("visibilitychange", onWake);
      connectionMonitors.set(this, () => {
        window.clearInterval(interval);
        stopWatch();
        window.removeEventListener("focus", onWake);
        window.removeEventListener("online", onWake);
        document.removeEventListener("visibilitychange", onWake);
      });
      tick();
    },

    stopConnectionMonitor() {
      connectionMonitors.get(this)?.();
      connectionMonitors.delete(this);
    },

    reportConnectionFailure(serverId: string, reason: string) {
      if (!isConnectionTransportFailure(reason)) return;
      useConnectionStore().reportFailure(serverId, reason);
      this.syncConnectionStates();
    },

    pauseTaskForConnection(task: OpsTask, expectedGeneration?: number) {
      const next = task.plan.find(step => !["completed", "failed", "skipped"].includes(step.status));
      if (next?.action?.type === "tool" && ["server.resolve_connection", "server.connect", "user.request_input", "evidence.read", "skills.expand"].includes(next.action.toolId)) return false;
      const id = executionServerId(task);
      if (this.getRuntimeConnection(id) && (expectedGeneration === undefined
        || this.serverConnection(id).generation === expectedGeneration)) return false;
      const reason = "SSH 连接不可用或已更换，任务已暂停。请重连并核对执行记录；未收到结果的命令不会自动重放。";
      task.pauseReason = reason;
      task.autoAdjustmentSeconds = undefined;
      task.managedAdjustmentPhase = "manual_required";
      task.managedStopReason = "transport_recovery";
      if (canTransitionTask(task.status, "needs_adjustment")) transitionTask(task, "needs_adjustment");
      if (task.messages[task.messages.length - 1]?.content !== reason) this.pushMessage(task, { role: "system", kind: "event", content: reason });
      this.persist();
      return true;
    },

    async reconnectServer(serverId: string): Promise<boolean> {
      await this.hydrateCredentials();
      let password = this.serverPasswords[serverId];
      if (!password) {
        try { password = await backend.loadCredential("server", serverId) ?? ""; }
        catch { this.serverConnection(serverId).error = "加密凭据读取失败，请手动填写 SSH 密码"; }
      }
      if (!password) return false;
      return this.connectServer(serverId, password, false);
    },

    async commitVerifiedServerCredential(serverId: string): Promise<void> {
      const pending = pendingServerCredentials.get(this)?.get(serverId);
      if (!pending || !sameServerConnection(this.getRuntimeConnection(serverId), pending.connection)) return;
      if (pending.isCurrent && !pending.isCurrent()) {
        pendingServerCredentials.get(this)?.delete(serverId);
        return;
      }
      if (pending.committing) return pending.committing;
      const changed = this.serverPasswords[serverId] !== pending.connection.password;
      this.serverPasswords[serverId] = pending.connection.password;
      if (changed) {
        markTaskCredentialRevision(this.tasks, serverId, this.secretMetadata);
      }
      let writes = serverCredentialWrites.get(this);
      if (!writes) { writes = new Map(); serverCredentialWrites.set(this, writes); }
      const commit = (writes.get(serverId) ?? Promise.resolve()).then(async () => {
        if (pending.remember && (!pending.isCurrent || pending.isCurrent()) && sameServerConnection(this.getRuntimeConnection(serverId), pending.connection)) {
          try { await backend.saveCredential("server", serverId, pending.connection.password); }
          catch (error) { this.credentialError = String(error); }
        }
      }).finally(() => {
        if (pendingServerCredentials.get(this)?.get(serverId) === pending) pendingServerCredentials.get(this)?.delete(serverId);
        if (writes!.get(serverId) === commit) writes!.delete(serverId);
      });
      pending.committing = commit;
      writes.set(serverId, commit);
      void this.refreshServer(serverId);
      void this.refreshMetrics(serverId);
      return commit;
    },

    persist(immediate = false) {
      if (persistTimer !== undefined) window.clearTimeout(persistTimer);
      const store = this;
      const revision = (persistRevisions.get(store) ?? 0) + 1;
      persistRevisions.set(store, revision);
      const write = (savedTasks = store.tasks, saveTaskCache = true) => {
        try {
          if (saveTaskCache && !store.taskCacheReadError) localStorage.setItem("opsark.tasks", JSON.stringify(compactPersistedTasks(savedTasks)));
          localStorage.setItem("opsark.logs", JSON.stringify(store.logs.slice(0, 300)));
          localStorage.setItem("opsark.developerLogs", JSON.stringify(store.developerLogs.slice(0, MAX_DEVELOPER_LOGS)));
          localStorage.setItem("opsark.servers", JSON.stringify(store.servers));
          localStorage.setItem("opsark.models", JSON.stringify(store.models.filter(model => model.source !== "official")));
          localStorage.setItem("opsark.aiGenerationSettings", JSON.stringify(store.aiGenerationSettings));
          if (import.meta.env.DEV) localStorage.setItem("opsark.toolOverrides", JSON.stringify(createToolOverrides(store.tools)));
          persistOwnedSkills(store.skills);
          localStorage.setItem("opsark.secretMetadata", JSON.stringify(store.secretMetadata));
          store.persistenceWarning = store.taskCacheReadError;
        } catch (error) {
          // 本地记录空间不足不能改变远程命令结果；降级保存精简快照并继续任务。
          store.persistenceWarning = `任务记录空间不足，已自动压缩历史：${String(error)}`;
          try {
            if (saveTaskCache && !store.taskCacheReadError) localStorage.setItem("opsark.tasks", JSON.stringify(compactPersistedTasks(savedTasks, true)));
            localStorage.setItem("opsark.logs", JSON.stringify(store.logs.slice(0, 80)));
            localStorage.setItem("opsark.developerLogs", JSON.stringify(compactDeveloperLogs(store.developerLogs)));
          } catch {
            // 极端情况下保留内存态，禁止把持久化失败误报为执行失败。
          }
        }
        persistTimer = undefined;
      };
      const save = () => {
        if (store.taskCacheReadError) { write(); return; }
        const snapshots = JSON.parse(JSON.stringify(store.tasks)) as OpsTask[];
        const failed = (error: unknown) => { write([], false); store.persistenceWarning = `任务归档保存失败，保留已有缓存：${String(error)}`; };
        if (!isTauri()) {
          try { void archiveTasks(snapshots); write(); } catch (error) { failed(error); }
          return;
        }
        const pending = (archiveWrites.get(store) ?? Promise.resolve()).then(async () => {
          await archiveTasks(snapshots);
          if (persistRevisions.get(store) === revision) write(snapshots.filter(task => store.tasks.some(current => current.id === task.id)));
        }).catch(failed);
        archiveWrites.set(store, pending);
        return pending;
      };
      if (immediate) return save();
      else persistTimer = window.setTimeout(save, 200);
    },

    async recordStepExecution<T>(task: OpsTask, step: PlanStep, phase: string, executionId: string,
      isCurrent: () => boolean, execute: () => Promise<T>,
      options: { effect?: "read" | "change" | "interaction"; intent?: ExecutionIntentSnapshot; subkey?: string } = {}): Promise<T> {
      if (this.taskCacheReadError) throw new ExecutionLedgerError(this.taskCacheReadError, "prepare", false);
      if (taskRemovals.has(task)) throw new ExecutionLedgerError("任务正在移除，未派发新操作。", "prepare", false);
      if (phase === "validation" && !options.intent && step.executionIntent) {
        const semantic = { ...step.executionIntent.semantic, effect: "read" as const, kind: "observe" as const,
          action: { type: "shell" as const, command: step.executionIntent.semantic.validator?.command ?? step.executionIntent.semantic.validation ?? step.validation },
          executionScope: step.executionIntent.semantic.validationScope ?? "isolated_exec" as const };
        options = { ...options, effect: "read", intent: { version: "execution-intent@1", algorithm: "sha256", semantic,
          digest: executionDigest({ version: "execution-intent@1", semantic }) } };
      }
      const effect = options.effect ?? step.executionIntent?.semantic.effect;
      if (effect === "change" && ["command", "tool"].includes(phase)) {
        let parsed;
        try { parsed = readExecutionLedger(await listExecutionLedger(this, task.id)); }
        catch (error) { throw new ExecutionLedgerError("无法读取既有执行记录，尚未发送命令", "list", false, undefined, undefined, undefined, error); }
        if (!parsed.compatible) throw new ExecutionLedgerError(parsed.issues.join("；"), "list", false);
        const previous = parsed.operations.find(operation => operation.stepId === step.id && operation.phase === phase
          && operation.attempts.some(attempt => attempt.status !== "not_dispatched"));
        if (previous) throw new ExecutionLedgerError("该步骤已有派发记录，请核对原结果；连接或轮次变化不能重发原操作", "begin", false, previous.operationId, previous.attempts[previous.attempts.length - 1]?.id);
      }
      const secrets = { ...this.secretValues, ...Object.fromEntries(Object.entries(this.serverPasswords).map(([key, value]) => [`server-password:${key}`, value])) };
      return runRecordedExecution({ owner: this,
        task: { id: task.id, currentRoundId: task.currentRoundId, workflowEpoch: task.workflowEpoch,
          planRevision: step.planRevision ?? task.preparedPlan?.planRevision ?? 0 }, step, phase, executionId, ...options, isCurrent,
        redact: text => redactExecutionOutput(text, secrets),
        execute: async () => {
          if (!isCurrent()) throw new ToolExecutionError("原执行所有权已结束，未发送命令", "permission", "not_sent");
          return execute();
        },
        classifyResult: value => {
          const result = value as { success?: boolean; passed?: boolean; error?: { dispatchState?: string; category?: string } };
          if (result.error?.dispatchState === "not_sent") return "not_dispatched";
          if (result.error?.dispatchState === "unknown" || result.error?.category === "protocol") return effect === "read" ? "failed" : "unknown";
          return result.success === false || result.passed === false ? "failed" : "succeeded";
        },
        classifyError: error => isSshConnectionSetupFailure(error)
          || error instanceof ToolExecutionError && error.dispatchState === "not_sent" ? "not_dispatched"
          : effect === "read" ? "failed" : "unknown",
        onAttempt: (operation, attempt) => {
          ledgerDispatchRevisions.set(task, (ledgerDispatchRevisions.get(task) ?? 0) + 1);
          (step.executionLedgerAttempts ??= []).push({ operationId: operation.operationId, attemptId: attempt.id, executionId, phase });
          this.persist(true);
        },
        onCommitted: (_operationId, attemptId) => {
          (step.ledgerAppliedAttemptIds ??= []).push(attemptId);
        },
      });
    },

    async markExecutionVerified(step: PlanStep) {
      step.ledgerVerifiedAttemptIds = [...new Set([...(step.ledgerVerifiedAttemptIds ?? []), ...(step.ledgerAppliedAttemptIds ?? [])])];
      const taskId = step.executionIntent?.semantic.taskId;
      if (taskId) {
        try { await this.persistExecutionAcknowledgements(taskId); }
        catch { this.persistenceWarning = "执行结果已保存，但验收确认尚未落账；将重试保存，不会重新执行远端操作。"; }
      }
    },

    async markExecutionReviewed(step: PlanStep) {
      const taskId = step.executionIntent?.semantic.taskId;
      if (!taskId) return;
      try { await this.persistExecutionAcknowledgements(taskId); }
      catch { this.persistenceWarning = "复核结果已保留，台账确认尚未落盘；下次刷新重试保存，不重发远端操作。"; }
    },

    async persistExecutionAcknowledgements(taskId: string, records?: Awaited<ReturnType<typeof listExecutionLedger>>) {
      const task = this.tasks.find(t => t.id === taskId);
      const parsed = records ? undefined : readExecutionLedger(await listExecutionLedger(this, taskId));
      if (parsed && !parsed.compatible) throw new Error(parsed.issues.join("；"));
      const operations = records ?? parsed!.operations;
      if (!task) return operations;
      const steps = executionReceiptSteps(task);
      const applied = new Set(steps.flatMap(s => s.ledgerAppliedAttemptIds ?? []));
      const verified = new Set(steps.flatMap(s => s.ledgerVerifiedAttemptIds ?? []));
      for (const operation of operations) for (let index = 0; index < operation.attempts.length; index++) {
        const attempt = operation.attempts[index];
        if (attempt.late || !attempt.outcome || !["succeeded", "failed", "not_dispatched"].includes(attempt.status)) continue;
        const reviewed = attempt.status === "succeeded" && verified.has(attempt.id);
        const step = steps.find(item => item.executionLedgerAttempts?.some(ref =>
          ref.operationId === operation.operationId && ref.attemptId === attempt.id));
        const review = step ? deriveExecutionAttemptReview(operation, attempt, step) : undefined;
        const newReview = review && !attempt.reviews?.some(item => item.reviewFingerprint === review.reviewFingerprint);
        if (applied.has(attempt.id) && (attempt.projectionAppliedAt === undefined || reviewed && attempt.reviewCompletedAt === undefined || newReview)) {
          operation.attempts[index] = await acknowledgeExecutionAttempt(this, operation.operationId, attempt.id, reviewed, newReview ? review : undefined);
        }
      }
      return operations;
    },

    handleExecutionLedgerError(task: OpsTask, step: PlanStep, error: ExecutionLedgerError) {
      task.currentExecutionId = undefined;
      task.executionLedgerError = { stage: error.stage, message: error.message, operationId: error.operationId,
        attemptId: error.attemptId, remoteResultKnown: error.remoteResultKnown };
      if (!task.cancelRequested) {
        task.status = "needs_adjustment";
        task.managedAdjustmentPhase = "manual_required";
        task.autoAdjustmentSeconds = undefined;
        task.pauseReason = `${error.message}；先恢复记录或只读核对，不会自动重发原操作。`;
        if (["running", "validating"].includes(step.status)) step.status = "failed";
      }
      if (error.stage === "execution" || error.stage === "result_commit") {
        recordExecutionUncertainty(task, step, error.message);
      }
      this.persist(true);
      void this.refreshExecutionLedger(task.id);
    },

    async restoreExecutionLedgerTasks() {
      const pending = ledgerScans.get(this);
      if (pending) { ledgerScanQueued.add(this); return pending; }
      const scan = (async () => {
        do {
          ledgerScanQueued.delete(this);
          try {
            let archives: TaskArchiveEntry[] = [], archiveError = "";
            try { archives = await listTaskArchives(); }
            catch (error) { archiveError = `任务归档暂不可读，已保留缓存：${String(error)}`; }
            // Removal identity remains authoritative even if the execution ledger is unreadable.
            const removedIds = new Set(archives.filter(entry => entry.disposition === "removed").map(entry => entry.taskId));
            this.tasks = this.tasks.filter(task => !removedIds.has(task.id) || task.currentExecutionId || task.requirementProcessing
              || ["planning", "running", "validating"].includes(task.status));
            this.pendingUserInputs = this.pendingUserInputs.filter(row => !removedIds.has(row.taskId));
            if (this.pendingSecret && removedIds.has(this.pendingSecret.taskId)) this.pendingSecret = null;
            if (this.activeTaskId && !this.tasks.some(task => task.id === this.activeTaskId)) this.activeTaskId = null;
            const parsed = readExecutionLedger(await listExecutionLedger(this));
            if (!parsed.compatible) { this.executionLedgerReadError = [archiveError, ...parsed.issues].filter(Boolean).join("；"); return; }
            if (!archiveError && !this.taskCacheReadError) {
              for (const task of [...this.tasks]) {
                const removed = archives.find(entry => entry.taskId === task.id)?.disposition === "removed";
                const records = parsed.operations.filter(op => op.taskId === task.id);
                if (!removed && !isUntouchedRecoveryShell(task, records)) {
                  if (archives.find(entry => entry.taskId === task.id)?.disposition === "legacy_recovery") {
                    await preserveContinuedLegacyTask(JSON.parse(JSON.stringify(task)));
                  }
                  continue;
                }
                if (task.currentExecutionId || task.requirementProcessing || ["planning", "running", "validating"].includes(task.status)) continue;
                if (!removed) await markTaskArchived(JSON.parse(JSON.stringify(task)), "legacy_recovery");
                // Never discard a shell that received user input while its backup was being saved.
                if (!removed && !isUntouchedRecoveryShell(task, records)) {
                  await preserveContinuedLegacyTask(JSON.parse(JSON.stringify(task)));
                  continue;
                }
                this.tasks = this.tasks.filter(row => row !== task);
                this.pendingUserInputs = this.pendingUserInputs.filter(row => row.taskId !== task.id);
                if (this.pendingSecret?.taskId === task.id) this.pendingSecret = null;
                if (this.activeTaskId === task.id) this.activeTaskId = null;
              }
            }
            const cases: ExecutionRecoveryCase[] = [];
            for (const taskId of new Set(parsed.operations.map(op => op.taskId))) {
              if (this.tasks.some(task => task.id === taskId)) continue;
              const records = parsed.operations.filter(op => op.taskId === taskId);
              const owner = taskId.startsWith("direct-") ? directExecutionLedgerOwner : this;
              const recovery = projectExecutionLedgerRecovery(records, { servers: this.servers,
                storageFailures: pendingExecutionReceipts(owner, taskId).map(receipt => ({ kind: "storage_failed", operationId: receipt.operationId,
                  attemptId: receipt.attemptId, summary: "远端结果已收到，但记录提交失败；重试只保存记录。", knownFacts: [], action: "retry_storage" })) });
              const previous = this.executionRecoveryCases.find(item => item.taskId === taskId);
              recovery.busyAttemptId = previous?.recovery.busyAttemptId;
              recovery.error = previous?.recovery.error;
              if (!recovery.items.length && !recovery.busyAttemptId && !recovery.error) continue;
              const targets = records.flatMap(op => op.intent.semantic.targets).filter((target, index, all) =>
                all.findIndex(row => JSON.stringify(row) === JSON.stringify(target)) === index);
              const value = { taskId, targets, recovery, title: archives.find(entry => entry.taskId === taskId)?.title
                ?? (taskId.startsWith("direct-") ? "直接操作记录" : "历史任务记录") };
              cases.push(previous ? Object.assign(previous, value) : value);
            }
            this.executionRecoveryCases = cases;
            this.executionLedgerReadError = archiveError;
            await Promise.all(this.tasks.map(task => this.refreshExecutionLedger(task.id)));
            if (!archiveError) this.persist(true);
          } catch (error) { this.executionLedgerReadError = `执行记录读取失败：${String(error)}`; }
        } while (ledgerScanQueued.has(this));
      })();
      ledgerScans.set(this, scan);
      try { await scan; } finally { ledgerScans.delete(this); }
    },

    async loadExecutionHistory(taskId?: string) {
      const parsed = readExecutionLedger(await listExecutionLedger(this, taskId));
      if (!parsed.compatible) throw new Error(parsed.issues.join("；"));
      let archives: TaskArchiveEntry[] = [], archiveIssue = "";
      try { archives = await listTaskArchives(); }
      catch (error) { archiveIssue = `任务归档暂不可读，以下仅展示可读的执行台账：${String(error)}`; }
      if (archiveIssue && !parsed.operations.length) throw new Error(archiveIssue);
      const ids = taskId ? [taskId] : [...new Set([...parsed.operations.map(op => op.taskId), ...archives.map(row => row.taskId)])]
        .filter(id => !this.tasks.some(task => task.id === id));
      return ids.map(id => {
        const task = this.tasks.find(task => task.id === id), archive = archives.find(entry => entry.taskId === id);
        const records = parsed.operations.filter(op => op.taskId === id);
        return { ...(archiveIssue ? { archiveIssue } : {}), taskId: id, title: task?.title ?? archive?.title ?? (id.startsWith("direct-") ? "直接操作记录" : "历史任务记录"),
          canOpen: !task && archive?.disposition === "active", removed: archive?.disposition === "removed",
          receipts: records.flatMap(op => op.attempts.map(attempt => ({ operationId: op.operationId, attemptId: attempt.id,
            title: executionRecordTitle(op, attempt.id, task), status: attempt.status, recordedAt: attempt.completedAt ?? attempt.startedAt,
            expected: op.intent.semantic.expected, action: op.intent.semantic.action, targets: op.intent.semantic.targets,
            late: attempt.late, evidenceRefs: attempt.outcome?.evidenceRefs ?? [] }))).sort((a, b) => b.recordedAt - a.recordedAt) };
      });
    },

    async openArchivedTask(taskId: string) {
      if (this.taskCacheReadError) throw new Error(this.taskCacheReadError);
      const archive = await readTaskArchive(taskId);
      if (!archive || archive.disposition !== "active" || !archive.snapshot) throw new Error("没有可恢复的原始任务快照；执行记录仍可查看。");
      const parsed = readTaskProjection([archive.snapshot]);
      if (!parsed.compatible) throw new Error(parsed.issues.join("；"));
      let task = this.tasks.find(task => task.id === taskId);
      if (!task) { task = initialTasks(parsed.tasks)[0]; this.tasks.unshift(task); }
      this.selectTask(taskId);
      await this.refreshExecutionLedger(taskId);
      this.executionRecoveryCases = this.executionRecoveryCases.filter(row => row.taskId !== taskId);
      this.persist(true);
      return task;
    },

    async refreshExecutionLedger(taskId: string) {
      const task = this.tasks.find(item => item.id === taskId);
      if (!task) { await this.restoreExecutionLedgerTasks(); return; }
      if (executingTaskSteps.get(task)?.current()) return;
      if (task.executionLedgerLoading) { ledgerRefreshQueued.add(task); return; }
      task.executionLedgerLoading = true;
      const dispatchRevision = ledgerDispatchRevisions.get(task) ?? 0;
      try {
        const owner = taskId.startsWith("direct-") ? directExecutionLedgerOwner : this;
        if (pendingExecutionReceipts(owner, taskId).length) {
          try { await flushPendingReceipts(owner, taskId); } catch { /* Keep the explicit save-only recovery action. */ }
        }
        const parsed = readExecutionLedger(await listExecutionLedger(this, taskId));
        if (!this.tasks.includes(task) || executingTaskSteps.get(task)?.current()) return;
        if ((ledgerDispatchRevisions.get(task) ?? 0) !== dispatchRevision) { ledgerRefreshQueued.add(task); return; }
        const pending = pendingExecutionReceipts(taskId.startsWith("direct-") ? directExecutionLedgerOwner : this, taskId);
        let acknowledgementFailed = false;
        if (parsed.compatible) {
          try { await this.persistExecutionAcknowledgements(taskId, parsed.operations); }
          catch { acknowledgementFailed = true; }
        }
        if (!this.tasks.includes(task) || executingTaskSteps.get(task)?.current()) return;
        if ((ledgerDispatchRevisions.get(task) ?? 0) !== dispatchRevision) { ledgerRefreshQueued.add(task); return; }
        if (parsed.compatible && restoreCommandEvidenceScopes(task, parsed.operations)) this.persist();
        const previousRecovery = task.executionLedgerRecovery;
        task.executionLedgerRecovery = { ...projectExecutionLedgerRecovery(parsed.operations, {
          servers: this.servers, task,
          appliedAttemptIds: executionReceiptSteps(task).flatMap(step => step.ledgerAppliedAttemptIds ?? []),
          verifiedAttemptIds: executionReceiptSteps(task).flatMap(step => step.ledgerVerifiedAttemptIds ?? []),
          issues: [...parsed.issues, ...(this.taskCacheReadError ? [this.taskCacheReadError] : [])],
          storageFailures: [...(acknowledgementFailed ? [{ kind: "storage_failed" as const, operationId: "",
            summary: "执行结果已保存，但任务确认记录保存失败。", knownFacts: ["重试仅保存本地确认，不执行远端操作。"], action: "retry_storage" as const }] : []),
            ...pending.map(receipt => ({ kind: "storage_failed" as const, operationId: receipt.operationId,
            attemptId: receipt.attemptId, summary: "远端结果已收到，但记录提交失败；重试只保存记录。",
            knownFacts: [receipt.remoteResultKnown ? "结果已知，禁止把保存失败当作远端执行失败。" : "派发结果仍不确定，保留原尝试。"], action: "retry_storage" as const }))],
        }), busyAttemptId: previousRecovery?.busyAttemptId, error: previousRecovery?.busyAttemptId ? previousRecovery.error : undefined };
        if (!parsed.compatible) task.executionLedgerError = { stage: "list", message: parsed.issues.join("；"), remoteResultKnown: false };
        else if (!pending.length && task.executionLedgerError && ["list", "result_commit"].includes(task.executionLedgerError.stage)) {
          const previousMessage = task.executionLedgerError.message;
          task.executionLedgerError = undefined;
          if (task.pauseReason?.startsWith(previousMessage)) task.pauseReason = "执行结果已保存，可基于已有证据继续任务；不会重新发送原操作。";
        }
      } catch (error) {
        if (!this.tasks.includes(task) || executingTaskSteps.get(task)?.current()) return;
        task.executionLedgerRecovery = projectExecutionLedgerRecovery([], { issues: [String(error)] });
        task.executionLedgerError = { stage: "list", message: String(error), remoteResultKnown: false };
      } finally {
        task.executionLedgerLoading = false;
        if (ledgerRefreshQueued.delete(task)) void this.refreshExecutionLedger(taskId);
      }
    },

    async retryExecutionLedgerStorage(taskId: string, _attemptId?: string) {
      const task = this.tasks.find(item => item.id === taskId);
      const recovery = task?.executionLedgerRecovery ?? this.executionRecoveryCases.find(item => item.taskId === taskId)?.recovery;
      if (!recovery || recovery.busyAttemptId) return;
      let error: string | undefined;
      recovery.busyAttemptId = _attemptId ?? "saving";
      try { await flushPendingReceipts(taskId.startsWith("direct-") ? directExecutionLedgerOwner : this, taskId); if (task) task.executionLedgerError = undefined; }
      catch (failure) { error = String(failure); }
      recovery.busyAttemptId = undefined;
      await this.refreshExecutionLedger(taskId);
      const current = task?.executionLedgerRecovery ?? this.executionRecoveryCases.find(item => item.taskId === taskId)?.recovery;
      if (current) current.error = error;
      this.persist(true);
    },

    async reconcileExecutionAttempt(taskId: string, attemptId: string) {
      const task = this.tasks.find(item => item.id === taskId);
      const recoveryCase = this.executionRecoveryCases.find(item => item.taskId === taskId);
      if (task && taskRemovals.has(task)) return;
      if (!task && !recoveryCase || (task?.executionLedgerRecovery ?? recoveryCase?.recovery)?.busyAttemptId) return;
      if (task && executingTaskSteps.get(task)?.current()) {
        if (task.executionLedgerRecovery) task.executionLedgerRecovery.error = "当前步骤仍在执行或验收，请等待结果后核对。";
        return;
      }
      const recovery = task ? task.executionLedgerRecovery ??= projectExecutionLedgerRecovery([]) : recoveryCase!.recovery;
      const epoch = task?.workflowEpoch, roundId = task?.currentRoundId, plan = task?.plan, incident = task?.executionReconciliation;
      const contextCurrent = () => task ? this.tasks.includes(task) && task.workflowEpoch === epoch
        && task.currentRoundId === roundId && task.plan === plan && !executingTaskSteps.get(task)?.current()
        : this.executionRecoveryCases.includes(recoveryCase!) && !this.tasks.some(row => row.id === taskId);
      recovery.busyAttemptId = attemptId;
      recovery.error = undefined;
      try {
        const parsed = readExecutionLedger(await listExecutionLedger(this, taskId));
        if (!parsed.compatible) throw new Error(parsed.issues.join("；"));
        const operation = parsed.operations.find(row => row.attempts.some(attempt => attempt.id === attemptId));
        if (!operation) throw new Error("找不到原始执行尝试，不能自动恢复");
        if (!contextCurrent()) throw new Error("任务上下文已变化，原记录保留，停止本次核对");
        const draft = buildReadOnlyReconciliation(operation, { id: taskId }, this.servers);
        if (draft.attemptId !== attemptId) throw new Error("仅允许核对该操作最新的未决尝试");
        const readIds: string[] = [];
        const originalStep = (task ? recoveryHistory(task) : []).find(step => step.id === operation.stepId);
        for (const read of draft.reads) {
          const stepId = `reconcile-${attemptId}-${read.role}`;
          const semantic = { ...operation.intent.semantic, taskId, stepId,
            action: { type: "shell" as const, command: read.command }, targets: [{ ...read.target, role: "execution" as const }],
            effect: "read" as const, kind: "observe" as const, risk: "low" as const, permission: "observe" as const,
            dependencies: { precedingStepIds: [] }, executionScope: "isolated_exec" as const,
            validation: undefined, validator: undefined, toolContract: undefined, runtimeClass: undefined };
          const intent: ExecutionIntentSnapshot = { version: "execution-intent@1", algorithm: "sha256",
            semantic, digest: executionDigest({ version: "execution-intent@1", semantic }) };
          const connection = this.getRuntimeConnection(read.serverId);
          if (!connection || connection.host.toLowerCase() !== read.target.host.toLowerCase()
            || connection.port !== read.target.port || connection.username !== read.target.username) throw new Error("原目标连接不可用或身份已变化，请连接原服务器后核对");
          const generation = this.serverConnection(read.serverId).generation;
          const executionId = uid("reconcile-read");
          await runRecordedExecution({ owner: this,
            task: { id: taskId, currentRoundId: roundId ?? operation.roundId, workflowEpoch: epoch ?? operation.workflowEpoch, planRevision: operation.planRevision },
            step: { id: stepId, executionIntent: intent }, phase: "validation", executionId,
            isCurrent: () => contextCurrent() && this.serverConnection(read.serverId).generation === generation,
            redact: text => redactExecutionOutput(text, { ...this.secretValues, password: connection.password }),
            execute: () => backend.executeCommand(read.command, connection, false, { executionId }),
            classifyResult: result => result.success ? "succeeded" : "failed", classifyError: () => "failed",
            onAttempt: operation => { readIds.push(operation.operationId); },
            onCommitted: (_operationId, id) => { if (originalStep) {
              (originalStep.ledgerAppliedAttemptIds ??= []).push(id); (originalStep.ledgerVerifiedAttemptIds ??= []).push(id);
            } },
          });
        }
        const proof = draft.kind === "file_transfer"
          ? { version: 1 as const, kind: "file_transfer" as const, sourceReadOperationId: readIds[0], targetReadOperationId: readIds[1] }
          : { version: 1 as const, kind: "service" as const, readOperationId: readIds[0] };
        if (!contextCurrent()) throw new Error("任务上下文已变化，新的只读证据保留在原核对记录中");
        const resolved = await resolveExecutionOperation(this, operation.operationId, attemptId, proof);
        if (!contextCurrent()) return;
        if (task && task.executionReconciliation === incident && incident?.stepId === operation.stepId && resolved.reconciliation) {
          incident.resolution = { incidentId: incident.id, status: "completed",
            evidenceIds: resolved.reconciliation.evidenceRefs, reason: "持久台账已核对新采集的同目标只读证据，当前状态满足原目标；原尝试保持原事实。" };
        }
        if (task) task.executionLedgerError = undefined;
        if (task) this.pushMessage(task, { role: "assistant", kind: "event", content: "只读证据已确认当前状态满足原目标，核对结果已落账。原尝试记录保留，不会重发原操作；后续变更仍需按当前计划授权。" });
      } catch (error) { recovery.error = String(error); }
      finally {
        const error = recovery.error;
        recovery.busyAttemptId = undefined;
        if (task?.executionLedgerRecovery) task.executionLedgerRecovery.busyAttemptId = undefined;
        await this.refreshExecutionLedger(taskId);
        const current = task?.executionLedgerRecovery ?? this.executionRecoveryCases.find(item => item.taskId === taskId)?.recovery;
        if (contextCurrent() && current) current.error = error;
        this.persist(true);
      }
    },

    saveTools() {
      this.toolSaveError = "";
      const normalized = this.tools.map(normalizeToolDefinition);
      const invalidTool = normalized.find((tool) => validateToolDefinition(tool).length > 0);
      if (invalidTool) {
        this.toolSaveError = `工具“${invalidTool.name || invalidTool.id}”的信息不完整`;
        throw new Error(this.toolSaveError);
      }
      this.tools = normalized;
      this.persist(true);
    },

    resetTool(toolId: string) {
      this.tools = resetToolDefinition(toolId, this.tools);
      this.toolSaveError = "";
      this.persist(true);
    },

    addSkill() {
      const skill = createCustomSkill(uid("skill"));
      skill.name = "";
      skill.description = "";
      skill.instructions = "";
      this.skills.push(skill);
      this.skillSaveError = "";
      return skill;
    },

    removeSkill(skillId: string) {
      const skill = this.skills.find((item) => item.id === skillId);
      if (!skill || skill.builtIn) return false;
      this.skills = this.skills.filter((item) => item.id !== skillId);
      this.skillSaveError = "";
      // Remove only this Skill from durable state. Other open editor drafts
      // remain in memory until their own Save button is used.
      persistOwnedSkills(loadOwnedSkills().filter((item) => item.builtIn || item.id !== skillId));
      return true;
    },

    saveSkill(skillId: string) {
      this.skillSaveError = "";
      const skill = this.skills.find((item) => item.id === skillId);
      if (!skill || skill.builtIn) return false;
      const normalized = normalizeSkillRegistry([skill])[0]!;
      const issues = validateSkillDefinition(normalized);
      if (issues.length) {
        this.skillSaveError = `Skill“${normalized.name || normalized.id}”的配置不完整`;
        throw new Error(this.skillSaveError);
      }
      const index = this.skills.findIndex((item) => item.id === skillId);
      this.skills[index] = normalized;
      const persisted = loadOwnedSkills().filter((item) => item.builtIn || item.id !== skillId);
      persistOwnedSkills([...persisted, normalized]);
      return true;
    },

    refreshOfficialContent() {
      this.skills = enforceSystemSkills(this.skills);
      this.tools = initialTools();
    },

    saveSkills() {
      this.skillSaveError = "";
      const normalized = enforceSystemSkills(normalizeSkillRegistry(this.skills));
      const duplicateId = normalized.find((skill, index) =>
        normalized.findIndex((candidate) => candidate.id === skill.id) !== index,
      );
      const invalid = normalized.find((skill) => validateSkillDefinition(skill).length > 0);
      if (duplicateId || invalid) {
        const target = duplicateId ?? invalid!;
        this.skillSaveError = duplicateId
          ? `Skill ID“${target.id}”重复`
          : `Skill“${target.name || target.id}”的配置不完整`;
        throw new Error(this.skillSaveError);
      }
      this.skills = normalized;
      this.persist(true);
    },

    resetSkill(skillId: string) {
      this.skills = resetSkillDefinition(skillId, this.skills);
      this.skillSaveError = "";
      this.persist(true);
    },

    async hydrateCredentials() {
      if (this.credentialsHydrated) return;
      if (credentialHydration) return credentialHydration;
      this.credentialsLoading = true;
      this.credentialError = "";
      credentialHydration = (async () => {
        const serverCredentials = await Promise.allSettled(
          this.servers.map(async (server) => ({
            id: server.id,
            value: await backend.loadCredential("server", server.id),
          })),
        );
        const modelCredentials = await Promise.allSettled(
          this.models
            .filter((model) => model.provider !== "Built-in" && model.source !== "official")
            .map(async (model) => ({
              id: model.id,
              value: await backend.loadCredential("model", model.id),
            })),
        );
        const scopedSecrets = this.secretMetadata.filter((secret) => secret.serverId);
        const secretCredentials = await Promise.allSettled(scopedSecrets.map(async (secret) => {
          const id = secretValueId(secret.serverId!, secret.key);
          let value = await backend.loadCredential("secret", id);
          if (!value) {
            value = await backend.loadCredential("secret", secret.key);
            if (value) {
              await backend.saveCredential("secret", id, value);
              await backend.deleteCredential("secret", secret.key);
            }
          }
          return { id, legacyKey: secret.key, value };
        }));
        for (const result of serverCredentials) {
          if (result.status === "fulfilled" && result.value.value) {
            this.serverPasswords[result.value.id] = result.value.value;
          }
        }
        for (const result of modelCredentials) {
          if (result.status === "fulfilled" && result.value.value) {
            this.modelApiKeys[result.value.id] = result.value.value;
            const model = this.models.find((item) => item.id === result.value.id);
            if (model) model.hasApiKey = true;
          }
        }
        for (const result of secretCredentials) {
          if (result.status === "fulfilled" && result.value.value) {
            this.secretValues[result.value.id] = result.value.value;
            // Compatibility mirror only. Runtime execution never reads unscoped keys.
            this.secretValues[result.value.legacyKey] = result.value.value;
          }
        }
        const rejected = [...serverCredentials, ...modelCredentials, ...secretCredentials]
          .find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") {
          // Partial reads must never be advertised as a complete hydration. In
          // particular, an empty in-memory value after a failed vault read
          // must not later be interpreted as an intentional deletion.
          this.credentialError = String(rejected.reason);
          this.credentialsHydrated = false;
          return;
        }
        // One-time migration for builds that kept a Git username inside a task
        // while persisting only the token as a server secret. Promote the most
        // recent complete pair into one durable server credential group.
        const migratedLegacyKeys = new Set<string>();
        // v5 could also persist both username and token as two unrelated
        // password secrets when prose inference classified both as usernames.
        // Reconstruct only fields submitted atomically by the same input card;
        // never pair unrelated flat secrets merely because their names look
        // compatible.
        for (const task of this.tasks) {
          const bindingsByInput = new Map<string, SubmittedSecretBinding[]>();
          Object.values(task.submittedSecretBindings ?? {}).forEach((binding) => {
            const bindings = bindingsByInput.get(binding.groupId) ?? [];
            bindings.push(binding);
            bindingsByInput.set(binding.groupId, bindings);
          });
          for (const bindings of bindingsByInput.values()) {
            if (bindings.length !== 2) continue;
            const pair = inferCredentialInputPair(bindings[0].groupTitle, bindings.map((binding) => ({
              key: binding.key,
              label: binding.label,
              description: binding.description,
              type: "password" as const,
              required: true,
            })));
            if (!pair) continue;
            const usernameBinding = bindings.find(({ key }) => key === pair.usernameField.key);
            const secretBinding = bindings.find(({ key }) => key === pair.secretField.key);
            if (!usernameBinding || !secretBinding) continue;
            const usernameMetadata = this.secretMetadata.find((item) => item.serverId === task.serverId
              && item.key === usernameBinding.key && !item.credentialGroupId);
            const secretMetadata = this.secretMetadata.find((item) => item.serverId === task.serverId
              && item.key === secretBinding.key && !item.credentialGroupId);
            const username = this.secretValues[secretValueId(task.serverId, usernameBinding.key)];
            const secret = this.secretValues[secretValueId(task.serverId, secretBinding.key)];
            if (!usernameMetadata || !secretMetadata || !username || !secret
              || credentialUsernameValidationError(pair.kind, username)) continue;
            const groupId = `credential-${usernameBinding.groupId}`;
            Object.assign(usernameMetadata, {
              credentialGroupId: groupId,
              credentialKind: pair.kind,
              credentialRole: "username",
              credentialTarget: pair.target,
              credentialLabel: pair.label,
            } satisfies Partial<SecretMetadata>);
            Object.assign(secretMetadata, {
              credentialGroupId: groupId,
              credentialKind: pair.kind,
              credentialRole: "secret",
              credentialTarget: pair.target,
              credentialLabel: pair.label,
            } satisfies Partial<SecretMetadata>);
            migratedLegacyKeys.add(`${task.serverId}::${usernameBinding.key}`);
            migratedLegacyKeys.add(`${task.serverId}::${secretBinding.key}`);
          }
        }
        for (const task of this.tasks) {
          for (const [secretKey, binding] of Object.entries(task.submittedSecretBindings ?? {})) {
            const migrationKey = `${task.serverId}::${secretKey}`;
            if (migratedLegacyKeys.has(migrationKey)) continue;
            const secretMetadata = this.secretMetadata.find((item) => item.serverId === task.serverId
              && item.key === secretKey
              && !item.credentialGroupId);
            const secretValue = this.secretValues[secretValueId(task.serverId, secretKey)];
            if (!secretMetadata || !secretValue) continue;
            const usernameCandidates = Object.entries(task.submittedInputs ?? {})
              .filter(([, input]) => input.groupId === binding.groupId
                && input.type === "text"
                && typeof input.value === "string"
                && /git|gitee|github|gitlab|仓库|源码/i.test(`${input.label} ${input.description} ${input.groupTitle}`)
                && /用户名|登录名|账号|账户|user\s*name|login|account/i.test(`${input.label} ${input.description}`));
            if (usernameCandidates.length !== 1) continue;
            const [inputKey, usernameInput] = usernameCandidates[0];
            const pair = inferCredentialInputPair(binding.groupTitle, [{
              key: inputKey,
              label: usernameInput.label,
              description: usernameInput.description,
              type: "text",
              required: true,
            }, {
              key: secretKey,
              label: binding.label,
              description: binding.description,
              type: "password",
              required: true,
            }]);
            if (!pair || pair.kind !== "git-https" || !pair.target) continue;
            const { usernameKey } = allocateCredentialPairKeys(
              this.secretMetadata.filter((item) => item.serverId === task.serverId && item !== secretMetadata),
              inputKey,
              `${secretKey}_RESERVED`,
            );
            const username = String(usernameInput.value).trim();
            try {
              await backend.saveCredential("secret", secretValueId(task.serverId, usernameKey), username);
            } catch (error) {
              this.credentialError = `旧凭据组迁移失败：${String(error)}`;
              continue;
            }
            const groupId = `credential-${binding.groupId}`;
            Object.assign(secretMetadata, {
              credentialGroupId: groupId,
              credentialKind: pair.kind,
              credentialRole: "secret",
              credentialTarget: pair.target,
              credentialLabel: binding.groupTitle,
            } satisfies Partial<SecretMetadata>);
            this.secretMetadata.push({
              key: usernameKey,
              description: usernameInput.description,
              scope: "server",
              serverId: task.serverId,
              credentialGroupId: groupId,
              credentialKind: pair.kind,
              credentialRole: "username",
              credentialTarget: pair.target,
              credentialLabel: binding.groupTitle,
            });
            this.secretValues[secretValueId(task.serverId, usernameKey)] = username;
            this.tasks.filter((candidate) => candidate.serverId === task.serverId).forEach((candidate) => {
              const legacyGroupIds = new Set(Object.values(candidate.submittedSecretBindings ?? {})
                .filter((candidateBinding) => candidateBinding.key === secretKey)
                .map((candidateBinding) => candidateBinding.groupId));
              Object.entries(candidate.submittedInputs ?? {}).forEach(([candidateKey, input]) => {
                if (legacyGroupIds.has(input.groupId)
                  && /git|gitee|github|gitlab|仓库|源码/i.test(`${input.label} ${input.description} ${input.groupTitle}`)
                  && /用户名|登录名|账号|账户|user\s*name|login|account/i.test(`${input.label} ${input.description}`)) {
                  delete candidate.submittedInputs?.[candidateKey];
                }
              });
              Object.assign(candidate, scrubPersistedCredentialValue(
                candidate,
                username,
                `\${secret.${usernameKey}}`,
              ));
            });
            this.logs = this.logs.map((event) => event.serverId === task.serverId
              ? scrubPersistedCredentialValue(event, username, `\${secret.${usernameKey}}`)
              : event);
            this.developerLogs = this.developerLogs.map((event) => event.serverId === task.serverId
              ? scrubPersistedCredentialValue(event, username, `\${secret.${usernameKey}}`)
              : event);
            task.submittedSecretBindings![usernameKey] = {
              key: usernameKey,
              label: usernameInput.label,
              description: usernameInput.description,
              groupId,
              groupTitle: binding.groupTitle,
              submittedAt: binding.submittedAt,
            };
            migratedLegacyKeys.add(migrationKey);
          }
        }
        this.credentialsHydrated = true;
        this.persist(true);
      })().finally(() => {
        this.credentialsLoading = false;
        credentialHydration = undefined;
      });
      return credentialHydration;
    },

    async ensureServerConnected(serverId: string) {
      await this.hydrateCredentials();
      if (this.isServerConnected(serverId)) return true;
      // Revisiting a failed/disconnected tab must not reset the user's retry budget.
      if (this.serverConnection(serverId).status !== "idle") return false;
      const password = this.serverPasswords[serverId];
      if (!password) return false;
      return this.connectServer(serverId, password, false);
    },

    addLog(event: Omit<AuditEvent, "id" | "createdAt">) {
      const task = event.taskId
        ? this.tasks.find((item) => item.id === event.taskId)
        : undefined;
      // A task is always owned by one server. Deriving the server here keeps
      // every task event in the correct server bucket even when a caller only
      // knows the task ID.
      const serverId = event.serverId ?? task?.serverId;
      const server = serverId
        ? this.servers.find((item) => item.id === serverId)
        : undefined;
      this.logs = prependAuditEvent(
        this.logs,
        createAuditEvent({
          ...event,
          serverId,
          // Keep a human-readable snapshot alongside IDs. This is important for
          // audit history: deleting or renaming a task must not make old records
          // impossible to identify.
          serverName: event.serverName ?? server?.name,
          taskTitle: event.taskTitle ?? task?.title,
        }, uid("log"), now()),
      );
      const entry = this.logs[0];
      const knownLogSecrets = { ...this.serverPasswords, ...this.modelApiKeys, ...this.secretValues };
      const safeEntry = Object.fromEntries(Object.entries(entry).map(([key, value]) =>
        [key, typeof value === "string" ? redactExecutionOutput(value, knownLogSecrets) : value]));
      void backend.appendTaskLog?.("events", safeEntry, task ? modelLogContext(task) : { taskId: event.taskId, serverId })
        ?.catch(() => console.warn("任务操作日志写入失败，界面日志仍保留"));
      this.persist();
    },

    addDeveloperLog(event: DeveloperLogDraft) {
      const task = event.taskId
        ? this.tasks.find((item) => item.id === event.taskId)
        : undefined;
      const serverId = event.serverId ?? task?.serverId;
      const server = serverId
        ? this.servers.find((item) => item.id === serverId)
        : undefined;
      const knownSecrets = {
        ...this.serverPasswords,
        ...this.modelApiKeys,
        ...this.secretValues,
      };
      this.developerLogs = prependDeveloperLog(
        this.developerLogs,
        createDeveloperLog({
          ...event,
          serverId,
          serverName: event.serverName ?? server?.name,
          taskTitle: event.taskTitle ?? task?.title,
        }, uid("devlog"), now(), knownSecrets),
      );
      void backend.appendTaskLog?.("developer-events", this.developerLogs[0], task ? modelLogContext(task) : { taskId: event.taskId, serverId })
        ?.catch(() => console.warn("开发者任务日志写入失败，界面日志仍保留"));
      this.persist();
    },

    async refreshServer(serverId: string) {
      const server = this.servers.find((item) => item.id === serverId);
      const connection = this.getRuntimeConnection(serverId);
      if (!server || !connection || this.collectingServers.includes(serverId)) return;
      const generation = this.serverConnection(serverId).generation;
      this.collectingServers.push(serverId);
      this.isCollecting = true;
      try {
        const probe = await backend.probeSsh(connection);
        if (!this.isServerConnected(serverId) || this.serverConnection(serverId).generation !== generation) return;
        server.info = probe.info;
        server.environment = probe.environment;
        this.addLog({
          category: "system",
          level: "success",
          title: "服务器信息已刷新",
          detail: `${server.name} 连接测试成功，基础信息采集完成`,
          serverId,
        });
      } catch (error) {
        if (this.serverConnection(serverId).generation !== generation) return;
        this.reportConnectionFailure(serverId, String(error));
        this.addLog({
          category: "system",
          level: "error",
          title: "服务器环境采集失败",
          detail: String(error),
          serverId,
        });
      } finally {
        this.collectingServers = this.collectingServers.filter(id => id !== serverId);
        this.isCollecting = this.collectingServers.length > 0;
        this.persist();
      }
    },

    async connectServer(serverId: string, password: string, remember = true, isCurrent?: () => boolean): Promise<boolean> {
      const server = this.servers.find(item => item.id === serverId);
      if (!server || !password) return false;
      const requested = {
        host: server.host, port: server.port, username: server.username, password,
      };
      let pending = pendingServerCredentials.get(this);
      if (!pending) { pending = new Map(); pendingServerCredentials.set(this, pending); }
      const existing = pending.get(serverId);
      if (existing && sameServerConnection(existing.connection, requested)) existing.remember ||= remember;
      else {
        pending.set(serverId, { connection: requested, remember, isCurrent });
        // Clear the prior identity's cache BEFORE publishing connected. Clearing
        // it afterward would invalidate the directory load triggered by that event.
        if (this.serverPasswords[serverId] !== password) useFileWorkspaceStore().clearServerCache(serverId);
      }
      const verified = await useConnectionStore().connect(serverId, requested);
      const current = this.getRuntimeConnection(serverId);
      const connected = verified && Boolean(current && current.host === requested.host
        && current.port === requested.port && current.username === requested.username
        && current.password === requested.password);
      if (isCurrent && !isCurrent()) {
        pending.delete(serverId);
        return connected;
      }
      this.syncConnectionStates();
      if (connected && this.isServerConnected(serverId)) {
        await this.commitVerifiedServerCredential(serverId);
      }
      this.persist();
      return connected && sameServerConnection(this.getRuntimeConnection(serverId), requested);
    },

    disconnectServer(serverId: string) {
      pendingServerCredentials.get(this)?.delete(serverId);
      const hadCredential = Boolean(this.serverPasswords[serverId]);
      delete this.serverPasswords[serverId];
      if (hadCredential) markTaskCredentialRevision(this.tasks, serverId, this.secretMetadata);
      useConnectionStore().disconnect(serverId);
      this.syncConnectionStates();
      const server = this.servers.find((item) => item.id === serverId);
      if (server) server.status = "offline";
    },

    async refreshMetrics(serverId?: string) {
      if (!serverId) return;
      const connection = this.getRuntimeConnection(serverId);
      if (!connection) return;
      if (!this.metricsByServer[serverId]) this.metricsByServer[serverId] = {
        loading: false, stale: true, requestVersion: 0, lastAttemptAt: 0,
      };
      const metric = this.metricsByServer[serverId];
      if (metric.loading) return;
      metric.loading = true;
      metric.lastAttemptAt = Date.now();
      const version = ++metric.requestVersion;
      const generation = this.serverConnection(serverId).generation;
      try {
        const sample = await backend.getSshMetrics(connection);
        if (metric.requestVersion !== version || !this.isServerConnected(serverId)
          || this.serverConnection(serverId).generation !== generation) return;
        metric.sample = sample;
        metric.stale = false;
        metric.error = undefined;
      } catch (error) {
        if (metric.requestVersion !== version || this.serverConnection(serverId).generation !== generation) return;
        metric.stale = true;
        metric.error = String(error);
        this.reportConnectionFailure(serverId, String(error));
      } finally {
        if (metric.requestVersion === version) metric.loading = false;
      }
    },

    async executeToolCall(
      serverId: string,
      call: ToolCall,
      onProgress?: (message: string) => void,
      _legacyPaneId?: string,
      taskId?: string,
      onDispatch?: () => void,
      options?: { prepared?: boolean; assertCurrent?: () => void; assertPrepared?: () => void },
    ) {
      const ownerTask = taskId ? this.tasks.find(task => task.id === taskId) : undefined;
      const owner = ownerTask ? workflowLifetime(ownerTask) : undefined;
      const assertCapabilities = () => {
        owner?.assertCurrent();
        options?.assertCurrent?.();
        if (!taskId) return;
        const task = this.tasks.find(item => item.id === taskId);
        if (!task) throw new Error("任务已失效，拒绝派发工具");
        const blocker = executionCapabilityBlocker(task, { action: { type: "tool", toolId: call.toolId, arguments: call.arguments }, command: "", validation: "" }, this.skills);
        if (blocker) throw new Error(blocker);
      };
      assertCapabilities();
      const connection = this.getRuntimeConnection(serverId);
      const generation = this.serverConnection(serverId).generation;
      const assertConnection = () => {
        assertCapabilities();
        if (!this.getRuntimeConnection(serverId) || this.serverConnection(serverId).generation !== generation) {
          throw new Error("SSH 连接已断开或更换，已停止派发远程操作");
        }
      };
      const startedAt = performance.now();
      const result = await executeRegisteredToolCall(call, this.tools, {
        readEvidence: async (evidenceId, offset, limit) => {
          const current = this.tasks.find(candidate => candidate.id === taskId);
          if (!current) throw new Error("缺少证据所属任务");
          onDispatch?.();
          return backend.readTaskEvidence(current.id, evidenceId, offset, limit);
        },
        resolveServerConnection: async (
          request: ServerConnectionLookupRequest,
        ): Promise<ServerConnectionLookupResult> => {
          const port = request.port ?? 22;
          assertCapabilities();
          const target = resolveUniqueServerEndpoint(this.servers, request.host, port);
          const scopedSecrets = serverSecretValues(this.secretValues, serverId);
          const reusableGroups = collectServerCredentialGroups(this.secretMetadata, serverId)
            .filter((group) => group.kind === "ssh-password"
              && group.target?.toLocaleLowerCase() === request.host.toLocaleLowerCase()
              && Boolean(scopedSecrets[group.username.key])
              && Boolean(scopedSecrets[group.secret.key]));
          const reusableGroup = reusableGroups.length === 1 ? reusableGroups[0] : undefined;
          const managedCredentialAvailable = Boolean(target && this.serverPasswords[target.id]);
          const credentialAvailable = managedCredentialAvailable || Boolean(reusableGroup);
          onDispatch?.();
          return {
            found: Boolean(target || reusableGroup),
            serverId: target?.id,
            host: request.host,
            port,
            username: target?.username,
            credentialAvailable,
            credentialRef: managedCredentialAvailable && target
              ? `managed-server:${target.id}`
              : reusableGroup
                ? `server-credential:${reusableGroup.id}`
                : undefined,
          };
        },
        connectServer: async (request: ServerConnectRequest): Promise<ServerConnectResult> => {
          const partial: Record<string, unknown> = { connectionCheckDispatched: false, connectionChecked: false,
            directoryUpdated: false, connected: false, taskTargetUpdated: false, agentSessionCreationDispatched: false,
            agentSessionPrepared: false, credentialStorageDispatched: false, credentialStored: false };
          const initialSource = this.servers.find(server => server.id === serverId);
          const identity = (server: ServerProfile | undefined) => server
            ? stableProtocolValue({ id: server.id, host: server.host, port: server.port, username: server.username }) : undefined;
          const initialSourceIdentity = identity(initialSource);
          let sourceGeneration = generation;
          let expectedTaskTarget = ownerTask ? executionServerId(ownerTask) : undefined;
          const initialPermission = ownerTask?.permission;
          const initialConstraints = stableProtocolValue(ownerTask?.executionConstraints);
          let target: ServerProfile | undefined;
          let targetIdentity: string | undefined;
          let targetGeneration: number | undefined;
          let connecting = false;
          let username: string | undefined;
          let principalCurrent: (() => boolean) | undefined;
          const guard = () => {
            assertCapabilities();
            if (ownerTask && (ownerTask.permission !== initialPermission
              || stableProtocolValue(ownerTask.executionConstraints) !== initialConstraints
              || executionServerId(ownerTask) !== expectedTaskTarget)) throw new Error("复合工具的任务授权或执行目标已变化");
            if ((initialSource && this.servers.filter(server => server.id === serverId).length !== 1)
              || identity(this.servers.find(server => server.id === serverId)) !== initialSourceIdentity
              || !(connecting && target?.id === serverId) && this.serverConnection(serverId).generation !== sourceGeneration) {
              throw new Error("复合工具的源服务器身份或连接已变化");
            }
            if (target && (this.servers.filter(server => server.id === target!.id).length !== 1
              || identity(this.servers.find(server => server.id === target!.id)) !== targetIdentity
              || !connecting && targetGeneration !== undefined && this.serverConnection(target.id).generation !== targetGeneration)) {
              throw new Error("复合工具的目标服务器身份或连接已变化");
            }
            if (principalCurrent && !principalCurrent()) throw new Error("复合工具的凭据主体或引用已变化");
          };
          try {
            guard();
            const port = request.port ?? 22;
            username = request.username;
            let password: string | undefined;
            let usernamePlaceholder: string | undefined;
            if (request.credentialRef?.startsWith("managed-server:")) {
              const targetId = request.credentialRef.slice("managed-server:".length);
              const managedTarget = resolveUniqueServer(this.servers, targetId);
              if (!managedTarget || managedTarget.id !== targetId || managedTarget.host !== request.host || managedTarget.port !== port) {
                throw new Error("credentialRef 与目标服务器不匹配，请重新查询连接资料");
              }
              target = managedTarget;
              username = managedTarget.username;
              password = this.serverPasswords[managedTarget.id];
              principalCurrent = () => this.servers.find(server => server.id === targetId)?.username === username;
            } else if (request.credentialRef?.startsWith("server-credential:")) {
              const credentialGroupId = request.credentialRef.slice("server-credential:".length);
              const credentialGroup = collectServerCredentialGroups(this.secretMetadata, serverId).find(group => group.id === credentialGroupId);
              if (!credentialGroup || credentialGroup.kind !== "ssh-password"
                || credentialGroup.target?.toLocaleLowerCase() !== request.host.toLocaleLowerCase()) {
                throw new Error("credentialRef 与目标服务器不匹配，请重新查询连接资料");
              }
              const scopedSecrets = serverSecretValues(this.secretValues, serverId);
              const groupedUsername = scopedSecrets[credentialGroup.username.key];
              if (request.username && request.username !== groupedUsername) throw new Error("用户名与 credentialRef 对应的服务器凭据组不匹配");
              username = groupedUsername;
              password = scopedSecrets[credentialGroup.secret.key];
              usernamePlaceholder = `\${secret.${credentialGroup.username.key}}`;
              principalCurrent = () => {
                const current = collectServerCredentialGroups(this.secretMetadata, serverId).find(group => group.id === credentialGroupId);
                return Boolean(current && current.kind === credentialGroup.kind && current.target === credentialGroup.target
                  && current.username.key === credentialGroup.username.key && current.secret.key === credentialGroup.secret.key
                  && serverSecretValues(this.secretValues, serverId)[current.username.key] === username);
              };
            } else if (request.passwordSecretKey) password = serverSecretValues(this.secretValues, serverId)[request.passwordSecretKey];
            if (!username) throw new Error("缺少目标服务器 SSH 用户名，请先查询连接资料或向用户收集");
            if (credentialUsernameValidationError("ssh-password", username)) throw new Error("SSH 凭据组中的用户名格式不安全，请在敏感信息管理中修正");
            if (!password) throw new Error("缺少目标服务器 SSH 密码，请先查询连接资料或通过用户输入工具安全收集");
            target ??= resolveUniqueServerEndpoint(this.servers, request.host, port, username);
            targetIdentity = identity(target);
            targetGeneration = target ? this.serverConnection(target.id).generation : undefined;
            guard();
            onDispatch?.();
            partial.connectionCheckDispatched = true;
            await backend.checkSshConnection({ host: request.host, port, username, password }, 15_000);
            partial.connectionChecked = true;
            guard();
            // No intentional local identity changes have happened yet: recheck the complete prepared snapshot.
            options?.assertPrepared?.();
            if (!target && resolveUniqueServerEndpoint(this.servers, request.host, port)) throw new Error("目标服务器目录在连接检查期间已变化，请重新准备");
            if (target) {
              if (request.name) target.name = request.name;
              if (request.group) target.group = request.group;
            } else {
              target = this.addServer({ name: request.name ?? request.host, host: request.host, port, username, group: request.group ?? "智能连接" });
              targetIdentity = identity(target);
              targetGeneration = this.serverConnection(target.id).generation;
            }
            partial.directoryUpdated = true;
            partial.serverId = target.id;
            guard();
            connecting = true;
            const connected = await this.connectServer(target.id, password, false, () => {
              try { guard(); return true; } catch { return false; }
            });
            // A verified connection remains a fact even if cancellation arrives during the await.
            partial.connected = connected;
            connecting = false;
            targetGeneration = this.serverConnection(target.id).generation;
            if (target.id === serverId) sourceGeneration = targetGeneration;
            guard();
            if (!connected) throw new Error(this.serverConnection(target.id).error || "SSH 连接未成功");
            const task = taskId ? this.tasks.find(candidate => candidate.id === taskId) : undefined;
            if (task) {
              task.executionTargetServerId = target.id;
              expectedTaskTarget = target.id;
              partial.taskTargetUpdated = true;
              guard();
              partial.agentSessionCreationDispatched = isTauri() && agentSandboxTerminalV1Enabled();
              const session = await this.ensureTaskAgentSession(task.id, () => {
                try { guard(); return true; } catch { return false; }
              });
              partial.agentSessionPrepared = Boolean(session);
              guard();
            }
            guard();
            partial.credentialStorageDispatched = true;
            try {
              await backend.saveCredential("server", target.id, password);
              partial.credentialStored = true;
            } catch (error) {
              this.credentialError = String(error);
              throw error;
            }
            guard();
            this.persist(true);
            return { serverId: target.id, name: target.name, host: target.host, port: target.port,
              username: usernamePlaceholder ?? target.username, connected: true,
              info: { agentTarget: true, credentialRef: request.credentialRef } };
          } catch (error) {
            throw new ToolExecutionError(error instanceof Error ? error.message : String(error),
              error instanceof ToolExecutionError ? error.category : "business",
              partial.connectionChecked ? "sent" : partial.connectionCheckDispatched ? "unknown" : "not_sent",
              error instanceof ToolExecutionError ? error.retryAfterMs : undefined, { ...partial });
          }
        },
        expandPlanningContext: async (skillId) => {
          const current = this.tasks.find((candidate) => candidate.id === taskId);
          if (!current || !resolveTaskSkills(current, this.skills).some((skill) => skill.id === skillId)) {
            throw new Error("只能展开当前任务已激活的 Skill");
          }
          onDispatch?.();
          return { skillId };
        },
        getRemoteFileStructure: (request) => {
          assertConnection();
          onDispatch?.();
          return backend.getRemoteFileStructure(connection!, request);
        },
        readRemoteFileContent: async (request: FileContentRequest): Promise<FileContentResult> => {
          assertConnection();
          const maxBytes = request.maxBytes ?? 65_536;
          onDispatch?.();
          const file = await backend.readSftpFilePrefix(connection!, request.path, maxBytes);
          const sampled = file.data;
          let content: string;
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(sampled);
          } catch {
            throw new Error("文件不是有效的 UTF-8 文本，已拒绝将二进制内容发送给模型");
          }
          const scopedSecrets = serverSecretValues(this.secretValues, serverId);
          return {
            path: request.path,
            content: redactExecutionOutput(content, scopedSecrets),
            totalBytes: file.totalBytes,
            returnedBytes: sampled.byteLength,
            truncated: file.totalBytes > sampled.byteLength,
            encoding: "utf-8",
          };
        },
        inspectOperations: async (toolId, request) => {
          assertConnection();
          options?.assertPrepared?.();
          const command = buildOperationsCommand(toolId, request);
          onDispatch?.();
          const result = await backend.executeCommand(command, connection, false, {
            executionId: call.id, captureStreams: true,
            onProgress: (event) => {
              // Never stream service logs, file names or the echoed probe into progress UI.
              const count = event.data.match(/(?:^|\n)OPSARK_PROGRESS (\d+)/)?.[1];
              if (count) onProgress?.(`正在检查，已读取 ${count} 个条目…`);
            },
          });
          if (!result.success) throw new ToolExecutionError(`运维检查未正常返回（退出码 ${result.exitCode ?? "未知"}）`, "output", "sent");
          let data: ReturnType<typeof parseOperationsOutput>;
          try {
            if (typeof result.stdout !== "string") throw new Error("执行器未提供独立 stdout，请重启并更新 Core 原生进程");
            if (result.stdoutTruncated) throw new Error("结构化 stdout 已达到捕获上限，拒绝把截断结果视为有效 JSON");
            data = parseOperationsOutput(toolId, request, result.stdout);
          } catch (error) {
            const secrets = { ...serverSecretValues(this.secretValues, serverId), connectionPassword: connection?.password ?? "" };
            const diagnostic = {
              toolId, executionId: call.id, exitCode: result.exitCode,
              stdoutPresent: typeof result.stdout === "string", stdoutTruncated: result.stdoutTruncated,
              // Redact before slicing so credentials spanning a boundary cannot leak.
              stdout: redactExecutionOutput(result.stdout ?? "", secrets).slice(0, 16384),
              stderr: redactExecutionOutput(result.stderr ?? "", secrets).slice(0, 4096),
              capturedPartial: true,
            };
            let evidenceId: string | undefined;
            if (taskId && isTauri()) {
              try { evidenceId = await backend.saveTaskEvidence(taskId, {
                text: JSON.stringify(diagnostic), collectedAt: now(), capturedPartial: true,
                serverId, executionId: call.id, kind: "tool_output_diagnostic",
              }); } catch { /* The original protocol failure must remain the reported failure. */ }
            }
            this.addLog({ category: "tool", level: "error", title: "工具输出协议诊断",
              detail: JSON.stringify({ ...diagnostic, evidenceId }), taskId, serverId });
            throw new ToolExecutionError(`运维检查输出协议异常：${error instanceof Error ? error.message : String(error)}${evidenceId ? `；诊断证据 evidenceId=${evidenceId}` : ""}`, "output", "sent");
          }
          // Redact only observation strings; request identity stays byte-exact for contract validation.
          const scopedSecrets = { ...serverSecretValues(this.secretValues, serverId), connectionPassword: connection?.password ?? "" };
          for (const item of data.items) {
            for (const key of ["text", "subject"]) if (typeof item[key] === "string") item[key] = redactExecutionOutput(item[key] as string, scopedSecrets);
          }
          for (const item of data.skipped) item.path = redactExecutionOutput(item.path, scopedSecrets);
          return data;
        },
        checkSoftware: async (request) => {
          assertConnection();
          const command = buildSoftwareCheckCommand(request);
          onDispatch?.();
          const result = await backend.executeCommand(command, connection, false, {
            executionId: call.id,
            onProgress: (event) => onProgress?.(event.data),
          });
          if (!result.success) throw new Error(`软件检查命令退出码为 ${result.exitCode}`);
          return parseSoftwareCheckOutput(result.output);
        },
        transferFileBetweenServers: async (request: ServerFileTransferRequest) => {
          assertConnection();
          const target = resolveUniqueServer(this.servers, request.targetServer);
          if (!target) throw new Error(`目标服务器“${request.targetServer}”尚未加入服务器管理`);
          if (target.id === serverId) throw new Error("源服务器和目标服务器不能相同");
          const targetConnection = this.getRuntimeConnection(target.id);
          if (!targetConnection) throw new Error(`目标服务器“${target.name}”缺少已保存的连接凭据，请先在服务器管理中连接该服务器`);
          onDispatch?.();
          const transfer = await backend.transferSftpBetweenServers(
            connection!, targetConnection, call.id, request.sourcePath, request.targetPath,
            request.overwrite === true,
            (event) => {
              const percent = event.totalBytes > 0
                ? Math.min(100, Math.round((event.transferredBytes / event.totalBytes) * 100))
                : 0;
              onProgress?.(`正在传输到 ${target.host}：${percent}%`);
            },
          );
          return { ...transfer, targetServerId: target.id };
        },
      }, { prepared: options?.prepared });
      if (!result.success && this.serverConnection(serverId).generation === generation) {
        this.reportConnectionFailure(serverId, result.error?.message || "");
      }
      this.addLog({
        category: "tool",
        level: result.success ? "success" : "error",
        title: result.success ? "工具调用完成" : "工具调用失败",
        detail: JSON.stringify({
          toolId: call.toolId,
          callId: call.id,
          arguments: call.arguments,
          result: result.success ? {
            truncated: result.truncated,
          } : result.error,
          partialData: result.success ? undefined : result.data,
          elapsedMs: Math.round(performance.now() - startedAt),
        }, null, 2),
        serverId,
        taskId,
      });
      return result;
    },

    async getRemoteFileStructure(serverId: string, request: FileStructureRequest) {
      const result = await this.executeToolCall(serverId, {
        id: uid("tool-call"),
        toolId: "files.get_structure",
        arguments: { ...request },
      });
      if (!result.success) throw new Error(result.error?.message ?? "文件数据结构获取失败");
      return result.data as FileStructureResult;
    },

    getRuntimeConnection(serverId: string) {
      const server = this.servers.find((item) => item.id === serverId);
      const connection = useConnectionStore().connection(serverId);
      return server && connection && server.host === connection.host
        && server.port === connection.port && server.username === connection.username ? connection : undefined;
    },

    async ensureTaskAgentSession(taskId: string, isCurrent: () => boolean = () => true) {
      const task = this.tasks.find(({ id }) => id === taskId);
      const targetServerId = task ? executionServerId(task) : undefined;
      const connection = targetServerId ? this.getRuntimeConnection(targetServerId) : undefined;
      if (!task || task.cancelRequested || task.status === "cancelled"
        || !connection || !isTauri() || !agentSandboxTerminalV1Enabled()) return undefined;
      const lifetime = workflowLifetime(task);
      const connectionGeneration = this.serverConnection(targetServerId!).generation;
      const terminals = useAgentTerminalStore();
      const previous = terminals.sessionsByTask[taskId];
      const previousState = previous?.state;
      const previousGeneration = previous?.generation;
      const session = await backend.createAgentTerminal(targetServerId!, task.id, {
        host: connection.host,
        port: connection.port,
        username: connection.username,
      });
      const current = terminals.sessionsByTask[taskId];
      if (!isCurrent() || !lifetime.current() || !this.tasks.includes(task) || executionServerId(task) !== targetServerId
        || this.serverConnection(targetServerId!).generation !== connectionGeneration
        || !sameServerConnection(this.getRuntimeConnection(targetServerId!), connection)
        || current !== previous || current?.generation !== previousGeneration
        || current?.state !== previousState || (previousState === "busy" && session.state !== "busy")
        || session.taskId !== taskId || session.serverId !== targetServerId) return undefined;
      task.agentSessionId = session.id;
      task.agentSessionGeneration = session.generation;
      terminals.registerSession(session);
      return session;
    },

    addServer(
      input: Pick<ServerProfile, "name" | "host" | "port" | "username" | "group">,
      password = "",
    ) {
      const server: ServerProfile = {
        ...input,
        id: uid("srv"),
        status: password ? "testing" : "offline",
        environment: [],
        info: { ...emptyServerInfo },
        createdAt: now(),
      };
      this.servers.push(server);
      this.persist(true);
      if (password) void this.connectServer(server.id, password);
      return server;
    },

    updateServer(
      serverId: string,
      input: Pick<ServerProfile, "name" | "host" | "port" | "username" | "group">,
      password = "",
    ) {
      const server = this.servers.find((item) => item.id === serverId);
      if (!server) return;
      const connectionChanged = server.host !== input.host
        || server.port !== input.port
        || server.username !== input.username;
      Object.assign(server, input);
      if (connectionChanged || password) markTaskCredentialRevision(this.tasks, serverId, this.secretMetadata);
      this.persist(true);
      const credential = password || this.serverPasswords[serverId];
      if (connectionChanged || password) {
        useConnectionStore().disconnect(serverId);
        useFileWorkspaceStore().clearServerCache(serverId);
        const metric = this.metricsByServer[serverId];
        if (metric) metric.requestVersion += 1;
        delete this.metricsByServer[serverId];
        server.status = credential ? "testing" : "offline";
      }
      if (credential && (password || connectionChanged)) void this.connectServer(serverId, credential, Boolean(password));
    },

    removeServer(serverId: string) {
      pendingServerCredentials.get(this)?.delete(serverId);
      const removedSecrets = this.secretMetadata.filter((secret) => secret.serverId === serverId);
      this.servers = this.servers.filter((server) => server.id !== serverId);
      this.secretMetadata = this.secretMetadata.filter((secret) => secret.serverId !== serverId);
      for (const secret of removedSecrets) delete this.secretValues[secretValueId(serverId, secret.key)];
      delete this.serverPasswords[serverId];
      useConnectionStore().forget(serverId);
      const metric = this.metricsByServer[serverId];
      if (metric) metric.requestVersion += 1;
      delete this.metricsByServer[serverId];
      useFileWorkspaceStore().removeServer(serverId);
      useAgentWorkspaceStore().removeServer(serverId);
      void backend.deleteCredential("server", serverId);
      void Promise.allSettled(removedSecrets.map((secret) => (
        backend.deleteCredential("secret", secretValueId(serverId, secret.key))
      )));
      this.persist(true);
    },

    createTask(serverId: string, permission: PermissionLevel, modelId: string) {
      const task: OpsTask = {
        id: uid("task"),
        serverId,
        title: "新任务",
        status: "draft",
        permission,
        modelId,
        messages: [],
        plan: [],
        planHistory: [],
        phaseHistory: [],
        currentRoundId: uid("round"),
        createdAt: now(),
        updatedAt: now(),
        adjustmentCount: 0,
        adjustmentInProgress: false,
        credentialRevision: 0,
        confirmedSecretKeys: [],
        submittedInputs: {},
        submittedSecretBindings: {},
      };
      this.tasks.unshift(task);
      const reactiveTask = this.tasks[0];
      this.activeTaskId = reactiveTask.id;
      this.persist();
      return reactiveTask;
    },

    selectTask(taskId: string) {
      this.activeTaskId = taskId;
      void this.refreshExecutionLedger(taskId);
    },

    async deleteTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task) return false;
      if (
        task.currentExecutionId || task.requirementProcessing || task.adjustmentInProgress || taskRemovals.has(task)
        || task.executionLedgerRecovery?.busyAttemptId || ["planning", "running", "validating"].includes(task.status)
      ) return false;

      taskRemovals.add(task);
      try { await markTaskArchived(JSON.parse(JSON.stringify(task)), "removed"); }
      catch (error) { taskRemovals.delete(task); this.persistenceWarning = `任务移除标记保存失败，任务已保留：${String(error)}`; return false; }
      const wasActive = this.activeTaskId === taskId;
      this.tasks = this.tasks.filter((item) => item.id !== taskId);
      if (this.pendingSecret?.taskId === taskId) this.pendingSecret = null;
      this.pendingUserInputs = this.pendingUserInputs.filter((item) => item.taskId !== taskId);
      if (wasActive) {
        this.activeTaskId = null;
      }
      this.addLog({
        category: "task",
        level: "info",
        title: "移除任务",
        detail: `已从任务列表移除“${task.title}”。历史快照和执行证据保留，未决操作仍可核对。`,
        serverId: task.serverId,
      });
      this.persist(true);
      await this.restoreExecutionLedgerTasks();
      taskRemovals.delete(task);
      return true;
    },

    pushMessage(task: OpsTask, message: Omit<TaskMessage, "id" | "createdAt">) {
      const created = { ...message, id: uid("msg"), createdAt: now() } as TaskMessage;
      task.messages.push(created);
      task.updatedAt = now();
      if (message.kind === "event" || message.kind === "summary") {
        const agentTerminals = useAgentTerminalStore();
        if (agentTerminals.sessionsByTask[task.id]) {
          const timestamp = new Date(created.createdAt).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          });
          agentTerminals.system(task.id, `[${timestamp}] ${message.content}`);
        }
      }
      return created;
    },

    /**
     * Keeps one user-facing plan status bubble per conversation round. Earlier
     * plan revisions remain in the execution record as events, so the audit
     * trail is retained without flooding the chat with superseded approvals.
     */
    pushPlanProgressMessage(task: OpsTask, content: string) {
      const roundStart = task.messages.reduce((latest, message, index) => (
        message.role === "user" && message.kind === "message" ? index : latest
      ), -1);
      task.messages.slice(roundStart + 1).forEach((message) => {
        if (
          message.role === "assistant"
          && message.kind === "message"
          && isPlanProgressMessage(message.content)
        ) {
          message.kind = "event";
        }
      });
      return this.pushMessage(task, {
        role: "assistant",
        kind: "message",
        content,
      });
    },

    async finalizeFailedTask(taskId: string, fallbackReason: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task) return;
      transitionTask(task, "failed");
      task.pauseReason = fallbackReason;
      this.persist();
      const model = this.models.find((item) => item.id === task.modelId);
      const apiKey = this.modelApiKeys[task.modelId];
      const lifetime = workflowLifetime(task);
      const failureSummary = await summarizeFailedTask({
        task,
        reason: fallbackReason,
        model,
        apiKey,
      });
      if (!lifetime.current()) return;
      task.summary = failureSummary.summary;
      if (!task.messages.some((message) =>
        message.kind === "summary" && message.content === task.summary
      )) {
        this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
      }
      this.addLog({
        category: "task",
        level: "error",
        title: "智能运维任务失败总结",
        detail: task.summary,
        serverId: task.serverId,
        taskId,
      });
      this.persist();
    },

    async submitRequirement(
      serverId: string,
      content: string,
      permission: PermissionLevel,
      modelId: string,
      terminalReference = "",
      selectedTaskId = "",
      contextTaskId = "",
    ) {
      if (!this.getRuntimeConnection(serverId)) throw new Error("SSH 未连接，请先手动重连后再发送需求");
      let task = selectedTaskId
        ? this.tasks.find((item) => item.id === selectedTaskId && item.serverId === serverId)
        : this.activeTask;
      if (!task || task.serverId !== serverId) {
        task = this.createTask(serverId, permission, modelId);
      }
      if (taskRemovals.has(task)) throw new Error("任务正在移除，请等待完成后创建新任务。");
      const requirementOwner = {};
      const requirementOwnerTasks = new Set<OpsTask>();
      const claimRequirementTask = (target: OpsTask) => {
        if (submittingRequirements.has(target)) return false;
        submittingRequirements.set(target, requirementOwner);
        requirementOwnerTasks.add(target);
        target.requirementProcessing = true;
        return true;
      };
      const ownsRequirementSubmission = () => requirementOwnerTasks.size > 0
        && [...requirementOwnerTasks].every((target) => submittingRequirements.get(target) === requirementOwner);
      if (!claimRequirementTask(task)) throw new Error("当前需求正在提交，请等待提交完成。");
      requirementTasksByOwner.set(requirementOwner, requirementOwnerTasks);
      try {
      await this.hydrateCredentials();
      if (!ownsRequirementSubmission()) return;
      if (submittingTaskInputs.get(task)?.current()) throw new Error("当前输入正在提交，请等待提交完成。");
      const contextTask = contextTaskId
        ? this.tasks.find((item) => item.id === contextTaskId && item.serverId === serverId) ?? task
        : task;
      const sourceTask = task;
      if (task.modelPlanningBlocker && modelId === task.modelId && permission === task.permission
        && content.trim() === latestTaskRequirement(task).trim()
        && this.stopBlockedModelPlanning(task)) return;
      await this.ensureTaskAgentSession(task.id, ownsRequirementSubmission);
      if (!ownsRequirementSubmission()) return;
      const priorConversation = requirementConversationContext(contextTask);
      const previousRequirement = [...contextTask.messages]
        .reverse()
        .find((message) => message.role === "user" && message.kind === "message"
          && !["side_question", "continue", "cancel_goal"].includes(message.requirementRelation ?? ""));
      if (!contextTask.rootGoal && previousRequirement) contextTask.rootGoal = previousRequirement.content;
      const workflowSnapshot = captureWorkflowState(task);
      const previousEpoch = task.workflowEpoch ?? 0;
      const restorePendingInputEpoch = () => {
        if (task !== sourceTask || sourceTask.status !== "awaiting_input") return;
        const pending = [...this.pendingUserInputs,
        ...(this.pendingSecret ? [this.pendingSecret] : [])];
        for (const request of pending) {
          const source = sourceTask.plan.find(step => step.id === request.stepId);
          if (request.taskId === sourceTask.id && source?.status === "awaiting_input"
            && request.workflowEpoch === previousEpoch
            && request.roundId === sourceTask.currentRoundId
            && request.serverId === executionServerId(sourceTask) && request.command === stepOperationText(source)) {
            request.workflowEpoch = sourceTask.workflowEpoch;
          }
        }
      };
      task.requirementLifecycle ??= task.rootGoal ? taskRequirementSnapshot(task).lifecycle
        : { version: 1, revision: 0, items: [], focus: { roundId: task.currentRoundId, requirementIds: [] } };
      const previousConstraints = task.executionConstraints;
      const previousRequirementLifecycle = task.requirementLifecycle;
      const previousRoundSnapshot = capturePreviousRound(task);
      const contextWorkflowSnapshot = contextTask === task ? workflowSnapshot : captureWorkflowState(contextTask);
      const previousExecution = previousRequirement
        ? requirementExecutionContext(contextTask, previousRequirement.content)
        : undefined;
      task.permission = permission;
      task.modelId = modelId;
      task.requirementProcessing = true;
      if (canTransitionTask(task.status, "planning")) transitionTask(task, "planning");
      task.workflowEpoch = (task.workflowEpoch ?? 0) + 1;
      const submissionEpoch = task.workflowEpoch;
      task.cancelRequested = false;
      task.currentExecutionId = undefined;
      this.activeTaskId = task.id;
      const submittedMessage = this.pushMessage(task, {
        role: "user",
        kind: "message",
        content,
      });
      let understandingMessage = this.pushMessage(task, {
        role: "system",
        kind: "event",
        content: "正在理解需求并汇总服务器上下文…",
      });
      this.addLog({
        category: "model",
        level: "info",
        title: "提交需求理解与规划请求",
        detail: `需求：${content}`,
        serverId,
        taskId: task.id,
      });
      this.persist();

      try {
        const model = this.models.find((item) => item.id === modelId);
        const apiKey = this.modelApiKeys[modelId];
        if (!model) throw new Error("所选模型配置不存在，请重新选择模型");
        if (model.provider !== "Built-in" && !apiKey) {
          const credentialDetail = this.credentialError ? ` 加密凭据读取错误：${this.credentialError}` : "";
          throw new Error(`“${model.name}”的 API Key 未恢复，请前往“模型与设置”重新保存一次。${credentialDetail}`);
        }
        const server = this.servers.find((item) => item.id === serverId);
        const contextMetrics = this.contextMetrics(serverId);
        const contextSecrets = serverSecretValues(this.secretValues, serverId);
        await retrieveTaskKnowledge(task.id, content, {
          ...contextSecrets,
          ...(this.serverPasswords[serverId] ? { __SERVER_PASSWORD__: this.serverPasswords[serverId] } : {}),
          ...(apiKey ? { __MODEL_API_KEY__: apiKey } : {}),
        }, () => ownsRequirementSubmission() && !sourceTask.cancelRequested && sourceTask.workflowEpoch === submissionEpoch);
        if (!ownsRequirementSubmission() || sourceTask.cancelRequested || sourceTask.workflowEpoch !== submissionEpoch) return;
        const availableTerminalLines = this.terminalLines.slice(-400)
          .map((line) => redactExecutionOutput(line, contextSecrets));
        const selectedLines = terminalReference
          ? terminalReference.split("\n").map((line) => redactExecutionOutput(line, contextSecrets))
          : [];
        let requestedTerminalLines = selectedLines.length;
        let context = "";
        let processed;
        let pendingProtocolError: PlanProtocolError | undefined;
        const modelRecovery = createModelRecoveryContext();
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const includedLines = selectedLines.length
            ? selectedLines
            : requestedTerminalLines > 0
              ? availableTerminalLines.slice(-requestedTerminalLines)
              : [];
          const contextualTask = contextTask === task ? task : {
            ...contextTask,
            id: task.id,
            currentRoundId: task.currentRoundId,
            status: task.status,
          };
          context = JSON.stringify({ ...buildAgentContext({
            task: contextualTask,
            server,
            metrics: contextMetrics,
            permission,
            terminalReference: selectedLines.length ? terminalReference : undefined,
            terminalContext: {
              source: selectedLines.length ? "selection" : "automatic",
              totalLines: selectedLines.length || availableTerminalLines.length,
              includedLines: includedLines.length,
              hasMore: !selectedLines.length && includedLines.length < availableTerminalLines.length,
              content: includedLines.length ? includedLines.join("\n") : undefined,
            },
            conversationHistory: priorConversation,
            previousExecution,
            taskGoal: contextTask.rootGoal ? {
              rootGoal: contextTask.rootGoal,
              currentInstruction: contextTask.currentInstruction,
              status: contextWorkflowSnapshot.status,
            } : undefined,
            knownExecutionFacts: {
              ...extractKnownExecutionFacts(contextTask, resolveTaskSkills(contextTask, this.skills),
                new Set(previousExecution?.steps.map(step => step.stepId) ?? [])),
              currentRoundEvidenceRef: previousExecution ? "previousExecution.steps" : undefined,
            },
            tools: this.tools,
            skills: resolveTaskSkills(contextTask, this.skills),
            skillDirectory: this.enabledSkills,
            secretMetadata: this.secretMetadata,
            serverId,
          }), requirementSubmission: { sourceMessageId: submittedMessage.id,
            baseRevision: task.requirementLifecycle?.revision ?? 0, baseLifecycle: task.requirementLifecycle,
            content, createdAt: submittedMessage.createdAt }, _modelRecovery: modelRecovery });
          const skillDefinitions = buildSkillContext(planningSkills(contextTask, this.enabledSkills));
          const developerRequest = {
            command: "process_ai_requirement",
            attempt: attempt + 1,
            requirement: content,
            context: JSON.parse(context),
            skillDefinitions,
            generationSettings: this.aiGenerationSettings,
          };
          const startedAt = Date.now();
          try {
            processed = await backend.processRequirement(content, {
              ...modelIntegrationConfig(model),
              assertCurrent: () => {
                if (!ownsRequirementSubmission() || sourceTask.cancelRequested || sourceTask.workflowEpoch !== submissionEpoch) throw new StaleWorkflowError();
              },
              apiKey: apiKey ?? "",
              endpoint: model.endpoint,
              model: model.model,
              requestParameters: model.requestParameters,
              capabilities: model.capabilities,
              timeoutSeconds: model.timeoutSeconds,
              context,
              generationSettings: this.aiGenerationSettings,
            }, skillDefinitions);
            const { developerTrace, ...response } = processed;
            developerTrace?.attempts.forEach((modelAttempt) => {
              this.addDeveloperLog({
                level: modelAttempt.error ? "error" : "success",
                operation: modelAttempt.stage,
                title: `${modelAttempt.stage} · 第 ${modelAttempt.attempt} 次模型请求`,
                summary: modelAttempt.error ?? "已记录本次实际发送的请求和收到的原始响应。",
                request: modelAttempt.request,
                response: modelAttempt.response,
                error: modelAttempt.error,
                serverId,
                taskId: sourceTask.id,
                modelProfileId: model.id,
                modelName: `${model.name} / ${model.model}`,
                endpoint: model.endpoint,
                durationMs: modelAttempt.durationMs,
              });
            });
            this.addDeveloperLog({
              level: processed.planError ? "error" : "success",
              operation: "requirement_processing",
              title: processed.planError ? "需求处理完成，但计划编译失败" : "需求处理模型调用完成",
              summary: processed.planError ?? `模型返回 ${processed.intent}，共生成 ${processed.plan.length} 个计划步骤。`,
              response,
              serverId,
              taskId: task.id,
              modelProfileId: model.id,
              modelName: `${model.name} / ${model.model}`,
              endpoint: model.endpoint,
              durationMs: Date.now() - startedAt,
            });
          } catch (error) {
            if (error instanceof ModelInvocationError || error instanceof PlanProtocolError) {
              error.developerTrace?.attempts.forEach((modelAttempt) => {
                this.addDeveloperLog({
                  level: modelAttempt.error ? "error" : "success",
                  operation: modelAttempt.stage,
                  title: `${modelAttempt.stage} · 第 ${modelAttempt.attempt} 次模型请求`,
                  summary: modelAttempt.error ?? "已记录本次实际发送的请求和收到的原始响应。",
                  request: modelAttempt.request,
                  response: modelAttempt.response,
                  error: modelAttempt.error,
                  serverId,
                  taskId: sourceTask.id,
                  modelProfileId: model.id,
                  modelName: `${model.name} / ${model.model}`,
                  endpoint: model.endpoint,
                  durationMs: modelAttempt.durationMs,
                });
              });
            }
            const technicalError = error instanceof PlanProtocolError
              ? error.developerMessage
              : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            this.addDeveloperLog({
              level: "error",
              operation: "requirement_processing",
              title: "需求处理模型调用失败",
              summary: technicalError,
              request: error instanceof ModelInvocationError ? undefined : developerRequest,
              error: technicalError,
              stack: error instanceof Error ? error.stack : undefined,
              serverId,
              taskId: task.id,
              modelProfileId: model.id,
              modelName: `${model.name} / ${model.model}`,
              endpoint: model.endpoint,
              durationMs: Date.now() - startedAt,
            });
            if (error instanceof PlanProtocolError && error.processed) {
              pendingProtocolError = error;
              processed = { ...error.processed, plan: [] };
            } else throw error;
          }
          if (sourceTask.cancelRequested || sourceTask.workflowEpoch !== submissionEpoch) return;
          if (processed.intent !== "terminal_context") break;
          if (selectedLines.length) throw new Error("模型已获得用户标注的终端内容，仍无法判断需求");
          const nextRange = Math.min(
            availableTerminalLines.length,
            Math.max(requestedTerminalLines + 40, processed.terminalContextLines ?? 80),
          );
          if (nextRange <= requestedTerminalLines) throw new Error("可用终端历史不足以支持当前需求");
          requestedTerminalLines = nextRange;
          understandingMessage.content = `模型需要查看终端历史，已扩展至最近 ${requestedTerminalLines} 行…`;
        }
        if (!processed || processed.intent === "terminal_context") {
          throw new Error("已达终端上下文读取上限，模型仍无法完成需求判断");
        }
        const relation = normalizeRequirementRelation(processed, content, Boolean(contextTask.rootGoal));
        submittedMessage.requirementRelation = relation;
        if (relation === "continue" && workflowSnapshot.status === "awaiting_input") {
          restoreWorkflowState(sourceTask, workflowSnapshot);
          restorePendingInputEpoch();
          sourceTask.messages = sourceTask.messages.filter(message => message.id !== understandingMessage.id);
          this.pushMessage(sourceTask, { role: "assistant", kind: "message", content: "当前步骤仍有必需信息待确认，请先完成已有表单后继续。" });
          this.persist();
          return;
        }
        if (relation === "side_question") {
          sourceTask.lastRequirementRelation = relation;
          sourceTask.messages = sourceTask.messages.filter((message) => message.id !== understandingMessage.id);
          if (sourceTask.rootGoal) {
            // A pending approval/input/adjustment still belongs to the active
            // workflow and must survive a temporary question.
            restoreWorkflowState(sourceTask, workflowSnapshot);
            restorePendingInputEpoch();
          } else {
            transitionTask(sourceTask, "completed");
          }
          this.pushMessage(sourceTask, {
            role: "assistant",
            kind: "message",
            content: processed.answer ?? "当前问题无需执行服务器操作。",
          });
          this.addLog({
            category: "model",
            level: "success",
            title: "旁问已回答，原任务目标保持不变",
            detail: JSON.stringify({ rootGoal: taskGoal(sourceTask), question: content }, null, 2),
            serverId,
            taskId: sourceTask.id,
          });
          this.persist();
          return;
        }
        if (relation === "cancel_goal") {
          sourceTask.lastRequirementRelation = relation;
          sourceTask.goalCancellation = { reason: "user_cancelled", at: now() };
          sourceTask.cancelRequested = true;
          sourceTask.messages = sourceTask.messages.filter((message) => message.id !== understandingMessage.id);
          transitionTask(sourceTask, "cancelled");
          sourceTask.pauseReason = "用户已明确取消当前整体目标。";
          this.pushMessage(sourceTask, {
            role: "assistant",
            kind: "message",
            content: processed.answer ?? "已取消当前任务，原执行记录与证据仍保留。",
          });
          this.persist();
          return;
        }
        if ((relation === "new_goal" || relation === "replace_goal") && sourceTask.rootGoal) {
          sourceTask.messages = sourceTask.messages.filter((message) => (
            message.id !== submittedMessage.id && message.id !== understandingMessage.id
          ));
          if (relation === "replace_goal") {
            sourceTask.goalCancellation = { reason: "replaced", at: now() };
            sourceTask.cancelRequested = true;
            transitionTask(sourceTask, "cancelled");
            sourceTask.pauseReason = `用户已将整体目标替换为：${content}`;
          } else {
            restoreWorkflowState(sourceTask, workflowSnapshot);
            restorePendingInputEpoch();
          }
          task = this.createTask(serverId, permission, modelId);
          moveTaskKnowledge(sourceTask.id, task.id);
          if (!claimRequirementTask(task)) throw new Error("新任务需求正在提交，请等待提交完成。");
          task.conversationId = sourceTask.conversationId ?? sourceTask.id;
          transitionTask(task, "planning");
          task.rootGoal = content;
          task.currentInstruction = content;
          task.lastRequirementRelation = "new_goal";
          task.title = content;
          task.currentRoundId = uid("round");
          // Move the user's immutable submission identity with the new goal;
          // requirementUpdate is bound to this message, not a synthesized copy.
          task.messages.push({ ...submittedMessage, requirementRelation: "new_goal" });
          task.updatedAt = now();
          await this.ensureTaskAgentSession(task.id, ownsRequirementSubmission);
          if (!ownsRequirementSubmission()
            || task.cancelRequested || sourceTask.workflowEpoch !== submissionEpoch) return;
          understandingMessage = this.pushMessage(task, {
            role: "system",
            kind: "event",
            content: "已识别为独立目标，正在生成新的执行计划…",
          });
          this.addLog({
            category: "task",
            level: "info",
            title: relation === "replace_goal" ? "整体目标已替换并创建新任务" : "独立目标已创建新任务",
            detail: JSON.stringify({ previousTaskId: sourceTask.id, newTaskId: task.id, rootGoal: content }, null, 2),
            serverId,
            taskId: task.id,
          });
        } else {
          if (relation === "continue") this.renewAutomaticBudgetForUser(task);
          beginRequirementPlanning(task, relation);
          this.pendingUserInputs = this.pendingUserInputs.filter(item => item.taskId !== task!.id);
          if (relation === "continue") {
            // A fresh plan is a phase of the same requirement. Archive attempts
            // without changing their round or replacing their failed identities.
            archiveActivePhase(
              task,
              "replan",
              submittedMessage.createdAt,
              task.summary ?? task.pauseReason,
              submittedMessage.id,
            );
          } else if (previousRoundSnapshot) {
            beginRequirementRound(task, uid("round"), previousRoundSnapshot);
            this.pushMessage(task, {
              role: "system",
              kind: "event",
              content: "开始处理本任务中的新一轮需求；整体目标保持不变，上一轮执行记录已保留，计划、输出和校验证据已归档。",
            });
          }
          task.rootGoal ||= relation === "continue" || relation === "supplement"
            ? contextTask.rootGoal || content
            : content;
          task.currentInstruction = relation === "continue" ? task.currentInstruction || task.rootGoal : content;
          task.lastRequirementRelation = relation;
          task.currentRoundId ||= uid("round");
    if (task.modelPlanningBlocker && (task.modelPlanningBlocker.error.code === "MODEL_FORMAT_INVALID" || isModelRecoveryScopeRejection(task.modelPlanningBlocker.error))
      && ["planning_failed", "needs_adjustment", "awaiting_continuation"].includes(task.status)) {
      task.pauseReason = modelServiceErrorMessage(task.modelPlanningBlocker.error);
    }
          task.goalCancellation = undefined;
          task.title = task.title === "新任务" ? task.rootGoal : task.title;
        }
        const requirementSource = { content, relation: (relation === "continue" ? "supplement" : relation) as "new_goal" | "replace_goal" | "supplement",
          source: "user_message" as const, sourceMessageId: submittedMessage.id,
          sourceRoundId: task.currentRoundId, createdAt: submittedMessage.createdAt };
        if (processed.requirementUpdate) {
          if (relation === "continue" && (processed.requirementUpdate.additions.length || processed.requirementUpdate.changes.length)) {
            throw new Error("继续请求只能选择现有需求范围，不能新增、取消或修改要求；有范围变更时应按补充需求重新判断。");
          }
          if (task !== sourceTask) task.requirementLifecycle = { version: 1,
            revision: processed.requirementUpdate.baseRevision, items: [],
            focus: { roundId: task.currentRoundId, requirementIds: [] } };
          task.requirementLifecycle = applyTaskRequirementUpdate(task, processed.requirementUpdate,
            { source: requirementSource, roundId: task.currentRoundId });
        } else if (relation !== "continue") {
          task.requirementLifecycle = appendLegacyTaskRequirement(task, requirementSource, task.currentRoundId);
        }
        if (task.requirementLifecycle) task.requirementLifecycle.focus.roundId = task.currentRoundId;
        task.currentRequestReview = undefined;
        task.plan = [];
        task.summary = undefined;
        task.pauseReason = undefined;
        task.executionConstraints = task === sourceTask && ["continue", "supplement"].includes(relation)
          ? previousConstraints : undefined;
        task.confirmedSecretKeys = [];
        task.adjustmentCount = 0;
        task.adjustmentInProgress = false;
        task.adjustmentIncident = undefined;
        task.latestGoalReview = undefined;
        task.lastAdjustmentBlocker = undefined;
        task.protocolRepair = undefined;
        task.transportRecovery = undefined;
        task.discoveryRefined = false;
        task.refinementCount = 0;
        task.cancelRequested = false;
        task.currentExecutionId = undefined;
        this.activeTaskId = task.id;
        const selectedSkillIds = processed.selectedSkillIds ?? [];
        task.activeSkillIds = mergeTaskSkillIds(task.activeSkillIds, selectedSkillIds, relation);
        pinTaskSkills(task, this.skills);
        task.executionConstraints = mergeRequirementExecutionConstraints({
          previous: task === sourceTask ? previousConstraints : undefined,
          classified: processed.constraints, relation,
          previousLifecycle: task === sourceTask ? previousRequirementLifecycle : undefined,
          nextLifecycle: task.requirementLifecycle,
        });
        if (pendingProtocolError) throw pendingProtocolError;
        if (processed.planError) {
          const serviceError = modelServiceError(processed.planError);
          const selectedSkillNames = resolveTaskSkills(task, this.skills).map((skill) => skill.name);
          const selectionSummary = selectedSkillNames.length
            ? `已选择 Skill：${selectedSkillNames.join("、")}。`
            : "本轮未选择领域 Skill，使用通用运维规则。";
          const failureSummary = processed.planError.includes("要求模型针对性修复一次")
            ? "计划经针对性修复后仍未通过安全校验。"
            : "计划生成未完成，已保留 Skill 选择结果。";
          this.pushMessage(task, {
            role: "system",
            kind: "event",
            content: `${selectionSummary}${failureSummary}`,
          });
          this.addLog({
            category: "model",
            level: "warning",
            title: "Skill 选择已保留，后续方案待完善",
            detail: JSON.stringify({
              requirement: content,
              selectedSkillIds: task.activeSkillIds ?? [],
              serverCommandDispatched: false,
              modelError: serviceError,
              nextAction: serviceError ? "处理账户额度或修改模型/请求预算后再继续；原条件下不重复调用"
                : "可保留当前结果结束，或稍后重试生成后续方案",
            }, null, 2),
            serverId,
            taskId: task.id,
          });
          transitionTask(task, "planning_failed");
          task.summary = undefined;
          if (serviceError) this.recordModelPlanningBlocker(task, serviceError);
          else task.pauseReason = "整体目标、Skill 选择和已有证据已保留，未向服务器发送新命令。后续方案待完善，可以稍后重试生成。";
          this.persist();
          return;
        }
        if (processed.intent === "answer") {
          task.plan = [];
          transitionTask(task, "completed");
          task.messages = task.messages.filter((message) => message.id !== understandingMessage.id);
          this.addLog({
            category: "model",
            level: "success",
            title: "模型判断为咨询问题",
            detail: JSON.stringify({ requirement: content, answer: processed.answer }, null, 2),
            serverId,
            taskId: task.id,
          });
          this.pushMessage(task, {
            role: "assistant",
            kind: "message",
            content: processed.answer ?? "当前问题无需执行服务器操作。",
          });
          this.persist();
          return;
        }
        // Preserve the model proposal as one atomic business decision. Hard
        // authorization below may reject it, but Core must not silently remove
        // individual steps and turn the remainder into a different plan.
        const candidatePlan = processed.plan.map(step => {
          assertToolStepBoundary(step);
          return normalizeStepValidation(step);
        });
        validateRecoveryReferences(recoveryHistory(task), candidatePlan, taskAttemptContext(task));
        assertTaskPlanAuthorization(task, candidatePlan);
        this.prepareTaskPlan(task, candidatePlan);
        if (!task.plan.length) {
          throw new Error("模型返回了空执行计划；未执行任何命令，也未自动要求继续生成步骤");
        }
        transitionTask(task, "awaiting_plan_approval");
        this.activeTaskId = task.id;
        this.addLog({
          category: "model",
          level: "success",
          title: "模型执行计划已返回",
          detail: JSON.stringify({
            requirement: content,
            constraints: task.executionConstraints,
            selectedSkillIds: task.activeSkillIds ?? [],
            context: JSON.parse(context),
            plan: task.plan,
          }, null, 2),
          serverId,
          taskId: task.id,
        });
        if (this.presentTaskUserInput(task.id)) return;
        this.pushPlanProgressMessage(
          task,
          permission === "managed"
            ? `已生成 ${task.plan.length} 个执行步骤，完全托管模式已自动批准计划并开始运行。`
            : `已生成 ${task.plan.length} 个执行步骤。请检查风险、命令和预期结果后确认计划。`,
        );
        this.persist();
        if (task.cancelRequested) {
          transitionTask(task, "cancelled");
          return;
        }
        if (permission === "managed") {
          await this.approvePlan(task.id, true);
        }
      } catch (error) {
        if (!ownsRequirementSubmission()
          || task.cancelRequested || sourceTask.workflowEpoch !== submissionEpoch) return;
        if (error instanceof PlanProtocolError) {
          task.protocolRepair = {
            roundId: task.currentRoundId, serverId: executionServerId(task),
            repair: error.repair, repairError: error.repairError
          };
          transitionTask(task, "needs_adjustment");
          task.pauseReason = error.userMessage;
          task.managedAdjustmentPhase = error.repair.businessReplanProgress ? "manual_required" : undefined;
          task.managedStopReason = error.repair.businessReplanProgress ? "model_generation_failed" : undefined;
          task.autoAdjustmentSeconds = undefined;
          this.pushMessage(task, { role: "assistant", kind: "event", content: error.userMessage });
          this.persist();
          if (!error.repair.businessReplanProgress) await this.beginAdjustment(task.id, false, undefined, "system_initial");
          return;
        }
        if (canTransitionTask(task.status, "planning_failed")) transitionTask(task, "planning_failed");
        else {
          restoreWorkflowState(task, workflowSnapshot);
          restorePendingInputEpoch();
        }
        task.summary = undefined;
        const message = error instanceof Error ? error.message : String(error);
        this.addDeveloperLog({
          level: "error",
          operation: "requirement_planning",
          title: "需求计划未能进入审批",
          summary: message,
          error: error instanceof Error ? `${error.name}: ${error.message}` : message,
          stack: error instanceof Error ? error.stack : undefined,
          taskId: task.id,
          serverId: executionServerId(task),
        });
        const actionableConfiguration = /(?:模型配置不存在|API Key 未恢复)/.test(message);
        const serviceError = modelServiceError(error);
        if (serviceError) this.recordModelPlanningBlocker(task, serviceError);
        task.pauseReason = serviceError ? modelServiceErrorMessage(serviceError)
          : error instanceof ToolStepBoundaryError
            ? `执行计划校验失败：${message}。未派发工具，请检查或重新生成执行计划。`
            : error instanceof ExecutionPolicyError
            ? `${message}当前目标和已有记录已保留，未执行该计划。`
            : actionableConfiguration
              ? `${message}当前目标和已有记录已保留。`
              : "当前目标和已有结果已保留，未向服务器发送新命令。执行方案尚未就绪，可以稍后重试规划。";
        this.pushMessage(task, { role: "assistant", kind: "summary", content: task.pauseReason });
        this.persist();
      }
      } catch (error) {
        if (!ownsRequirementSubmission()) return;
        throw error;
      } finally {
        for (const ownedTask of requirementOwnerTasks) {
          if (submittingRequirements.get(ownedTask) !== requirementOwner) continue;
          submittingRequirements.delete(ownedTask);
          ownedTask.requirementProcessing = false;
        }
        requirementTasksByOwner.delete(requirementOwner);
      }
    },

    adjustmentTargetState(task: OpsTask): AdjustmentTargetState {
      const session = useAgentTerminalStore().sessionsByTask[task.id];
      const server = this.servers.find((item) => item.id === executionServerId(task));
      return {
        paneId: session?.id,
        terminalRevision: session?.generation ?? task.agentSessionGeneration ?? 0,
        terminalStatus: session?.state,
        terminalBusy: session?.state === "busy" || session?.state === "recovering",
        host: server?.host,
        port: server?.port,
        username: server?.username,
      };
    },

    /** Stable retry conditions: exclude task status, pause text, counters and wall-clock metrics. */
    modelPlanningConditions(task: OpsTask) {
      const model = this.models.find(item => item.id === task.modelId);
      const account = model?.source === "official" ? useAccountStore().current : undefined;
      const failed = task.plan.find(step => step.status === "failed");
      return textFingerprint(JSON.stringify({
        policy: nextStagePolicyFingerprint({ task,
          server: this.servers.find(item => item.id === executionServerId(task)),
          tools: this.tools, secretMetadata: this.secretMetadata, skills: resolveTaskSkills(task, this.skills) }),
        instruction: task.currentInstruction ?? latestTaskRequirement(task),
        model: model && { id: model.id, model: model.model, provider: model.provider, endpoint: model.endpoint,
          source: model.source, requestParameters: model.requestParameters, capabilities: model.capabilities,
          ...modelIntegrationConfig(model) },
        generationSettings: this.aiGenerationSettings,
        evidence: buildAdjustmentBlockerSnapshot(task, failed, this.adjustmentTargetState(task)).evidenceFingerprint,
        accountUserId: account?.user.id,
        billingMode: account?.billingMode,
      }));
    },

    modelAccountBalance(task: OpsTask) {
      if (this.models.find(model => model.id === task.modelId)?.source !== "official") return undefined;
      const current = useAccountStore().current;
      return current ? { userId: current.user.id, available: current.balance.available, reserved: current.balance.reserved } : undefined;
    },

    recordModelPlanningBlocker(task: OpsTask, error: ModelServiceError, conditionsFingerprint?: string) {
      task.modelPlanningBlocker = { error, conditionsFingerprint: conditionsFingerprint ?? this.modelPlanningConditions(task),
        accountBalance: this.modelAccountBalance(task), contractRevision: MODEL_PLAN_CONTRACT_REVISION, recordedAt: now() };
      task.autoAdjustmentSeconds = undefined;
      task.managedAdjustmentPhase = "manual_required";
      task.managedStopReason = "model_generation_failed";
      task.pauseReason = modelServiceErrorMessage(error);
      this.persist();
    },

    /** User-requested regeneration is separate from timers and execution replay. */
    async retryModelPlanning(taskId: string) {
      const task = this.tasks.find(item => item.id === taskId);
      if (!task || explicitModelRetries.get(taskId)?.current() || task.requirementProcessing || task.adjustmentInProgress
        || adjustingTaskIds.get(taskId)?.current() || executingTaskSteps.get(task)?.current()
        || hasWaitingStep(task) || task.cancelRequested
        || !["planning_failed", "needs_adjustment", "awaiting_continuation", "failed"].includes(task.status)
        || !isExplicitModelPlanningRetryable(task.modelPlanningBlocker?.error)) return;
      if (task.status === "planning_failed") {
        // An initial failure can predate classification. Require an explicit
        // evidence-backed review of the original goal before accepting complete.
        try {
          const roundId = task.currentRoundId || uid("round");
          const lifecycle = activateRequirementReviewForRetry({ ...task, currentRoundId: roundId });
          task.currentRoundId = roundId;
          task.requirementLifecycle = lifecycle;
        } catch (error) {
          task.pauseReason = error instanceof Error ? error.message : String(error);
          task.managedStopReason = "workflow_error";
          this.pushMessage(task, { role: "system", kind: "event", content: task.pauseReason });
          this.persist();
          return;
        }
      }
      const lifetime = workflowLifetime(task);
      explicitModelRetries.set(taskId, lifetime);
      task.modelPlanningBlocker = undefined;
      task.latestGoalReview = undefined;
      task.autoAdjustmentSeconds = undefined;
      this.pushMessage(task, { role: "system", kind: "event",
        content: "已按你的请求重新生成方案；沿用当前目标、授权和执行证据，本次仍使用有限恢复预算。" });
      this.persist();
      try {
        // Regeneration keeps the current requirement identity. Re-submitting
        // the same text would classify it again and could create a new task.
        if (task.status === "planning_failed") transitionTask(task, "needs_adjustment");
        await this.requestAdjustment(taskId);
      } finally {
        if (explicitModelRetries.get(taskId) === lifetime) explicitModelRetries.delete(taskId);
      }
    },

    /** Checking unchanged conditions is local and never probes the paid model endpoint. */
    stopBlockedModelPlanning(task: OpsTask) {
      const blocker = task.modelPlanningBlocker;
      if (!blocker) return false;
      const balance = this.modelAccountBalance(task);
      const prior = blocker.accountBalance;
      const availableAtRefusal = blocker.error.details?.available_tokens ?? prior?.available;
      const reservedAtRefusal = blocker.error.details?.reserved_tokens ?? prior?.reserved;
      // A balance revision alone, or refreshing a stale optimistic cache down to
      // the refusal's actual balance, is not evidence that this call can now run.
      const changedBalance = balance && JSON.stringify(balance) !== JSON.stringify(prior);
      const improvedBalance = ["INSUFFICIENT_CREDITS", "CREDITS_RECONCILIATION_REQUIRED"].includes(blocker.error.code) && changedBalance && (
        availableAtRefusal !== undefined && balance.available > availableAtRefusal
        || reservedAtRefusal !== undefined && balance.reserved < reservedAtRefusal
      );
      const updatedContract = blocker.error.code === "MODEL_FORMAT_INVALID"
        && blocker.contractRevision !== MODEL_PLAN_CONTRACT_REVISION;
      // Changing model settings cannot establish the outcome of an old request
      // or repair its identity. Keep that uncertainty pinned to the task.
      const unresolvedRequest = ["MODEL_DISPATCH_UNKNOWN", "MODEL_RESULT_UNAVAILABLE", "MODEL_REQUEST_CONFLICT",
        "IDEMPOTENCY_KEY_CONFLICT", "REQUEST_ALREADY_ACCEPTED", "REQUEST_STATE_CONFLICT"].includes(blocker.error.code)
        || blocker.error.code === "MODEL_RECOVERY_BUDGET_EXHAUSTED" && !isExplicitModelPlanningRetryable(blocker.error);
      if (!unresolvedRequest && (updatedContract || blocker.conditionsFingerprint !== this.modelPlanningConditions(task) || improvedBalance)) {
        task.modelPlanningBlocker = undefined;
        task.autoAdjustmentSeconds = undefined;
        this.persist();
        return false;
      }
      task.autoAdjustmentSeconds = undefined;
      task.managedAdjustmentPhase = "manual_required";
      task.managedStopReason = "model_generation_failed";
      task.pauseReason = modelServiceErrorMessage(blocker.error);
      this.persist();
      return true;
    },

    renewAutomaticBudgetForUser(task: OpsTask) {
      if (!renewAutomaticPhaseBudget(task, now())) return;
      this.pushMessage(task, { role: "system", kind: "event", content: "已按你的继续请求续接自动执行；原目标和证据保留，后续仍受重复取证检测及有限阶段预算约束。" });
    },

    stopAutomaticLoop(task: OpsTask) {
      if (task.permission !== "managed" || task.cancelRequested) return false;
      const stop = automaticContinuationStop(task);
      if (!stop) return false;
      const { reason } = stop;
      task.autoAdjustmentSeconds = undefined;
      task.managedAdjustmentPhase = "manual_required";
      task.managedStopReason = stop.code;
      task.pauseReason = reason;
      const alreadyReported = task.messages.some(message => message.kind === "event" && message.content === reason);
      if (!alreadyReported) {
        this.pushMessage(task, { role: "system", kind: "event", content: reason });
      }
      const auditTitle = stop.code === "phase_budget_exhausted" ? "自动编排已暂停：阶段预算耗尽" : "自动编排已停止：缺少新进展";
      const alreadyLogged = this.logs.some(log => log.taskId === task.id && log.title === auditTitle
        && (!task.automaticPhaseBudget || log.createdAt >= task.automaticPhaseBudget.renewedAt));
      if (!alreadyLogged) {
        this.addLog({
          category: "task",
          level: "warning",
          title: auditTitle,
          detail: JSON.stringify({
            reason,
            managedStopReason: task.managedStopReason,
            progress: workflowProgress(task),
          }, null, 2),
          serverId: executionServerId(task),
          taskId: task.id,
        });
      }
      this.persist();
      return true;
    },

    recordAdjustmentExecution(task: OpsTask, stepId: string) {
      if (!recordAdjustmentExecution(task.adjustmentIncident, stepId, now())) return;
      task.adjustmentCount = task.adjustmentIncident!.executionAttemptCount;
      this.persist(true);
    },

    pauseStepModelServiceFailure(task: OpsTask, step: PlanStep, error: unknown) {
      if (!modelServiceError(error)) return false;
      // A failed model review says nothing about the command's real outcome.
      // Preserve its result and evidence, and stop the pending review spinner.
      if (step.status === "running" || step.status === "validating") transitionStep(step, "failed");
      step.progressMessage = undefined;
      task.summary = undefined;
      this.pauseWorkflowFailure(task, error);
      return true;
    },

    pauseWorkflowFailure(task: OpsTask, error: unknown, automaticProtocolRecovery = false) {
      if (task.cancelRequested || ["completed", "cancelled"].includes(task.status)) return;
      if (canTransitionTask(task.status, "needs_adjustment")) transitionTask(task, "needs_adjustment");
      const serviceError = modelServiceError(error);
      if (serviceError) {
        this.recordModelPlanningBlocker(task, serviceError);
        this.pushMessage(task, { role: "system", kind: "event", content: task.pauseReason! });
        return;
      }
      if (error instanceof PlanProtocolError) {
        task.protocolRepair = {
          roundId: task.currentRoundId, serverId: executionServerId(task), repair: error.repair, repairError: error.repairError,
        };
        this.addDeveloperLog({
          level: "error",
          operation: "workflow_progression",
          title: "后续阶段方案未通过计划协议校验",
          summary: error.developerMessage,
          response: { repair: error.repair, repairError: error.repairError },
          error: error.developerMessage,
          stack: error.stack,
          taskId: task.id,
          serverId: executionServerId(task),
        });
      }
      task.pauseReason = error instanceof PlanProtocolError
        ? automaticProtocolRecovery
          ? "当前检查已完成，系统正在根据已有结果完善后续方案。需要确认的操作会在执行前提示。"
          : error.userMessage
        : `后续流程暂不可用：${String(error)}。已完成步骤及其执行证据保持有效，可检查后继续。`;
      task.managedAdjustmentPhase = automaticProtocolRecovery ? undefined : "manual_required";
      task.managedStopReason = automaticProtocolRecovery ? undefined : "workflow_error";
      task.autoAdjustmentSeconds = undefined;
      this.pushMessage(task, { role: "system", kind: "event", content: task.pauseReason });
      this.persist();
    },

    async archiveTaskStepEvidence(task: OpsTask, step: PlanStep) {
      if (isTauri() && this.tools.some(tool => tool.id === "evidence.read" && tool.enabled)) {
        await archiveToolEvidence(task, step, backend.saveTaskEvidence,
          text => redactExecutionOutput(text, serverSecretValues(this.secretValues, executionServerId(task))));
      }
    },

    async routeAutomaticAdjustment(
      taskId: string,
      options: { transportRecovery?: boolean } = {},
    ) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || !["needs_adjustment", "awaiting_continuation", "failed"].includes(task.status)) return;
      if (hasWaitingStep(task) || task.protocolRepair) return;

      if (options.transportRecovery) {
        const failed = [...task.plan].reverse().find((step) => step.status === "failed");
        const snapshot = buildAdjustmentBlockerSnapshot(
          task,
          failed,
          this.adjustmentTargetState(task),
        );
        // 终端通道恢复是执行器内部事务，三种模式均可自动推进；
        // 但只能进入 transport 恢复分支，不得借此触发模型重拟业务计划。
        const historicalTransport = task.adjustmentIncident?.kind === "transport"
          || task.managedAdjustmentPhase === "waiting_transport" || task.managedStopReason === "transport_recovery";
        if (snapshot.kind === "transport" || (!failed && historicalTransport)) {
          if (task.permission === "managed") {
            task.managedAdjustmentPhase = "waiting_transport";
            task.managedStopReason = "transport_recovery";
          }
          await this.requestAdjustment(taskId, true, true);
          return;
        }
        clearTransportAdjustmentState(task, true);
        const mismatchNotice = "终端恢复入口未检测到终端通道阻断，已停止自动恢复；不会由该入口生成业务调整计划。";
        task.pauseReason = mismatchNotice;
        if (!task.messages.some((message) => message.kind === "event" && message.content === mismatchNotice)) {
          this.pushMessage(task, { role: "system", kind: "event", content: mismatchNotice });
        }
        this.persist();
        return;
      }

      if (task.permission === "managed") {
        void this.queueManagedAdjustment(taskId);
        return;
      }

      const modeLabel = task.permission === "observe" ? "观察模式" : "安全模式";
      const guidance = `${modeLabel}下，请查看已有结果并手动生成后续计划。`;
      if (!task.pauseReason?.includes(guidance)) {
        task.pauseReason = task.pauseReason ? `${task.pauseReason}；${guidance}` : guidance;
      }
      if (!task.messages.some((message) => message.kind === "event" && message.content === guidance)) {
        this.pushMessage(task, { role: "system", kind: "event", content: guidance });
      }
      this.persist();
    },

    async waitForAdjustmentTransportRecovery(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || recoveringAdjustmentTasks.get(task)?.current()) return;
      const lifetime = workflowLifetime(task);
      const targetServerId = executionServerId(task);
      const targetIdentity = () => {
        const server = this.servers.find(item => item.id === targetServerId);
        return JSON.stringify([server?.host, server?.port, server?.username]);
      };
      const capturedTarget = targetIdentity();
      const owns = () => recoveringAdjustmentTasks.get(task) === lifetime;
      const taskCurrent = () => lifetime.current() && this.tasks.includes(task)
        && executionServerId(task) === targetServerId && targetIdentity() === capturedTarget;
      const current = () => owns() && taskCurrent();
      const release = () => {
        if (!owns()) return;
        recoveringAdjustmentTasks.delete(task);
        this.transportRecoveryTaskIds = this.transportRecoveryTaskIds.filter(id => id !== taskId);
      };
      recoveringAdjustmentTasks.set(task, lifetime);
      if (!this.transportRecoveryTaskIds.includes(taskId)) this.transportRecoveryTaskIds.push(taskId);
      let refreshAttempts = 0;
      let lastRefreshAt = -Infinity;
      const deadline = Date.now() + 30_000;
      try {
        while (Date.now() < deadline) {
          if (!current() || !["needs_adjustment", "awaiting_continuation", "failed"].includes(task.status)
            || hasWaitingStep(task)) return;
          if (task.adjustmentIncident?.kind !== "transport") {
            if (task.managedAdjustmentPhase === "waiting_transport") {
              clearTransportAdjustmentState(task, true);
              this.persist();
            }
            return;
          }
          let target = this.adjustmentTargetState(task);
          const connected = Boolean(this.getRuntimeConnection(targetServerId));
          // The user Shell and Agent executor have separate sessions. Refresh
          // local Agent ownership only after SSH is verified; this sends no
          // business command, and never overrides a busy Agent slot.
          if (connected && target.terminalStatus !== "ready" && target.terminalStatus !== "busy"
            && refreshAttempts < 3 && Date.now() - lastRefreshAt >= 2_000) {
            refreshAttempts += 1;
            lastRefreshAt = Date.now();
            let refreshActive = true;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                this.ensureTaskAgentSession(taskId, () => refreshActive && current()),
                new Promise<never>((_resolve, reject) => {
                  timeout = setTimeout(() => reject(new Error("Agent 会话状态检查超时")),
                    Math.min(5_000, deadline - Date.now()));
                }),
              ]);
            } finally {
              refreshActive = false;
              if (timeout !== undefined) clearTimeout(timeout);
            }
            if (!current()) return;
            target = this.adjustmentTargetState(task);
          }
          const ready = target.paneId
            ? Boolean(this.getRuntimeConnection(targetServerId)) && target.terminalStatus === "ready" && !target.terminalBusy
            : Boolean(this.getRuntimeConnection(targetServerId));
          if (ready) {
            this.pushMessage(task, {
              role: "system",
              kind: "event",
              content: "终端执行通道已恢复，正在核对原步骤是否可安全继续；通道恢复不代表业务执行成功。",
            });
            this.persist();
            release();
            await this.routeAutomaticAdjustment(taskId, { transportRecovery: true });
            return;
          }
          await wait(250);
        }
        if (current() && task.adjustmentIncident?.kind === "transport") {
          task.autoAdjustmentSeconds = undefined;
          task.managedAdjustmentPhase = "manual_required";
          task.managedStopReason = "transport_recovery";
          task.pauseReason = "绑定终端仍未恢复。请重连或刷新终端；系统不会把执行通道故障交给模型改写业务计划。";
          this.pushMessage(task, { role: "system", kind: "event", content: task.pauseReason });
          this.persist();
        }
      } catch (error) {
        if (taskCurrent() && (owns() || !recoveringAdjustmentTasks.has(task))
          && ["needs_adjustment", "awaiting_continuation", "failed"].includes(task.status)
          && task.managedAdjustmentPhase === "waiting_transport") {
          task.autoAdjustmentSeconds = undefined;
          task.managedAdjustmentPhase = "manual_required";
          task.managedStopReason = "transport_recovery";
          task.pauseReason = `终端恢复检查未完成：${String(error)}。已停止自动等待；请检查连接后重试，不会自动重放命令。`;
          this.pushMessage(task, { role: "system", kind: "event", content: task.pauseReason });
          this.persist();
        }
      } finally {
        release();
      }
    },

    async resumeTransportAdjustment(taskId: string, failed: PlanStep, category: string) {
      if (resumingTransportTaskIds.has(taskId)) return;
      resumingTransportTaskIds.add(taskId);
      try {
        const task = this.tasks.find((item) => item.id === taskId);
        if (!task) return;
        if (category === "terminal_recovery" && failed.result?.facts.stoppedByPeriodicReview === true) {
          failed.result.facts.category = "periodic_review";
          clearTransportAdjustmentState(task);
          task.pauseReason = `终端执行通道已恢复；${failed.result.failureReason ?? "长任务仍需调整执行方式"}`;
          await this.routeAutomaticAdjustment(taskId);
          return;
        }

        const commandWasNotSent = failed.result?.facts.commandDispatched === false
          && category === "terminal_transport";
        if (!commandWasNotSent) {
          recordExecutionUncertainty(task, failed, "执行通道已恢复，但原命令结果/副作用尚未确认。");
          task.pauseReason = category === "validation_protocol_exception"
            ? "终端通道已恢复，主命令已执行，但后置校验未取得真实退出码。系统不会重放主命令或让模型猜测结果；请检查当前状态后重新校验。"
            : "终端通道已恢复，但无法确定原命令是否产生副作用。系统不会自动重放或让模型猜测；请检查当前服务器状态后重试。";
          if (!task.messages.some((message) => message.kind === "event" && message.content === task.pauseReason)) {
            this.pushMessage(task, { role: "system", kind: "event", content: task.pauseReason });
          }
          // The transport incident has been consumed. Leaving it active lets
          // concurrent recovery/countdown callbacks route the same stale event
          // repeatedly and flood the task timeline.
          clearTransportAdjustmentState(task, true);
          task.transportRecovery = undefined;
          task.managedStopReason = task.executionReconciliation ? "user_input_required" : "transport_recovery";
          task.managedAdjustmentPhase = "manual_required";
          if (task.executionReconciliation && !task.executionReconciliation.resolution) {
            task.pauseReason = "连接已恢复；下一步先生成只读核对计划，检查原进程与实际产物。核对前不允许重新执行变更。";
          }
          this.persist();
          if (task.executionReconciliation && !task.executionReconciliation.resolution
            && task.permission === "managed") await this.beginAdjustment(taskId, true);
          return;
        }

        const retry = clearStepRuntime(failed, uid("transport-retry"));
        const remaining = task.plan.filter((step) => step !== failed && ["pending", "awaiting_approval", "awaiting_input"].includes(step.status));
        // Only this failed dispatch is proven not to have happened. Other
        // historical dependency holds must survive channel recovery.
        for (const next of remaining) {
          next.failureDependencies = next.failureDependencies?.filter(item => item.failedStepId !== failed.id);
        }
        archiveActivePhase(task, "adjustment");
        task.plan = [retry, ...remaining];
        task.pauseReason = undefined;
        task.summary = undefined;
        clearTransportAdjustmentState(task);
        transitionTask(task, "awaiting_plan_approval");
        this.pushPlanProgressMessage(
          task,
          "已进入下一阶段，正在重试此前未发送成功的原步骤。",
        );
        this.persist();
        await this.approvePlan(taskId, true);
      } finally {
        resumingTransportTaskIds.delete(taskId);
      }
    },

    async beginAdjustment(
      taskId: string,
      automatic = false,
      expectedFingerprint?: string,
      protocolReplanSource: ProtocolReplanSource = "manual",
    ) {
      if (adjustingTaskIds.get(taskId)?.current()) return;
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || !["needs_adjustment", "awaiting_continuation", "failed"].includes(task.status)) return;
      if (task.cancelRequested || !automatic && protocolReplanSource === "manual"
        && (task.requirementProcessing || executingTaskSteps.get(task)?.current())) return;
      if (automatic && stopForBlockedNoAction(task)) {
        this.persist();
        return;
      }
      if (hasWaitingStep(task) || (automatic && task.protocolRepair)) return;
      if (this.stopBlockedModelPlanning(task)) return;
      const protocolReplan = activeProtocolRepair(task);
      if (task.protocolRepair && !protocolReplan) {
        task.pauseReason = "保留的协议事故与当前目标或轮次不一致，请补充当前需求后重新规划。";
        this.persist();
        return;
      }
      let replanRecord: NonNullable<OpsTask["protocolRepairHistory"]>[number] | undefined;
      if (expectedFingerprint && task.adjustmentIncident?.fingerprint !== expectedFingerprint) return;
      const lifetime = workflowLifetime(task);
      let modelConditions = this.modelPlanningConditions(task);
      if (automatic && this.stopAutomaticLoop(task)) return;
      if (!automatic && protocolReplanSource === "manual") this.renewAutomaticBudgetForUser(task);
      adjustingTaskIds.set(taskId, lifetime);
      task.adjustmentInProgress = true;
      if (task.permission === "managed") {
        task.managedAdjustmentPhase = "generating";
        task.managedStopReason = undefined;
      }
      this.persist();
      try {
        await this.hydrateCredentials();
        if (!lifetime.current()) return;
        if (task.cancelRequested || !["needs_adjustment", "awaiting_continuation", "failed"].includes(task.status)) return;
        if (expectedFingerprint && task.adjustmentIncident?.fingerprint !== expectedFingerprint) return;
        const phaseSummary = task.pauseReason;
        const failed = [...task.plan].reverse().find((step) => step.status === "failed");
        const localHardRepair = !protocolReplan
          && failed?.result?.facts.category === "plan_safety_rejection";
        const currentIncidentFingerprint = task.adjustmentIncident?.fingerprint
          ?? buildAdjustmentBlockerSnapshot(task, failed, this.adjustmentTargetState(task)).fingerprint;
        const reusableGoalReview = failed || protocolReplan ? undefined : task.latestGoalReview;
        const server = this.servers.find((item) => item.id === task.serverId);
        const activeSkills = resolveTaskSkills(task, this.skills);
        const currentPolicyFingerprint = nextStagePolicyFingerprint({
          task,
          server,
          metrics: this.contextMetrics(executionServerId(task)),
          tools: this.tools,
          secretMetadata: this.secretMetadata,
          skills: activeSkills,
        });
        const policyCurrent = () => currentPolicyFingerprint === nextStagePolicyFingerprint({
          task, server: this.servers.find(item => item.id === task.serverId),
          metrics: this.contextMetrics(executionServerId(task)), tools: this.tools,
          secretMetadata: this.secretMetadata, skills: resolveTaskSkills(task, this.skills),
        });
        const cachedPlanFresh = Boolean(
          !task.protocolRepair && reusableGoalReview?.nextPlan?.length
          && reusableGoalReview.policyFingerprint === currentPolicyFingerprint
          && reusableGoalReview.continuationIncidentFingerprint
          && reusableGoalReview.continuationIncidentFingerprint === currentIncidentFingerprint
          && (!expectedFingerprint || reusableGoalReview.continuationIncidentFingerprint === expectedFingerprint),
        );
        transitionTask(task, "planning");
        if (protocolReplan) {
          replanRecord = { ...JSON.parse(JSON.stringify(protocolReplan)), requestedAt: now(), status: "planning" };
          task.protocolRepairHistory ??= [];
          task.protocolRepairHistory.push(replanRecord!);
          this.addLog({
            category: "model", level: "info",
            title: protocolReplanSource !== "manual"
              ? "系统从协议阻断自动转入业务重新规划"
              : "用户请求从协议阻断转入业务重新规划",
            detail: JSON.stringify({
              triggerSource: protocolReplanSource,
              rejectedPlanExecuted: false,
              protocolIncidentRecorded: true,
              instruction: "原方案单独归档；新步骤重新通过授权、安全、风险审批和验收。"
            }),
            taskId, serverId: executionServerId(task)
          });
        }
        this.pushMessage(task, {
          role: "system",
          kind: "event",
          content: cachedPlanFresh
            ? "正在采用整体目标判断时已生成的下一阶段计划…"
            : protocolReplan ? "正在根据当前目标和已有结果重新整理后续方案；新步骤将按当前授权逐项进行安全检查…"
            : localHardRepair ? "正在修复执行前安全门禁拒绝的计划字段…"
            : "正在由模型同时判断整体目标和下一阶段…",
        });
        this.persist();
        try {
          let adjustment: {
            requirement: string;
            context: unknown;
            replacement: PlanStep[];
            plan: PlanStep[];
          } | undefined;
          let goalReview: Awaited<ReturnType<typeof decideTaskNextStage>> | undefined;
          if (cachedPlanFresh && reusableGoalReview?.nextPlan) {
            // Persisted task state is reactive, so its steps may be Vue proxies.
            // PlanStep is JSON-serializable by contract; serializing first avoids
            // structuredClone(DataCloneError) and prevents an unnecessary replan.
            const cachedPlan = JSON.parse(JSON.stringify(reusableGoalReview.nextPlan)) as PlanStep[];
            adjustment = {
              requirement: latestTaskRequirement(task),
              context: {
                workflowPhase: "cached_combined_next_stage",
                snapshotFingerprint: reusableGoalReview.snapshot.snapshotFingerprint,
                policyFingerprint: reusableGoalReview.policyFingerprint,
              },
              replacement: cachedPlan,
              plan: cachedPlan,
            };
          } else {
            const model = this.models.find((item) => item.id === task.modelId);
            const apiKey = this.modelApiKeys[task.modelId];
            modelConditions = this.modelPlanningConditions(task);
            this.addLog({ category: "model", level: "info", title: localHardRepair
              ? "开始生成硬性协议或安全修复方案"
              : "开始联合判断整体目标与下一阶段",
              detail: JSON.stringify({ triggerSource: protocolReplan ? protocolReplanSource : automatic ? "managed_scheduler" : "manual",
                automatic, modelId: task.modelId, conditionsFingerprint: modelConditions }),
              taskId, serverId: executionServerId(task) });
            if (localHardRepair) {
              if (!model) throw new Error("所选模型配置不存在，请重新选择模型");
              if (model.provider !== "Built-in" && !apiKey) {
                throw new Error(`“${model.name}”的 API Key 未恢复，请前往“模型与设置”重新保存一次。`);
              }
              adjustment = await planTaskAdjustment({
                task,
                failedStep: failed,
                server,
                metrics: this.contextMetrics(executionServerId(task)),
                tools: this.tools,
                secretMetadata: this.secretMetadata,
                model,
                apiKey,
                generationSettings: this.aiGenerationSettings,
                skills: activeSkills,
                sharedSnapshot: reusableGoalReview?.snapshot,
                reviewDecision: reusableGoalReview?.decision,
                adjustmentReason: phaseSummary,
                allowUnchangedFailureRetry: !automatic,
              });
            } else {
              goalReview = await decideTaskNextStage({
                task,
                model,
                apiKey,
                server,
                metrics: this.contextMetrics(executionServerId(task)),
                tools: this.tools,
                secretMetadata: this.secretMetadata,
                generationSettings: this.aiGenerationSettings,
                skills: activeSkills,
                isCancelled: () => !lifetime.current(),
                recoverProtocolFailures: true,
                freshModelOperation: !automatic && protocolReplanSource === "manual",
              });
              if (goalReview.nextPlan.length) {
                adjustment = {
                  requirement: goalReview.requirement,
                  context: goalReview.context,
                  replacement: goalReview.nextPlan,
                  plan: goalReview.nextPlan,
                };
              }
            }
          }
          if (!lifetime.current()) return;
          if (!policyCurrent()) throw new Error("规划期间目标、授权或已确认输入发生变化，已丢弃旧上下文生成的方案，请重新生成");
          if (goalReview && "taskDecision" in goalReview && goalReview.taskDecision) Object.assign(task, goalReview.taskDecision);
          if (goalReview?.reconciliationResolution && task.executionReconciliation) {
            task.executionReconciliation.resolution = goalReview.reconciliationResolution;
          }
          if (goalReview?.complete) {
            if (replanRecord) {
              replanRecord.status = "accepted";
              replanRecord.replacementStepIds = [];
              replanRecord.outcome = goalReview.decision.summary;
            }
            task.latestGoalReview = undefined;
            task.protocolRepair = undefined;
            task.summary = goalReview.decision.summary;
            task.pauseReason = undefined;
            task.autoAdjustmentSeconds = undefined;
            transitionTask(task, "completed");
            task.adjustmentInProgress = false;
            if (task.permission === "managed") {
              task.managedAdjustmentPhase = undefined;
              task.managedStopReason = undefined;
            }
            this.addLog({
              category: "model",
              level: "success",
              title: "模型判断整体目标已完成",
              detail: JSON.stringify({
                rootGoal: goalReview.requirement,
                decision: goalReview.decision,
              }, null, 2),
              serverId: executionServerId(task),
              taskId,
            });
            this.addLog({
              category: "task",
              level: "success",
              title: "智能运维任务完成",
              detail: task.summary,
              serverId: executionServerId(task),
              taskId,
            });
            this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
            this.persist();
            return;
          }
          if (goalReview && !goalReview.nextPlan.length) {
            if (replanRecord) {
              replanRecord.status = "accepted";
              replanRecord.replacementStepIds = [];
              replanRecord.outcome = `blocked/no_action: ${goalReview.decision.summary}`;
            }
            task.protocolRepair = undefined;
            transitionTask(task, "awaiting_continuation");
            task.pauseReason = goalReview.decision.summary;
            task.summary = undefined;
            task.latestGoalReview = {
              decision: {
                decision: goalReview.decision.decision,
                reason: goalReview.decision.reason,
                summary: goalReview.decision.summary,
                source: goalReview.decision.source,
              },
              snapshot: goalReview.snapshot,
              nextPlan: [],
              policyFingerprint: goalReview.policyFingerprint,
              createdAt: now(),
            };
            task.adjustmentInProgress = false;
            stopForBlockedNoAction(task);
            this.addLog({
              category: "model",
              level: "warning",
              title: "模型判断当前无可执行的下一步",
              detail: JSON.stringify({
                rootGoal: goalReview.requirement,
                decision: goalReview.decision,
                outcome: "blocked/no_action",
              }, null, 2),
              serverId: executionServerId(task),
              taskId,
            });
            this.pushMessage(task, {
              role: "assistant",
              kind: "event",
              content: goalReview.decision.summary,
            });
            this.persist();
            return;
          }
          if (!adjustment) throw new Error("下一阶段联合决策未返回可执行计划");
          const adjustmentIncident = task.adjustmentIncident;
          if (adjustmentIncident
            && (!expectedFingerprint || adjustmentIncident.fingerprint === expectedFingerprint)) {
            recordAdjustmentPlan(adjustmentIncident, adjustment.plan, now());
          }
          archiveActivePhase(task, "adjustment", now(), phaseSummary);
          this.prepareTaskPlan(task, adjustment.plan);
          task.pauseReason = undefined;
          if (replanRecord) {
            replanRecord.status = "accepted";
            replanRecord.replacementStepIds = adjustment.plan.map(step => step.id);
          }
          task.protocolRepair = undefined;
          task.latestGoalReview = undefined;
          if (this.presentTaskUserInput(taskId)) return;
          transitionTask(task, "awaiting_plan_approval");
          this.pushPlanProgressMessage(
            task,
            protocolReplan && protocolReplanSource === "system_continuation"
              ? `后续方案已重新整理，包含 ${adjustment.replacement.length} 个执行步骤；系统将按现有授权继续，需要确认的步骤会在执行前单独提示。`
              : protocolReplan && protocolReplanSource === "system_initial"
              ? `后续方案已重新整理，包含 ${adjustment.replacement.length} 个执行步骤；请检查风险、命令和预期结果后确认计划。`
              : task.permission === "managed"
              ? `已进入下一阶段，包含 ${adjustment.replacement.length} 个执行步骤。`
              : `下一阶段计划已生成，包含 ${adjustment.replacement.length} 个执行步骤，等待批准。`,
          );
          this.addLog({
            category: "model",
            level: "warning",
            title: cachedPlanFresh ? "已复用联合决策中的下一阶段计划" : "模型下一阶段计划已返回",
            detail: JSON.stringify({
              context: protocolReplan ? {
                workflowPhase: "business_replan_after_protocol_failure",
                triggerSource: protocolReplanSource,
                rejectedPlanExecuted: false,
              } : adjustment.context,
              replacement: adjustment.replacement,
            }, null, 2),
            serverId: task.serverId,
            taskId,
          });
          this.persist();
          task.adjustmentInProgress = false;
          if (task.permission === "managed") {
            task.managedAdjustmentPhase = undefined;
            task.managedStopReason = undefined;
          }
          if (task.permission === "managed" || protocolReplan && protocolReplanSource === "system_continuation") {
            // Planning ownership ends before execution starts. approvePlan can
            // synchronously advance through an entire low-risk phase and may
            // need a fresh protocol replan; retaining this lock would strand
            // that nested handoff without a worker or a manual recovery action.
            if (adjustingTaskIds.get(taskId) === lifetime) adjustingTaskIds.delete(taskId);
            await this.approvePlan(
              task.id,
              true,
              protocolReplan && protocolReplanSource !== "manual" ? "protocol_replan" : "managed",
            );
          }
        } catch (error) {
          if (!lifetime.current()) return;
          if (replanRecord) {
            replanRecord.status = "failed";
            replanRecord.outcome = error instanceof PlanProtocolError ? error.userMessage : String(error);
          }
          // A rejected late model response is just as stale as a successful one.
          // Never bind its old proposal to a newly selected target or authority.
          if (!policyCurrent()) error = new Error("规划期间目标、授权或已确认输入发生变化，已丢弃过期响应；原协议事故保持原目标绑定，请重新生成");
          const serviceError = modelServiceError(error);
          if (serviceError) this.recordModelPlanningBlocker(task, serviceError, modelConditions);
          if (error instanceof PlanProtocolError) {
            task.protocolRepair = {
              roundId: task.currentRoundId, serverId: executionServerId(task),
              repair: error.repair, repairError: error.repairError
            };
            transitionTask(task, "needs_adjustment");
            task.pauseReason = error.userMessage;
            task.autoAdjustmentSeconds = undefined;
            task.managedAdjustmentPhase = "manual_required";
            task.managedStopReason = "model_generation_failed";
            this.addLog({
              category: "model", level: "warning", title: "当前结果已保留，后续方案待完善",
              detail: JSON.stringify({
                message: error.userMessage,
                rejectedPlanExecuted: false,
                recovery: error.repair.businessReplanProgress,
                nextAction: error.repair.businessReplanProgress
                  ? "有界重规划已停止，可保留结果结束或补充信息后重试"
                  : "当前入口未继续自动修复，可保留结果或重新生成方案",
              }),
              taskId, serverId: executionServerId(task)
            });
            this.addDeveloperLog({
              level: "error",
              operation: "protocol_business_replan",
              title: "业务重规划仍未通过计划协议校验",
              summary: error.developerMessage,
              response: { repair: error.repair, repairError: error.repairError },
              error: error.developerMessage,
              stack: error.stack,
              taskId,
              serverId: executionServerId(task),
            });
            this.pushMessage(task, { role: "system", kind: "event", content: error.userMessage });
            this.persist();
            return;
          }
          const adjustmentIncident = task.adjustmentIncident;
          if (adjustmentIncident
            && (!expectedFingerprint || adjustmentIncident.fingerprint === expectedFingerprint)) {
            adjustmentIncident.generationFailureCount =
              (adjustmentIncident.generationFailureCount ?? 0) + 1;
          }
          const technicalDetail = error instanceof Error
            ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
            : String(error);
          const localEvidenceError = error instanceof TaskEvidenceError;
          const actionablePolicyReason = localEvidenceError || error instanceof ExecutionPolicyError
            || /(?:规划期间目标、授权或已确认输入发生变化|原协议事故保持原目标绑定)/.test(String(error));
          const reason = serviceError ? modelServiceErrorMessage(serviceError) : actionablePolicyReason
            ? String(error)
            : "当前结果和已有执行证据已保留，但后续方案暂未就绪。可以稍后重试生成。";
          this.addDeveloperLog({
            level: "error",
            operation: "adjustment_planning",
            title: "调整方案未能进入审批",
            summary: technicalDetail,
            error: technicalDetail,
            response: serviceError ? { modelError: serviceError } : undefined,
            stack: error instanceof Error ? error.stack : undefined,
            taskId,
            serverId: executionServerId(task),
          });
          this.pushMessage(task, { role: "system", kind: "event", content: reason });
          transitionTask(task, "needs_adjustment");
          const phaseCompleted = task.plan.length > 0
            && task.plan.every((step) => step.status === "completed");
          task.pauseReason = phaseCompleted
            ? `当前阶段的 ${task.plan.length} 个步骤已成功完成，证据保持有效；整体目标尚未完成。${reason}`
            : actionablePolicyReason ? reason : `${reason}未完成目标也已保留。`;
          task.summary = undefined;
          if (task.permission === "managed") {
            task.managedAdjustmentPhase = "manual_required";
            task.managedStopReason = localEvidenceError ? "workflow_error" : "model_generation_failed";
          }
          this.addLog({
            category: "model",
            level: "warning",
            title: "当前结果已保留，后续方案待完善",
            detail: task.pauseReason,
            serverId: task.serverId,
            taskId,
          });
        }
        this.persist();
      } finally {
        if (replanRecord?.status === "planning") {
          replanRecord.status = "failed";
          replanRecord.outcome = "规划已取消或上下文已变化，未采用迟到结果";
        }
        if (lifetime.current()) task.adjustmentInProgress = false;
        if (adjustingTaskIds.get(taskId) === lifetime) adjustingTaskIds.delete(taskId);
        this.persist();
      }
    },

    async adjustTask(taskId: string, automatic = false) {
      await this.requestAdjustment(taskId, automatic);
    },

    async requestAdjustment(taskId: string, automatic = false, transportOnly = false) {
      if (adjustingTaskIds.get(taskId)?.current()) return;
      const task = this.tasks.find((item) => item.id === taskId);
      if (task && taskRemovals.has(task)) return;
      if (!task || !["needs_adjustment", "awaiting_continuation", "failed"].includes(task.status)) return;
      if (task.cancelRequested || !automatic && (task.requirementProcessing || task.adjustmentInProgress
        || executingTaskSteps.get(task)?.current())) return;
      if (automatic && !transportOnly && stopForBlockedNoAction(task)) {
        this.persist();
        return;
      }
      if (hasWaitingStep(task)) return;
      if (task.protocolRepair && automatic) return;
      if (!automatic && !transportOnly
        && task.modelPlanningBlocker?.error.code === "MODEL_RECOVERY_BUDGET_EXHAUSTED"
        && isExplicitModelPlanningRetryable(task.modelPlanningBlocker.error)) {
        await this.retryModelPlanning(taskId);
        return;
      }
      if (!transportOnly && this.stopBlockedModelPlanning(task)) return;
      // A manual request is a new business proposal, not another field-local
      // repair attempt. Do not invent a fresh environment failure/incident.
      if (task.protocolRepair && !transportOnly) {
        await this.beginAdjustment(taskId, false);
        return;
      }
      const failed = [...task.plan].reverse().find((step) => step.status === "failed");
      const target = this.adjustmentTargetState(task);
      const channelReady = Boolean(this.getRuntimeConnection(executionServerId(task)))
        && (!target.paneId || target.terminalStatus === "ready" && !target.terminalBusy);
      if (!transportOnly && task.executionReconciliation && !task.executionReconciliation.resolution && channelReady) {
        if (automatic && this.stopAutomaticLoop(task)) return;
        clearTransportAdjustmentState(task, true);
        task.transportRecovery = undefined;
        await this.beginAdjustment(taskId, automatic);
        return;
      }
      let snapshot = buildAdjustmentBlockerSnapshot(task, failed, target);
      if (transportOnly && !failed && snapshot.kind !== "transport"
        && (task.adjustmentIncident?.kind === "transport" || task.managedAdjustmentPhase === "waiting_transport"
          || task.managedStopReason === "transport_recovery")) {
        snapshot = { ...snapshot, kind: "transport", fingerprint: adjustmentFingerprint(`transport:${snapshot.fingerprint}`) };
      }
      if (transportOnly && snapshot.kind !== "transport") {
        clearTransportAdjustmentState(task, true);
        task.pauseReason = "终端恢复检查已结束；当前阻断属于业务流程，请检查证据后手动决定下一步。该入口不会生成业务调整计划。";
        this.pushMessage(task, { role: "system", kind: "event", content: task.pauseReason });
        this.persist();
        return;
      }
      if (snapshot.kind !== "transport"
        && (task.adjustmentIncident?.kind === "transport"
          || task.managedAdjustmentPhase === "waiting_transport"
          || task.managedStopReason === "transport_recovery")) {
        clearTransportAdjustmentState(task);
      }
      if (automatic && snapshot.kind !== "transport" && this.stopAutomaticLoop(task)) return;
      const sameIncident = isSameAdjustmentIncident(task.adjustmentIncident, snapshot);
      if (!sameIncident) {
        task.adjustmentIncident = openAdjustmentIncident(snapshot, automatic, now());
        task.adjustmentCount = 0;
        task.lastAdjustmentBlocker = snapshot.fingerprint;
        this.pushMessage(task, {
          role: "system",
          kind: "event",
          content: automatic
            ? "检测到新的阻断事实，开始新的自动调整事件。"
            : "检测到新的阻断事实，开始新的人工调整事件。",
        });
      } else if (task.adjustmentIncident) {
        task.adjustmentIncident.updatedAt = now();
        task.adjustmentIncident.automatic = automatic;
      }

      if (snapshot.kind === "transport") {
        task.adjustmentCount = 0;
        task.autoAdjustmentSeconds = undefined;
        task.managedAdjustmentPhase = "waiting_transport";
        task.managedStopReason = "transport_recovery";
        if (task.status === "failed") transitionTask(task, "needs_adjustment");
        const ready = target.paneId
          ? Boolean(this.getRuntimeConnection(executionServerId(task))) && target.terminalStatus === "ready" && !target.terminalBusy
          : Boolean(this.getRuntimeConnection(executionServerId(task)));
        if (ready && !failed) {
          clearTransportAdjustmentState(task, true);
          task.transportRecovery = undefined;
          task.pauseReason = "终端执行通道已恢复，但没有可自动重放的失败步骤。请检查已有执行记录后继续；系统不会仅凭通道恢复宣告目标完成或生成业务调整计划。";
          this.pushMessage(task, { role: "system", kind: "event", content: task.pauseReason });
          this.persist();
          return;
        }
        if (ready && failed) {
          const replayable = snapshot.category === "terminal_transport"
            && failed.result?.facts.commandDispatched === false;
          if (replayable) {
            // Agent generations advance on every failed channel, even without
            // verified SSH recovery. They must not replenish the replay budget.
            const replayFingerprint = adjustmentFingerprint(JSON.stringify([
              executionServerId(task), this.serverConnection(executionServerId(task)).generation,
              task.credentialRevision ?? 0, failed.command.trim(),
            ]));
            if (task.transportRecovery?.targetFingerprint !== replayFingerprint) {
              task.transportRecovery = {
                targetFingerprint: replayFingerprint,
                replayCount: 0,
                updatedAt: now(),
              };
            }
            if ((task.transportRecovery?.replayCount ?? 0) >= 1) {
              task.managedAdjustmentPhase = "manual_required";
              task.managedStopReason = "transport_recovery";
              task.pauseReason = "当前已验证 SSH 连接下原命令已自动重放过一次，但相同传输故障仍然出现。已停止重复重放；请重新验证连接后继续。";
              this.pushMessage(task, { role: "system", kind: "event", content: task.pauseReason });
              this.persist();
              return;
            }
            task.transportRecovery!.replayCount += 1;
            task.transportRecovery!.updatedAt = now();
          }
          await this.resumeTransportAdjustment(taskId, failed, snapshot.category);
          return;
        }
        const firstNotice = !sameIncident;
        task.pauseReason = "正在等待绑定终端恢复；终端传输故障不会消耗业务重拟次数，也不会交给模型改写业务计划。";
        if (firstNotice) {
          this.pushMessage(task, {
            role: "system",
            kind: "event",
            content: automatic
              ? "检测到终端执行通道尚未恢复，已进入终端恢复等待；不会触发模型业务调整。"
              : "当前阻塞来自终端执行通道，已进入恢复等待；不会触发模型业务调整。",
          });
        }
        this.persist();
        void this.waitForAdjustmentTransportRecovery(taskId);
        return;
      }

      const incident = task.adjustmentIncident!;
      if (automatic && (incident.planningAttemptCount ?? 0) >= 1) {
        if (canTransitionTask(task.status, "needs_adjustment")) transitionTask(task, "needs_adjustment");
        task.autoAdjustmentSeconds = undefined;
        task.managedAdjustmentPhase = "manual_required";
        task.managedStopReason = "retry_exhausted";
        task.pauseReason = "相同阻塞事件没有新增执行证据，自动生成后续方案已暂停。当前目标、失败记录和已有结果均已保留；可以检查后手动重新生成剩余计划，无需更换凭据或重建终端。";
        if (!task.messages.some(message => message.kind === "event" && message.content === task.pauseReason)) {
          this.pushMessage(task, { role: "system", kind: "event", content: task.pauseReason });
        }
        this.persist(true);
        return;
      }
      incident.updatedAt = now();
      await this.beginAdjustment(taskId, automatic, incident.fingerprint);
    },

    async queueManagedAdjustment(taskId: string, seconds = 5) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || task.permission !== "managed"
        || !["needs_adjustment", "awaiting_continuation"].includes(task.status)) return;
      if (stopForBlockedNoAction(task)) {
        this.persist();
        return;
      }
      if (hasWaitingStep(task) || task.protocolRepair) return;
      if (this.stopBlockedModelPlanning(task)) return;
      if (task.managedStopReason === "workflow_error" || this.stopAutomaticLoop(task)) return;
      const failed = [...task.plan].reverse().find((step) => step.status === "failed");
      const blockerSnapshot = buildAdjustmentBlockerSnapshot(task, failed, this.adjustmentTargetState(task));
      if (task.managedStopReason === "retry_exhausted"
        && isSameAdjustmentIncident(task.adjustmentIncident, blockerSnapshot)) return;
      if (blockerSnapshot.kind === "transport") {
        if (task.managedStopReason === "transport_recovery") return;
        await this.routeAutomaticAdjustment(taskId, { transportRecovery: true });
        return;
      }
      const activeScheduler = managedAdjustmentSchedulers.get(taskId);
      if (activeScheduler?.current()) {
        // Nested approve/advance calls may discover another continuation while
        // the prior adjustment promise is still unwinding. Record the request
        // instead of silently dropping it behind the old countdown lock.
        activeScheduler.requested = true;
        return;
      }
      const lifetime = workflowLifetime(task);
      const scheduler = { requested: true, current: lifetime.current };
      managedAdjustmentSchedulers.set(taskId, scheduler);
      try {
        while (scheduler.requested) {
          if (!lifetime.current()) break;
          scheduler.requested = false;
          const current = this.tasks.find((item) => item.id === taskId);
          if (!current || current.permission !== "managed"
            || !["needs_adjustment", "awaiting_continuation"].includes(current.status)
            || current.cancelRequested || hasWaitingStep(current)) break;
          if (stopForBlockedNoAction(current)) {
            this.persist();
            break;
          }
          if (this.stopBlockedModelPlanning(current)) break;
          if (this.stopAutomaticLoop(current)) break;
          const blockedStep = [...current.plan].reverse().find((step) => step.status === "failed");
          if (buildAdjustmentBlockerSnapshot(current, blockedStep, this.adjustmentTargetState(current)).kind === "transport") {
            if (current.managedStopReason !== "transport_recovery") {
              await this.routeAutomaticAdjustment(taskId, { transportRecovery: true });
            }
            break;
          }
          current.managedAdjustmentPhase = "countdown";
          current.managedStopReason = undefined;
          for (let remaining = seconds; remaining > 0; remaining -= 1) {
            if (!lifetime.current()) break;
            if (!["needs_adjustment", "awaiting_continuation"].includes(current.status)
              || current.cancelRequested || hasWaitingStep(current)
              || stopForBlockedNoAction(current)) break;
            current.autoAdjustmentSeconds = remaining;
            this.persist();
            await wait(1_000);
          }
          if (!lifetime.current()) break;
          if (stopForBlockedNoAction(current)) {
            this.persist();
            break;
          }
          if (!["needs_adjustment", "awaiting_continuation"].includes(current.status)
            || current.cancelRequested) continue;
          if (hasWaitingStep(current)) break;
          if (this.stopBlockedModelPlanning(current)) break;
          if (current.managedStopReason === "transport_recovery") break;
          const latestFailed = [...current.plan].reverse().find((step) => step.status === "failed");
          if (buildAdjustmentBlockerSnapshot(current, latestFailed, this.adjustmentTargetState(current)).kind === "transport") {
            await this.routeAutomaticAdjustment(taskId, { transportRecovery: true });
            break;
          }
          current.autoAdjustmentSeconds = undefined;
          current.managedAdjustmentPhase = "generating";
          this.pushMessage(current, {
            role: "system",
            kind: "event",
            content: "完全托管模式倒计时结束，开始生成后续计划；生成后将自动继续，高风险步骤仍需单独确认。",
          });
          await this.requestAdjustment(taskId, true);
          // A successful adjustment may synchronously execute the replacement
          // plan and land in another continuation before requestAdjustment
          // returns. Keep the same scheduler alive for that next round.
          const nextTask = this.tasks.find(item => item.id === taskId);
          if (nextTask?.managedAdjustmentPhase === "manual_required") break;
          if (nextTask?.status === "awaiting_continuation") scheduler.requested = true;
        }
      } finally {
        const current = this.tasks.find((item) => item.id === taskId);
        if (current && (lifetime.current() || current.cancelRequested && managedAdjustmentSchedulers.get(taskId) === scheduler)) {
          current.autoAdjustmentSeconds = undefined;
          if (current.cancelRequested) {
            current.managedAdjustmentPhase = "manual_required";
            current.managedStopReason = "cancelled";
          } else if (!["needs_adjustment", "awaiting_continuation"].includes(current.status)) {
            current.managedAdjustmentPhase = undefined;
            current.managedStopReason = undefined;
          } else if (!current.managedAdjustmentPhase) {
            current.managedAdjustmentPhase = "manual_required";
            current.managedStopReason = "model_generation_failed";
          }
        }
        if (managedAdjustmentSchedulers.get(taskId) === scheduler) managedAdjustmentSchedulers.delete(taskId);
        this.persist();
      }
    },

    /** Present a standalone clarification locally; asking is not an execution approval. */
    presentTaskUserInput(taskId: string) {
      const task = this.tasks.find(item => item.id === taskId);
      if (!task || task.cancelRequested
        || !["planning", "validating", "awaiting_plan_approval", "running"].includes(task.status)) return false;
      const unfinished = task.plan.filter(step => !["completed", "failed", "skipped"].includes(step.status));
      if (unfinished.length !== 1 || unfinished[0].status !== "pending") return false;
      const step = unfinished[0];
      const skills = resolveTaskSkills(task, this.skills);
      const dispatch = resolveStepDispatch(step, [], uid("tool-call"), this.tools, [],
        selectPlanningTools(this.tools, skills).map(tool => tool.id));
      if (dispatch.kind !== "tool"
        || !this.tools.some(tool => tool.id === dispatch.call.toolId && tool.enabled && tool.executionMode === "user-input")) return false;
      let request;
      try { request = parseUserInputArguments(dispatch.call.arguments); }
      catch { return false; } // Normal protocol handling reports malformed forms.

      const inputBlocker = repeatedAuthenticationInputBlocker(task, step, recoveryHistory(task));
      if (inputBlocker) {
        transitionTask(task, "needs_adjustment");
        task.pauseReason = inputBlocker;
        task.autoAdjustmentSeconds = undefined;
        task.managedAdjustmentPhase = "manual_required";
        task.managedStopReason = "workflow_error";
        this.pushMessage(task, { role: "assistant", kind: "event", content: inputBlocker });
        this.persist();
        return true;
      }

      // Entering a user decision boundary invalidates older planning/review work,
      // including its error callbacks. No remote call or auto-adjustment is needed.
      task.workflowEpoch = (task.workflowEpoch ?? 0) + 1;
      transitionStep(step, "awaiting_input");
      transitionTask(task, "awaiting_input");
      task.adjustmentInProgress = false;
      task.autoAdjustmentSeconds = undefined;
      task.managedAdjustmentPhase = task.permission === "managed" ? "manual_required" : undefined;
      task.managedStopReason = "user_input_required";
      task.latestGoalReview = undefined;
      task.summary = undefined;
      task.pauseReason = "等待用户明确回答；提交前不会执行后续操作或自动调整。";
      step.startedAt = now();
      step.progressMessage = "等待用户确认";
      this.pendingUserInputs = this.pendingUserInputs.filter(item => item.taskId !== taskId).concat({
        taskId, stepId: step.id, callId: dispatch.call.id,
        roundId: task.currentRoundId, workflowEpoch: task.workflowEpoch,
        serverId: executionServerId(task), command: JSON.stringify(step.action), ...request,
      });
      this.pushMessage(task, { role: "assistant", kind: "event", content: `${request.title}：${task.pauseReason}` });
      this.addLog({
        category: "task", level: "info", title: "任务等待用户确认",
        detail: JSON.stringify({
          callId: dispatch.call.id, stepId: step.id, title: request.title,
          roundId: task.currentRoundId, fields: request.fields.map(field => ({ key: field.key, label: field.label }))
        }),
        serverId: executionServerId(task), taskId
      });
      this.persist();
      return true;
    },

    prepareTaskPlan(task: OpsTask, proposal: PlanStep[] = task.plan, commit = true): PreparedPlan {
      const serverId = executionServerId(task);
      const groups = collectServerCredentialGroups(this.secretMetadata, serverId);
      const operationText = JSON.stringify(proposal.map(step => ({ action: step.action, command: step.command, validation: step.validation })));
      const principalInputBindings = groups
        .filter(group => operationText.includes(`server-credential:${group.id}`) || operationText.includes(`secret.${group.username.key}`))
        .map(group => ({
          key: group.username.key, reference: `principal:${serverId}:${group.id}:${group.username.key}`, target: group.target,
          version: principalVersion(this, `${serverId}:${group.id}:${group.username.key}`,
            this.secretValues[secretValueId(serverId, group.username.key)] ?? ""),
        }));
      const credentialBindings = Object.fromEntries(
        groups
          .filter(group => group.kind === "ssh-password" && group.target)
          .map(group => [`server-credential:${group.id}`, {
            host: group.target!, username: `\${secret.${group.username.key}}`,
          }]),
      );
      const prepared = preparePlanForApproval(proposal, {
        taskId: task.id, permission: task.permission,
        requirement: latestTaskRequirement(task), executionConstraints: task.executionConstraints,
        server: this.servers.find(server => server.id === serverId), servers: this.servers,
        connectionGeneration: this.serverConnection(serverId).generation,
        connectionGenerations: Object.fromEntries(this.servers.map(server => [server.id, this.serverConnection(server.id).generation])),
        agentSession: useAgentTerminalStore().sessionsByTask[task.id], credentialBindings,
        inputBindings: [...Object.entries(task.submittedSecretBindings ?? {}).map(([key, binding]) => ({
          key, reference: `secret:${key}`, target: serverId,
          // Password rotation within the same principal does not change authority.
          version: binding.groupId,
        })), ...Object.entries(task.submittedInputs ?? {}).map(([key, input]) => ({
          key, reference: `input:${task.id}:${input.groupId}:${key}`, target: input.scope?.serverId,
          version: principalVersion(this, `input:${task.id}:${key}`, JSON.stringify({
            value: input.value, type: input.type, scope: input.scope, allowedValues: input.allowedValues,
          })),
        })), ...principalInputBindings],
        previous: task.preparedPlan,
      }, this.tools);
      if (commit) {
        const samePlan = proposal === task.plan;
        const compatible = JSON.parse(JSON.stringify(prepared.compatibilitySteps)) as PlanStep[];
        if (samePlan) {
          compatible.forEach((step, index) => {
            // Retain live object references owned by the execution lifecycle.
            if (task.plan[index] && ["pending", "awaiting_approval", "awaiting_input"].includes(task.plan[index].status)) {
              const live = task.plan[index];
              for (const key of Object.keys(live)) if (!(key in step)) delete (live as unknown as Record<string, unknown>)[key];
              Object.assign(live, step);
            }
          });
        } else task.plan = compatible;
        if (task.preparedPlan?.executionDigest !== prepared.executionDigest) task.planApproval = undefined;
        task.preparedPlan = prepared;
      }
      return prepared;
    },

    assertPreparedStep(task: OpsTask, step: PlanStep) {
      if (!step.executionIntent) return; // Old records are admitted when the queue resumes.
      const proposal = task.plan.map(item => item === step ? { ...item, status: "pending" as const } : item);
      const current = this.prepareTaskPlan(task, proposal, false).steps.find(item => item.id === step.id);
      if (!current || current.intent.digest !== step.executionIntent.digest) {
        throw new ToolExecutionError("执行动作、目标、工具契约或授权条件已变化，请重新检查计划后批准", "permission", "not_sent");
      }
    },

    async approvePlan(
      taskId: string,
      automatic = false,
      automaticReason: AutomaticPlanApprovalReason = "managed",
    ) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (task && taskRemovals.has(task)) return;
      if (!task || task.status !== "awaiting_plan_approval"
        || (task.requirementProcessing && !automatic)) return;
      if (hasWaitingStep(task)) return;
      if (this.presentTaskUserInput(taskId)) return;
      if (this.pauseTaskForConnection(task)) return;
      const requested = task.preparedPlan;
      let prepared: PreparedPlan;
      try { prepared = this.prepareTaskPlan(task); }
      catch (error) { this.pauseWorkflowFailure(task, error); return; }
      if ((!requested || requested.executionDigest !== prepared.executionDigest) && !automatic) {
        this.pushMessage(task, {
          role: "system",
          kind: "event",
          content: "计划已完成参数和执行目标准备，请检查显示的最终内容后确认。",
        });
        task.pauseReason = "执行内容或目标已更新，请检查准备后的计划并重新确认。";
        this.persist();
        return;
      }
      task.planApproval = acceptPreparedPlanApproval(automatic ? prepared : requested ?? prepared, prepared, automatic ? "policy" : "user");
      if (!task.planApproval) return;
      transitionTask(task, "running");
      task.pauseReason = undefined;
      this.pushMessage(task, {
        role: automatic ? "system" : "user",
        kind: "event",
        content: automatic
          ? automaticReason === "protocol_replan"
            ? "系统已按原任务授权自动衔接重新整理后的计划；后续仍按步骤风险规则执行或等待确认。"
            : "完全托管模式已自动批准计划，开始执行。"
          : "计划已批准，开始执行。",
      });
      this.addLog({
        category: "task",
        level: "info",
        title: "执行计划已批准",
        detail: `${task.plan.length} 个步骤进入执行队列`,
        serverId: task.serverId,
        taskId,
      });
      this.persist();
      await this.advanceTask(taskId);
      if (task.permission === "managed" && ["needs_adjustment", "awaiting_continuation"].includes(task.status)) {
        void this.queueManagedAdjustment(task.id, 5);
      }
    },

    rejectTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task) return;
      const requirementTasks = releaseRequirementOwner(task);
      const activeRequirement = requirementTasks.length > 0;
      for (const relatedTask of requirementTasks) {
        if (relatedTask !== task) this.rejectTask(relatedTask.id);
      }
      if (["completed", "failed", "cancelled"].includes(task.status)) {
        if (!activeRequirement) return;
        task.cancelRequested = true;
        task.requirementProcessing = false;
        task.workflowEpoch = (task.workflowEpoch ?? 0) + 1;
        task.adjustmentInProgress = false;
        task.autoAdjustmentSeconds = undefined;
        this.persist();
        return;
      }
      task.cancelRequested = true;
      task.requirementProcessing = false;
      task.workflowEpoch = (task.workflowEpoch ?? 0) + 1;
      task.adjustmentInProgress = false;
      task.autoAdjustmentSeconds = undefined;
      transitionTask(task, "cancelled");
      const pending = task.plan.find((step) => step.status === "awaiting_approval");
      if (pending) cancelStep(pending, "用户取消");
      this.pushMessage(task, { role: "user", kind: "event", content: "用户已停止本次执行。" });
      void cancelExecutionLedger(this, taskId).then(() => this.refreshExecutionLedger(taskId)).catch(error => {
        task.executionLedgerError = { stage: "cancel", message: String(error), remoteResultKnown: false };
      });
      task.summary = task.currentExecutionId ? "取消请求已记录；已派发操作的远端结果仍待核对，迟到结果会保留。" : task.protocolRepair
        ? "本次执行已停止，当前目标、已完成结果和执行记录已保留。"
        : task.pauseReason
        ? `本次执行已停止，业务目标保留。停止前的暂停原因：${task.pauseReason}`
        : "本次执行已停止，业务目标与执行记录保留，可继续完成。";
      task.pauseReason = undefined;
      this.pendingUserInputs = this.pendingUserInputs.filter((item) => item.taskId !== taskId);
      this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
      this.persist();
    },

    async terminateTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task) return;
      const requirementTasks = releaseRequirementOwner(task);
      const activeRequirement = requirementTasks.length > 0;
      const relatedTerminations = Promise.allSettled(requirementTasks
        .filter((relatedTask) => relatedTask !== task)
        .map((relatedTask) => this.terminateTask(relatedTask.id)));
      if (["completed", "failed", "cancelled"].includes(task.status)) {
        if (!activeRequirement) {
          await relatedTerminations;
          return;
        }
        task.cancelRequested = true;
        task.requirementProcessing = false;
        task.workflowEpoch = (task.workflowEpoch ?? 0) + 1;
        task.adjustmentInProgress = false;
        task.autoAdjustmentSeconds = undefined;
        this.persist();
        await relatedTerminations;
        return;
      }
      task.cancelRequested = true;
      task.requirementProcessing = false;
      task.workflowEpoch = (task.workflowEpoch ?? 0) + 1;
      task.adjustmentInProgress = false;
      task.autoAdjustmentSeconds = undefined;
      const terminationEpoch = task.workflowEpoch;
      this.pushMessage(task, { role: "user", kind: "event", content: "正在停止本次执行及其当前远程进程，业务目标保留…" });
      const executionId = task.currentExecutionId;
      const targetServerId = executionServerId(task);
      const server = this.servers.find((item) => item.id === targetServerId);
      const password = this.getRuntimeConnection(targetServerId)?.password;
      const agentSession = useAgentTerminalStore().sessionsByTask[task.id];
      try { await cancelExecutionLedger(this, taskId); }
      catch (error) { task.executionLedgerError = { stage: "cancel", message: String(error), remoteResultKnown: false }; }
      let agentExecutionHandled = false;
      if (executionId && server && password && agentSession && agentSession.state === "busy") {
        try {
          agentExecutionHandled = await backend.interruptAgentCommand(
            { host: server.host, port: server.port, username: server.username, password },
            agentSession,
            executionId,
          );
        } catch (error) {
          this.pushMessage(task, { role: "system", kind: "event", content: `Agent 远程终止请求返回：${String(error)}` });
        }
      }
      if (executionId) {
        try { await backend.cancelSftpTransfer(executionId); } catch { /* 当前执行并非文件传输。 */ }
      }
      if (executionId && server && password && !agentExecutionHandled) {
        try {
          await backend.cancelCommand(
            { host: server.host, port: server.port, username: server.username, password },
            executionId,
          );
        } catch (error) {
          this.pushMessage(task, { role: "system", kind: "event", content: `远程终止请求返回：${String(error)}` });
        }
      }
      if (task.workflowEpoch !== terminationEpoch || !task.cancelRequested) {
        await relatedTerminations;
        return;
      }
      transitionTask(task, "cancelled");
      this.pendingUserInputs = this.pendingUserInputs.filter((item) => item.taskId !== taskId);
      if (this.pendingSecret?.taskId === taskId) this.pendingSecret = null;
      const active = task.plan.find((step) => ["running", "validating", "awaiting_approval", "awaiting_input"].includes(step.status));
      if (active) {
        cancelStep(active, "用户终止");
      }
      task.currentExecutionId = undefined;
      task.summary = executionId ? "取消请求已发送；远端结果仍待核对，迟到结果会保留，原操作不会自动重发。"
        : "本次执行已停止，业务目标与执行证据保留，可继续完成。";
      await this.refreshExecutionLedger(taskId);
      task.pauseReason = undefined;
      this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
      this.persist(true);
      await relatedTerminations;
    },

    needsApproval(permission: PermissionLevel, step: PlanStep) {
      return requiresStepApproval(permission, step);
    },

    async advanceTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (task && taskRemovals.has(task)) return;
      if (!task || task.status !== "running" || task.cancelRequested) return;
      if (hasWaitingStep(task) || executingTaskSteps.get(task)?.current()
        || submittingTaskInputs.get(task)?.current()) return;
      if (this.presentTaskUserInput(taskId)) return;
      if (this.pauseTaskForConnection(task)) return;
      const lifetime = claimTaskOperation(advancingTasks, task);
      if (!lifetime) return;
      let outputRecoveryRecord: NonNullable<OpsTask["protocolRepairHistory"]>[number] | undefined;
      try {
        const targetServerId = executionServerId(task);
        const server = this.servers.find((item) => item.id === targetServerId);
        const progression = resolveTaskProgression(task, this.tools);
        if (progression.kind === "wait") return;
        if (progression.kind !== "execute-step") {
          if (this.stopBlockedModelPlanning(task)) {
            transitionTask(task, "needs_adjustment");
            this.persist();
            return;
          }
          for (const completedStep of task.plan) {
            await this.archiveTaskStepEvidence(task, completedStep);
            if (!lifetime.current()) return;
          }
          transitionTask(task, "validating");
          this.pushMessage(task, { role: "system", kind: "event", content: "执行步骤已完成，正在根据实际输出整理本轮结果…" });
          this.persist();
          const model = this.models.find((item) => item.id === task.modelId);
          const apiKey = this.modelApiKeys[task.modelId];
          const activeSkills = resolveTaskSkills(task, this.skills);
          const goalReview = await decideTaskNextStage({
            task,
            model,
            apiKey,
            server,
            metrics: this.contextMetrics(executionServerId(task)),
            tools: this.tools,
            secretMetadata: this.secretMetadata,
            generationSettings: this.aiGenerationSettings,
            skills: activeSkills,
            isCancelled: () => !lifetime.current(),
            onCandidateRegeneration: error => {
              if (error instanceof PlanProtocolError) {
                outputRecoveryRecord = { roundId: task.currentRoundId, serverId: targetServerId,
                  repair: JSON.parse(JSON.stringify(error.repair)), repairError: error.repairError,
                  requestedAt: now(), status: "planning" };
                task.protocolRepairHistory ??= [];
                task.protocolRepairHistory.push(outputRecoveryRecord);
                this.addDeveloperLog({ level: "error", operation: "workflow_progression",
                  title: "后续候选未通过校验，正在切换恢复策略", summary: error.developerMessage,
                  error: error.developerMessage, response: { repair: error.repair }, taskId, serverId: targetServerId });
              }
              this.addLog({ category: "model", level: "info", title: "系统从协议阻断自动转入业务重新规划",
                detail: JSON.stringify({ triggerSource: "system_continuation", rejectedPlanExecuted: false, sharedOperationBudget: true }),
                taskId, serverId: targetServerId });
            },
          });
          if (!lifetime.current()) return;
          if (outputRecoveryRecord) {
            outputRecoveryRecord.status = "accepted";
            outputRecoveryRecord.replacementStepIds = goalReview.nextPlan.map(step => step.id);
            outputRecoveryRecord.outcome = goalReview.decision.summary;
          }
          if ("taskDecision" in goalReview && goalReview.taskDecision) Object.assign(task, goalReview.taskDecision);
          if (goalReview.reconciliationResolution && task.executionReconciliation) {
            task.executionReconciliation.resolution = goalReview.reconciliationResolution;
          }
          this.addLog({
            category: "model",
            level: goalReview.complete ? "success" : "warning",
            title: goalReview.complete ? "整体目标完成门禁已通过" : "当前阶段结束但整体目标尚未完成",
            detail: JSON.stringify({
              rootGoal: goalReview.requirement,
              decision: goalReview.decision,
              combinedFallback: "combinedError" in goalReview ? goalReview.combinedError : undefined,
            }, null, 2),
            serverId: targetServerId,
            taskId,
          });
          if (!goalReview.complete) {
            if ("outputRegenerated" in goalReview && goalReview.outputRegenerated && goalReview.nextPlan.length) {
              // Admit the accepted candidate once. Recovery must not send it
              // back through another model operation or bypass step approval.
              archiveActivePhase(task, "adjustment", now(), goalReview.decision.summary);
              this.prepareTaskPlan(task, goalReview.nextPlan);
              task.protocolRepair = undefined;
              task.latestGoalReview = undefined;
              task.pauseReason = undefined;
              if (this.presentTaskUserInput(taskId)) return;
              transitionTask(task, "awaiting_continuation");
              transitionTask(task, "awaiting_plan_approval");
              this.pushPlanProgressMessage(task, `后续方案已重新整理，包含 ${goalReview.nextPlan.length} 个执行步骤；系统将按现有授权继续，需要确认的步骤会在执行前单独提示。`);
              this.persist();
              lifetime.release();
              await this.approvePlan(taskId, true, "protocol_replan");
              return;
            }
            if (goalReview.nextPlan?.length) {
              const previousPlan = task.plan;
              task.plan = [...previousPlan, ...goalReview.nextPlan];
              if (this.presentTaskUserInput(taskId)) return;
              task.plan = previousPlan;
            }
            transitionTask(task, "awaiting_continuation");
            task.pauseReason = goalReview.decision.summary;
            const continuationIncident = buildAdjustmentBlockerSnapshot(
              task,
              undefined,
              this.adjustmentTargetState(task),
            );
            task.latestGoalReview = {
              decision: {
                decision: goalReview.decision.decision,
                reason: goalReview.decision.reason,
                summary: goalReview.decision.summary,
                source: goalReview.decision.source,
              },
              snapshot: goalReview.snapshot,
              nextPlan: goalReview.nextPlan?.map((step) => structuredClone(step)),
              continuationIncidentFingerprint: goalReview.nextPlan?.length
                ? continuationIncident.fingerprint
                : undefined,
              policyFingerprint: goalReview.policyFingerprint,
              createdAt: now(),
            };
            stopForBlockedNoAction(task);
            this.pushMessage(task, {
              role: "assistant",
              kind: "event",
              content: `${currentRequestCompleted(task) ? "本轮需求已完成；其他目标的状态分别保留：" : "当前计划阶段已完成，但整体目标尚未验收："}${goalReview.decision.summary}`,
            });
            this.persist();
            return;
          }
          task.latestGoalReview = undefined;
          task.summary = goalReview.decision.summary;
          transitionTask(task, "completed");
          task.pauseReason = undefined;
          this.addLog({
            category: "task",
            level: "success",
            title: "智能运维任务完成",
            detail: task.summary,
            serverId: targetServerId,
            taskId,
          });
          this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
          this.persist();
          return;
        }
        const step = progression.step;
        if (!step.executionIntent) this.prepareTaskPlan(task);
        else if (stableProtocolValue(step.executionIntent.semantic.dependencies.failureDependencies) !== stableProtocolValue(step.failureDependencies)) {
          // Failure review can revise the controller-owned dependency decision.
          // Re-admit the stage, then re-evaluate approval under the current policy.
          this.prepareTaskPlan(task);
          this.pushMessage(task, { role: "system", kind: "event", content: "失败复核已更新后续步骤的依赖判断，执行前将按当前授权重新评估。" });
        }
        this.assertPreparedStep(task, step);

        const dependencyBlocker = failureDependencyBlocker(step);
        if (dependencyBlocker) {
          transitionTask(task, "needs_adjustment");
          task.pauseReason = dependencyBlocker;
          this.pushMessage(task, { role: "assistant", kind: "event", content: dependencyBlocker });
          this.persist();
          if (task.permission === "managed") void this.queueManagedAdjustment(task.id, 5);
          return;
        }

        if (observationBoundary(task, step, this.tools)) {
          transitionTask(task, "needs_adjustment");
          task.latestGoalReview = undefined;
          task.pauseReason = "只读检查已有新结果，正在据此确认后续变更的前提并更新剩余计划。";
          this.persist();
          lifetime.release();
          await this.beginAdjustment(taskId, true);
          return;
        }

        if (step.action?.type !== "tool") {
          step.progressMessage = "正在进行执行前安全检查…";
          const safety = await inspectPlanSafety(step.command, step.validation, false);
          if (!lifetime.current()) return;
          this.assertPreparedStep(task, step);
          if (safety.issues.length) {
            const failure = failPlanSafetyCheck(step, safety.issues);
            transitionTask(task, "needs_adjustment");
            task.pauseReason = failure.pauseReason;
            this.pushMessage(task, { role: "assistant", kind: "event", content: failure.eventMessage });
            this.persist();
            if (task.permission === "managed") {
              void this.queueManagedAdjustment(task.id, 5);
            }
            return;
          }
        }

        const approval = requestStepApproval(task.permission, step, this.tools);
        if (approval) {
          transitionTask(task, approval.taskStatus);
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: approval.eventMessage,
          });
          this.persist();
          return;
        }
        lifetime.release();
        await this.runStep(taskId, step.id);
      } catch (error) {
        if (lifetime.current()) {
          if (outputRecoveryRecord) {
            outputRecoveryRecord.status = "failed";
            outputRecoveryRecord.outcome = error instanceof Error ? error.message : String(error);
            this.addDeveloperLog({ level: "error", operation: "protocol_business_replan", title: "完整候选重生成未通过校验",
              summary: outputRecoveryRecord.outcome, error: outputRecoveryRecord.outcome, taskId, serverId: executionServerId(task) });
          }
          const continueRecovery = error instanceof PlanProtocolError && !error.repair.businessReplanProgress;
          this.pauseWorkflowFailure(task, error, continueRecovery);
          if (continueRecovery) {
            // A rejected continuation proposal has not executed anything and
            // does not grant new authority. Ask for one fresh joint decision;
            // a second protocol rejection is bounded inside beginAdjustment.
            lifetime.release();
            await this.beginAdjustment(task.id, false, undefined, "system_continuation");
          }
        }
      } finally {
        lifetime.release();
      }
    },

    reprepareChangedStepApproval(task: OpsTask, step: PlanStep) {
      // The click authorized the previously displayed intent only. Release
      // its wait and prepare current facts locally so the next confirmation
      // can authorize the new target without a paid model regeneration.
      transitionStep(step, "pending");
      step.approvalGrant = undefined;
      step.safetyApprovalSnapshot = undefined;
      step.approvedSafetySnapshot = undefined;
      task.planApproval = undefined;
      transitionTask(task, "needs_adjustment");
      try {
        this.prepareTaskPlan(task);
        transitionTask(task, "awaiting_plan_approval");
        task.pauseReason = "执行动作、目标或授权条件已更新，计划已重新准备。请核对当前内容后确认。";
        this.pushMessage(task, { role: "system", kind: "event", content: task.pauseReason });
        this.persist();
      } catch (error) {
        this.pauseWorkflowFailure(task, error);
      }
    },

    async approveStep(taskId: string, stepId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (task && taskRemovals.has(task)) return;
      const step = task?.plan.find((item) => item.id === stepId);
      if (!task || !step || task.cancelRequested || task.requirementProcessing
        || task.status !== "awaiting_step_approval"
        || task.plan.find(item => !["completed", "failed", "skipped"].includes(item.status)) !== step
        || advancingTasks.get(task)?.current() || executingTaskSteps.get(task)?.current()) return;
      try { this.assertPreparedStep(task, step); }
      catch { this.reprepareChangedStepApproval(task, step); return; }
      if (!step.executionIntent) {
        try { this.prepareTaskPlan(task); }
        catch { this.reprepareChangedStepApproval(task, step); return; }
        requestStepApproval("observe", step, this.tools);
        this.persist();
        return;
      }
      const approval = acceptStepApproval(step, task.preparedPlan);
      if (!approval) { this.reprepareChangedStepApproval(task, step); return; }
      if (step.authenticationGate?.fingerprint === authenticationFingerprint(task, step)) step.authenticationGate.approved = true;
      transitionTask(task, approval.taskStatus);
      await this.runStep(taskId, stepId);
      if (task.permission === "managed" && ["needs_adjustment", "awaiting_continuation"].includes(task.status)) {
        void this.queueManagedAdjustment(task.id, 5);
      }
    },

    async validateRecoveryDispatch(taskId: string, stepId: string, isCancelled: () => boolean) {
      const task = this.tasks.find(item => item.id === taskId);
      const step = task?.plan.find(item => item.id === stepId);
      if (!task || !step || isCancelled()) return false;
      const recoveryBlocker = reconciliationBlocker(task, step) ?? retryBlocker(task, step);
      if (recoveryBlocker) {
        transitionTask(task, "needs_adjustment");
        task.pauseReason = recoveryBlocker;
        task.managedAdjustmentPhase = "manual_required";
        this.pushMessage(task, { role: "assistant", kind: "event", content: recoveryBlocker });
        this.persist();
        return false;
      }
      const dependencyBlocker = failureDependencyBlocker(step);
      if (dependencyBlocker) {
        transitionTask(task, "needs_adjustment");
        task.pauseReason = dependencyBlocker;
        this.pushMessage(task, { role: "assistant", kind: "event", content: dependencyBlocker });
        this.persist();
        return false;
      }
      pinTaskSkills(task, this.skills);
      const capabilityError = executionCapabilityBlocker(task, step, this.skills);
      if (capabilityError) {
        transitionTask(task, "needs_adjustment"); task.pauseReason = capabilityError;
        this.pushMessage(task, { role: "assistant", kind: "event", content: capabilityError });
        this.persist(); return false;
      }
      try {
        await backend.configureTaskCapabilities(task.id, shellAllowed(task, this.skills));
        validateRecoveryReferences(recoveryHistory(task), [step], taskAttemptContext(task));
      } catch (error) {
        transitionTask(task, "needs_adjustment");
        task.pauseReason = error instanceof Error ? error.message : String(error);
        this.pushMessage(task, { role: "assistant", kind: "event", content: task.pauseReason });
        this.persist();
        return false;
      }
      const policyBlocker = executionPolicyBlocker(task, step);
      if (policyBlocker) {
        transitionTask(task, "needs_adjustment");
        task.pauseReason = policyBlocker;
        this.pushMessage(task, { role: "assistant", kind: "event", content: policyBlocker });
        this.persist();
        return false;
      }
      refreshProtocolReplanApproval(task, step);
      if (step.protocolReplanApproval && !hasCurrentStepApproval(step)) {
        const approval = requestStepApproval(task.permission, step);
        if (approval) {
          transitionTask(task, approval.taskStatus);
          this.pushMessage(task, { role: "assistant", kind: "event", content: approval.eventMessage });
          this.persist();
          return false;
        }
      }
      return true;
    },

    async runToolStep(taskId: string, stepId: string, call: ToolCall) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (task && taskRemovals.has(task)) return;
      const step = task?.plan.find((item) => item.id === stepId);
      if (!task || !step || task.status !== "running" || task.cancelRequested
        || !["pending", "awaiting_approval"].includes(step.status)
        || task.plan.find(item => !["completed", "failed", "skipped"].includes(item.status)) !== step
        || task.plan.some(item => item !== step && ["awaiting_input", "awaiting_approval", "running", "validating"].includes(item.status))
        || advancingTasks.get(task)?.current() || submittingTaskInputs.get(task)?.current()) return;
      const suppliedCall = call;
      const currentCall = () => {
        this.assertPreparedStep(task, step);
        const dispatch = resolveStepDispatch(step, task.confirmedSecretKeys ?? [], suppliedCall.id, this.tools);
        if (dispatch.kind !== "tool") throw new Error(dispatch.kind === "invalid" ? dispatch.error : "步骤缺少结构化工具 action");
        const supplied = parseToolAction({ type: "tool", toolId: suppliedCall.toolId, arguments: suppliedCall.arguments }, suppliedCall.id, this.tools);
        if (supplied && step.executionIntent) {
          const definition = this.tools.find(tool => tool.id === supplied.toolId);
          if (!definition) throw new Error("工具已不可用");
          supplied.arguments = prepareFinalToolArguments(definition, supplied.arguments);
        }
        if (stableProtocolValue(supplied) !== stableProtocolValue(dispatch.call)) throw new Error("工具调用参数与当前步骤不一致，拒绝执行");
        const normalizedAction = { type: "tool" as const, toolId: dispatch.call.toolId, arguments: dispatch.call.arguments };
        if (stableProtocolValue(step.action) !== stableProtocolValue(normalizedAction)) {
          if (step.executionIntent) throw new Error("工具参数已变化，必须重新准备和批准");
          step.action = normalizedAction;
        }
        return dispatch.call;
      };
      try { call = currentCall(); }
      catch (error) {
        const failure = failToolCommandParsing(step, String(error));
        transitionTask(task, "needs_adjustment");
        task.pauseReason = failure.pauseReason;
        this.pushMessage(task, { role: "assistant", kind: "event", content: failure.eventMessage });
        this.persist();
        return;
      }
      const toolDefinition = this.tools.find((tool) => tool.id === call.toolId);
      if (toolDefinition?.executionMode === "user-input") {
        if (!this.presentTaskUserInput(taskId)) {
          const failure = failToolCommandParsing(step, "用户确认必须是当前唯一待执行步骤，且参数有效");
          transitionTask(task, "needs_adjustment");
          task.pauseReason = failure.pauseReason;
          this.pushMessage(task, { role: "assistant", kind: "event", content: failure.eventMessage });
          this.persist();
        }
        return;
      }
      if (this.pauseTaskForConnection(task)) return;
      const targetServerId = executionServerId(task);
      const connectionGeneration = this.serverConnection(targetServerId).generation;
      const lifetime = claimTaskOperation(executingTaskSteps, task);
      if (!lifetime) return;
      try {
        if (!step.executionIntent) {
          try { this.prepareTaskPlan(task); }
          catch (error) {
            const failure = failToolCommandParsing(step, String(error));
            transitionTask(task, "needs_adjustment");
            task.pauseReason = failure.pauseReason;
            this.pushMessage(task, { role: "assistant", kind: "event", content: failure.eventMessage });
            this.persist();
            return;
          }
        }
        if (!await this.validateRecoveryDispatch(taskId, stepId, () => !lifetime.current())) return;
        if (observationBoundary(task, step, this.tools)) {
          transitionTask(task, "needs_adjustment");
          task.latestGoalReview = undefined;
          task.pauseReason = "只读检查已有新结果，正在据此确认后续变更的前提并更新剩余计划。";
          this.persist();
          lifetime.release();
          await this.beginAdjustment(taskId, true);
          return;
        }
        // Revalidate after asynchronous policy checks and bind the approved action to dispatch.
        try { call = currentCall(); }
        catch (error) {
          const failure = failToolCommandParsing(step, String(error));
          transitionTask(task, "needs_adjustment");
          task.pauseReason = failure.pauseReason;
          this.pushMessage(task, { role: "assistant", kind: "event", content: failure.eventMessage });
          this.persist();
          return;
        }
        if (requiresStepApproval(task.permission, step, this.tools) && !hasCurrentStepApproval(step)) {
          requestStepApproval(task.permission, step, this.tools);
          transitionTask(task, "awaiting_step_approval");
          step.approvedSafetySnapshot = undefined;
          this.pushMessage(task, { role: "assistant", kind: "event", content: `步骤“${step.title}”需要确认当前工具及参数后执行。` });
          this.persist();
          return;
        }
        step.attemptContext = taskAttemptContext(task);
        task.currentExecutionId = call.id;
        const frozenIntentDigest = step.executionIntent?.digest;
        // Comparison only: never persist or include supplied values in a diagnostic.
        const frozenInputBindings = stableProtocolValue({ inputs: task.submittedInputs, secrets: task.submittedSecretBindings });
        let toolSubmitted = false;
        let toolFailedBeforeSend = false;
        let toolAttemptNumber = 0;
        const lifecycle = await runToolStepLifecycle({
          step,
          call,
          execute: async () => {
            // Retry delays are asynchronous boundaries too. Never move an old
            // call onto a replacement connection, target, or edited plan.
            if (executionServerId(task) !== targetServerId
              || this.serverConnection(targetServerId).generation !== connectionGeneration) {
              throw new ToolExecutionError("工具调用的目标连接已变化，请核对目标后重新规划", "unavailable", "not_sent");
            }
            lifetime.assertCurrent();
            this.assertPreparedStep(task, step);
            const dispatch = resolveStepDispatch(step, task.confirmedSecretKeys ?? [], call.id, this.tools);
            if (task.plan.find(item => item.id === stepId) !== step
              || dispatch.kind !== "tool" || stableProtocolValue(dispatch.call) !== stableProtocolValue(call)
              || requiresStepApproval(task.permission, step, this.tools) && !hasCurrentStepApproval(step)) {
              throw new ToolExecutionError("工具步骤或审批在等待期间已变化，已停止派发", "permission", "not_sent");
            }
            const physicalId = toolAttemptNumber++ === 0 ? call.id : uid("tool-attempt");
            task.currentExecutionId = physicalId;
            const result = await this.recordStepExecution(task, step, "tool", physicalId, () => lifetime.current(), async () => {
              lifetime.assertCurrent();
              this.assertPreparedStep(task, step);
              return this.executeToolCall(
              targetServerId,
              { ...call, id: physicalId },
              (message) => { step.progressMessage = message; },
              undefined,
              task.id,
              () => { toolSubmitted = true; },
              { prepared: Boolean(step.executionIntent),
                assertPrepared: () => this.assertPreparedStep(task, step),
                assertCurrent: () => {
                  lifetime.assertCurrent();
                  const intent = step.executionIntent;
                  const definition = this.tools.find(tool => tool.id === call.toolId);
                  if (task.plan.find(item => item.id === stepId) !== step || !intent || intent.digest !== frozenIntentDigest
                    || !stepMatchesExecutionIntent(step) || task.permission !== intent.semantic.permission
                    || stableProtocolValue({ inputs: task.submittedInputs, secrets: task.submittedSecretBindings }) !== frozenInputBindings
                    || stableProtocolValue(task.executionConstraints) !== stableProtocolValue(intent.semantic.constraints)
                    || !definition || stableProtocolValue(effectiveToolSemanticContract(definition)) !== stableProtocolValue(intent.semantic.toolContract)
                    || requiresStepApproval(task.permission, step, this.tools) && !hasCurrentStepApproval(step)) {
                    throw new ToolExecutionError("复合工具执行期间动作或授权已变化", "permission", "not_sent");
                  }
                },
              },
            );
            });
            toolFailedBeforeSend = !result.success && result.error?.dispatchState === "not_sent";
            return { ...result, callId: call.id };
          },
          onRetry: attempt => { step.progressMessage = `只读调用暂时失败，正在进行第 ${attempt} 次重试…`; },
          createEvidenceId: () => uid("evidence-tool"),
          now,
          isCancelled: () => !lifetime.current(),
          onStart: (eventMessage) => {
            transitionTask(task, "running");
            this.pushMessage(task, { role: "assistant", kind: "event", content: eventMessage });
            this.persist();
          },
        });
        if (!lifetime.current()) return;
        task.currentExecutionId = undefined;
        if (lifecycle.cancelled) return;
        if (toolSubmitted && !toolFailedBeforeSend) this.recordAdjustmentExecution(task, step.id);
        if (isTauri() && this.tools.some(tool => tool.id === "evidence.read" && tool.enabled)) {
          await archiveToolEvidence(task, step, backend.saveTaskEvidence,
            text => redactExecutionOutput(text, serverSecretValues(this.secretValues, executionServerId(task))));
        }
        if (!lifetime.current()) return;
        transitionTask(task, lifecycle.taskStatus);
        if (step.status === "completed") await this.markExecutionVerified(step);
        else await this.markExecutionReviewed(step);
        if (!lifetime.current()) return;
        if (step.status === "failed") {
          holdFailureDependents(step, task.plan.filter(item => item.status === "pending"));
          if (toolSubmitted && !toolFailedBeforeSend && step.result?.facts.commandDispatched !== false) {
            recordExecutionUncertainty(task, step, "已提交的变更工具返回失败，需先核对是否产生部分副作用。");
          }
        }
        task.pauseReason = lifecycle.pauseReason;
        this.pushMessage(task, {
          role: "assistant",
          kind: "event",
          content: lifecycle.eventMessage,
        });
        this.persist();
        if (!lifecycle.shouldAdvance) {
          if (toolFailureFallback(step) && executionServerId(task) === targetServerId
            && this.serverConnection(targetServerId).generation === connectionGeneration
            && step.executionIntent?.digest === frozenIntentDigest && stepMatchesExecutionIntent(step)) {
            lifetime.release();
            await this.routeAutomaticAdjustment(taskId);
          } else if (isTerminalTransportFailure(lifecycle.pauseReason) && step.result) {
            step.result.facts.category = "terminal_transport";
            step.result.facts.commandCompleted = false;
            step.result.facts.terminalReleased = false;
            lifetime.release();
            await this.routeAutomaticAdjustment(taskId, { transportRecovery: true });
          }
          return;
        }
        lifetime.release();
        await this.advanceTask(taskId);
      } catch (error) {
        if (error instanceof ExecutionLedgerError) {
          if (lifetime.current()) this.handleExecutionLedgerError(task, step, error);
          else await this.refreshExecutionLedger(taskId);
          return;
        }
        throw error;
      } finally {
        lifetime.release();
        void this.refreshExecutionLedger(taskId);
      }
    },

    async runStep(taskId: string, stepId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (task && taskRemovals.has(task)) return;
      const step = task?.plan.find((item) => item.id === stepId);
      if (!task || !step || task.cancelRequested || task.status !== "running"
        || !["pending", "awaiting_approval"].includes(step.status)
        || task.plan.find(item => !["completed", "failed", "skipped"].includes(item.status)) !== step
        || task.plan.some(item => item !== step && ["awaiting_input", "awaiting_approval", "running", "validating"].includes(item.status))
        || advancingTasks.get(task)?.current() || submittingTaskInputs.get(task)?.current()) return;
      if (this.presentTaskUserInput(taskId)) return;
      if (this.pauseTaskForConnection(task)) return;
      const lifetime = claimTaskOperation(executingTaskSteps, task);
      if (!lifetime) return;
      try {
        if (!await this.validateRecoveryDispatch(taskId, stepId, () => !lifetime.current())) return;
        if (observationBoundary(task, step, this.tools)) {
          transitionTask(task, "needs_adjustment");
          task.latestGoalReview = undefined;
          task.pauseReason = "只读检查已有新结果，正在据此确认后续变更的前提并更新剩余计划。";
          this.persist();
          lifetime.release();
          await this.beginAdjustment(taskId, true);
          return;
        }
        if (!step.executionIntent) {
          try { this.prepareTaskPlan(task); }
          catch (error) {
            const failure = failToolCommandParsing(step, String(error));
            transitionTask(task, "needs_adjustment");
            task.pauseReason = failure.pauseReason;
            this.pushMessage(task, { role: "assistant", kind: "event", content: failure.eventMessage });
            this.persist();
            return;
          }
        }
        step.attemptContext = taskAttemptContext(task);
        const failureScope = commandExecutionScope(step, task.id);
        const targetServerId = executionServerId(task);
        const connectionGeneration = this.serverConnection(targetServerId).generation;
        const assertConnection = () => {
          lifetime.assertCurrent();
          const capabilityError = executionCapabilityBlocker(task, step, this.skills);
          if (capabilityError) throw new Error(capabilityError);
          if (!this.getRuntimeConnection(targetServerId)
            || executionServerId(task) !== targetServerId
            || this.serverConnection(targetServerId).generation !== connectionGeneration) {
            throw new Error("SSH 连接已断开或更换，远程操作已暂停；已发送命令的结果需核对");
          }
          this.assertPreparedStep(task, step);
        };
        const incompatibleSecret = findSecretKeys(`${step.command}\n${step.validation}`)
          .map((key) => ({ key, metadata: this.secretMetadata.find((item) => item.key === key && item.serverId === targetServerId) }))
          .find(({ metadata }) => metadata && secretPurposeMismatch(step, metadata.description));
        if (incompatibleSecret?.metadata) {
          const failure = failSecretPurposeMismatch(step, incompatibleSecret.key, incompatibleSecret.metadata.description);
          transitionTask(task, "needs_adjustment");
          task.pauseReason = failure.pauseReason;
          this.pushMessage(task, { role: "assistant", kind: "event", content: failure.eventMessage });
          this.persist();
          return;
        }
        const activeSkills = resolveTaskSkills(task, this.skills);
        const dispatch = resolveStepDispatch(
          step,
          task.confirmedSecretKeys ?? [],
          uid("tool-call"),
          this.tools,
          Object.keys(serverSecretValues(this.secretValues, targetServerId)),
          selectPlanningTools(this.tools, activeSkills).map(({ id }) => id),
        );
        const secretKey = dispatch.kind === "await-secret" ? dispatch.key : undefined;
        const metadata = secretKey
          ? this.secretMetadata.find((item) => item.key === secretKey && item.serverId === targetServerId)
          : undefined;
        if (dispatch.kind !== "command") {
          const entry = applyStepExecutionEntry({
            taskTitle: task.title,
            step,
            dispatch,
            startedAt: now(),
            secretDescription: metadata?.description,
          });
          if (entry.kind === "tool") {
            lifetime.release();
            await this.runToolStep(taskId, stepId, entry.call);
            return;
          }
          if (entry.kind === "stop") {
            transitionTask(task, entry.taskStatus);
            if (entry.taskStatus === "awaiting_input") {
              task.workflowEpoch = (task.workflowEpoch ?? 0) + 1;
              task.autoAdjustmentSeconds = undefined;
              task.managedStopReason = "user_input_required";
            }
            task.pauseReason = entry.pauseReason;
            if (entry.pendingSecretKey) {
              this.pendingSecret = {
                ...buildSecretUnlockRequest({
                  taskId,
                  step,
                  key: entry.pendingSecretKey,
                  metadataDescription: metadata?.description,
                }), roundId: task.currentRoundId, workflowEpoch: task.workflowEpoch,
                serverId: targetServerId, command: step.command
              };
            }
            this.pushMessage(task, {
              role: "assistant",
              kind: "event",
              content: entry.eventMessage,
            });
            this.persist();
          }
          return;
        }

        if (requiresStepApproval(task.permission, step, this.tools) && !hasCurrentStepApproval(step)) {
          requestStepApproval(task.permission, step, this.tools);
          transitionTask(task, "awaiting_step_approval");
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: `步骤“${step.title}”的命令或后置校验在批准后发生变化，原批准已失效；请检查最终内容后重新确认。`,
          });
          this.persist();
          return;
        }

        const server = this.servers.find((item) => item.id === targetServerId);
        const password = this.getRuntimeConnection(targetServerId)?.password;
        task.authenticationCredentials = credentialGroupContext(this.secretMetadata, targetServerId);
        const authenticationReason = authenticationBlocker(task, step, this.secretMetadata)
          ?? (step.validation ? authenticationBlocker(task, { ...step, command: step.validation }, this.secretMetadata) : undefined);
        const authenticationIdentity = authenticationFingerprint(task, step);
        if (authenticationReason && !(step.authenticationGate?.approved && step.authenticationGate.fingerprint === authenticationIdentity)) {
          step.authenticationGate = { fingerprint: authenticationIdentity, reason: authenticationReason };
          requestStepApproval("observe", step, this.tools);
          transitionTask(task, "awaiting_step_approval");
          task.pauseReason = authenticationReason;
          task.autoAdjustmentSeconds = undefined;
          this.pushMessage(task, { role: "assistant", kind: "event", content: authenticationReason });
          this.addLog({
            category: "task", level: "warning", title: "认证方式需要明确确认（未执行）",
            detail: authenticationReason, taskId, serverId: targetServerId
          });
          this.persist();
          return;
        }
        const runtimeModel = this.models.find((item) => item.id === task.modelId);
        const runtimeApiKey = this.modelApiKeys[task.modelId];
        const scopedSecrets = serverSecretValues(this.secretValues, targetServerId);
        const unsafeCredentialUsername = findSecretKeys(step.command)
          .map((key) => this.secretMetadata.find((item) => item.serverId === targetServerId
            && item.key === key
            && item.credentialRole === "username"
            && item.credentialKind))
          .find((item) => item?.credentialKind
            && credentialUsernameValidationError(item.credentialKind, scopedSecrets[item.key] ?? ""));
        if (unsafeCredentialUsername?.credentialKind) {
          const failure = failSecretPurposeMismatch(
            step,
            unsafeCredentialUsername.key,
            credentialUsernameValidationError(
              unsafeCredentialUsername.credentialKind,
              scopedSecrets[unsafeCredentialUsername.key] ?? "",
            ) ?? unsafeCredentialUsername.description,
          );
          transitionTask(task, "needs_adjustment");
          task.pauseReason = failure.pauseReason;
          this.pushMessage(task, { role: "assistant", kind: "event", content: failure.eventMessage });
          this.persist();
          return;
        }
        const prepared = prepareStepExecution({
          step,
          server,
          serverPassword: password,
          model: runtimeModel,
          modelApiKey: runtimeApiKey,
          secretValues: scopedSecrets,
        });
        const finalSafety = await inspectPlanSafety(
          prepared.resolvedCommand,
          prepared.resolvedValidation,
          false,
        );
        if (!lifetime.current()) return;
        if (this.pauseTaskForConnection(task, connectionGeneration)) return;
        this.assertPreparedStep(task, step);
        if (finalSafety.issues.length) {
          const failure = failPlanSafetyCheck(step, finalSafety.issues);
          transitionTask(task, "needs_adjustment");
          task.pauseReason = failure.pauseReason;
          this.pushMessage(task, { role: "assistant", kind: "event", content: failure.eventMessage });
          this.persist();
          if (task.permission === "managed") {
            void this.queueManagedAdjustment(task.id, 5);
          }
          return;
        }

        const commandCredentialResolution = resolveInteractivePtyCredential(
          step,
          task.confirmedSecretKeys ?? [],
          scopedSecrets,
          this.secretMetadata.filter((item) => item.serverId === targetServerId),
          task.submittedInputs,
          task.submittedSecretBindings,
        );
        const validationCredentialResolution = resolveInteractivePtyCredential(
          { ...step, command: step.validation },
          task.confirmedSecretKeys ?? [],
          scopedSecrets,
          this.secretMetadata.filter((item) => item.serverId === targetServerId),
          task.submittedInputs,
          task.submittedSecretBindings,
        );
        const credentialFailure = commandCredentialResolution.status === "blocked"
          ? { phase: "主命令", resolution: commandCredentialResolution }
          : validationCredentialResolution.status === "blocked"
            ? { phase: "独立后置校验", resolution: validationCredentialResolution }
            : undefined;
        if (credentialFailure) {
          const failure = failInteractiveCredentialResolution(
            step,
            credentialFailure.resolution.code,
            `${credentialFailure.phase}：${credentialFailure.resolution.error}`,
          );
          transitionTask(task, "needs_adjustment");
          task.pauseReason = failure.pauseReason;
          this.pushMessage(task, { role: "assistant", kind: "event", content: failure.eventMessage });
          this.persist();
          if (task.permission === "managed") {
            void this.queueManagedAdjustment(task.id, 5);
          }
          return;
        }
        const interactivePromptCredential = commandCredentialResolution.status === "resolved"
          ? commandCredentialResolution.credential
          : undefined;
        const validationPromptCredential = validationCredentialResolution.status === "resolved"
          ? validationCredentialResolution.credential
          : undefined;
        const hasFixedPromptChannel = Boolean(interactivePromptCredential)
          && agentSandboxTerminalV1Enabled() && isTauri() && Boolean(prepared.connection);
        const authRetryBlocker = gitAuthenticationRetryBlocker(task, step, recoveryHistory(task), hasFixedPromptChannel);
        if (authRetryBlocker) {
          transitionTask(task, "needs_adjustment");
          task.pauseReason = authRetryBlocker;
          task.autoAdjustmentSeconds = undefined;
          task.managedAdjustmentPhase = "manual_required";
          task.managedStopReason = "workflow_error";
          this.pushMessage(task, { role: "assistant", kind: "event", content: authRetryBlocker });
          this.persist();
          return;
        }
        step.authenticationAttempt = {
          channel: hasFixedPromptChannel ? "foreground-pty-v2" : "noninteractive",
          credentialRevision: task.credentialRevision ?? 0,
        };
        if (step.executionIntent && (step.command !== prepared.commandTemplate || step.validation !== prepared.validationTemplate)) {
          throw new Error("命令模板需要重新准备，原批准已失效");
        }
        step.command = prepared.commandTemplate;
        step.validation = prepared.validationTemplate;

        const entry = applyStepExecutionEntry({
          taskTitle: task.title,
          step,
          dispatch,
          startedAt: now(),
          secretDescription: metadata?.description,
        });
        if (entry.kind !== "command") return;
        transitionTask(task, entry.taskStatus);
        this.pushMessage(task, { role: "assistant", kind: "event", content: entry.eventMessage });
        appendTerminalBlock(this.terminalLines, entry.terminalHeader);
        const agentTerminals = useAgentTerminalStore();
        const scopedStep = normalizePlanStepExecutionScope(step);
        if (step.executionIntent && (step.executionScope !== scopedStep.executionScope
          || step.validationScope !== scopedStep.validationScope || step.runtimeClass !== scopedStep.runtimeClass)) {
          throw new Error("执行作用域需要重新准备，原批准已失效");
        }
        step.executionScope = scopedStep.executionScope;
        step.validationScope = scopedStep.validationScope;
        step.runtimeClass = scopedStep.runtimeClass;
        const useAgentSandbox = agentSandboxTerminalV1Enabled()
          && isTauri()
          && Boolean(prepared.connection);
        agentTerminals.system(task.id, entry.terminalHeader);
        this.persist();

        let executionPhase: "command" | "validation" = "command";
        let commandSubmitted = false;
        let monitoringModelError: ModelInvocationError | undefined;
        let agentSession: import("@/types").AgentSessionRef | undefined = agentTerminals.sessionsByTask[task.id];
        const invalidateAgentSession = (generation?: number) => {
          if (!agentSession || !lifetime.current()) return;
          agentTerminals.invalidateSession(task.id, agentSession.id, generation);
          task.agentSessionGeneration = agentTerminals.sessionsByTask[task.id]?.generation;
        };
        let rollbackShellStartupOnFailure: ((reason: string) => Promise<boolean>) | undefined;
        try {
          if (useAgentSandbox && prepared.connection) {
            agentSession = await this.ensureTaskAgentSession(task.id);
          }
          if (!lifetime.current()) return;
          const executionId = uid("exec");
          const startupTransaction = buildShellStartupTransaction(step, executionId);
          let startupRollbackAttempted = false;
          let startupRollbackSucceeded: boolean | undefined;
          let startupRollbackOutput = "";
          const executeFrameworkCommand = async (
            command: string,
            frameworkExecutionId: string,
            approvedHighRisk = false,
          ) => {
            assertConnection();
            task.currentExecutionId = frameworkExecutionId;
            agentTerminals.begin(
              task.id,
              frameworkExecutionId,
              redactExecutionOutput(command, scopedSecrets),
              "isolated_exec",
              false,
            );
            let frameworkStreamed = false;
            try {
              const semantic = { ...step.executionIntent!.semantic, action: { type: "shell" as const,
                command: redactExecutionOutput(command, scopedSecrets) }, effect: "change" as const };
              const intent: ExecutionIntentSnapshot = { version: "execution-intent@1", algorithm: "sha256", semantic,
                digest: executionDigest({ version: "execution-intent@1", semantic }) };
              const frameworkResult = await this.recordStepExecution(task, step, "framework", frameworkExecutionId,
                () => lifetime.current(), async () => {
                assertConnection();
                return useAgentSandbox && prepared.connection && agentSession
                ? await backend.executeAgentCommand({
                  connection: prepared.connection,
                  session: agentSession,
                  executionId: frameworkExecutionId,
                  command,
                  scope: "isolated_exec",
                  approvedHighRisk,
                  onSessionInvalidated: invalidateAgentSession,
                  onProgress: (event) => {
                    if (!lifetime.current() || !event.data || (event.stream !== "stdout" && event.stream !== "stderr")) return;
                    const safeChunk = redactExecutionOutput(event.data, scopedSecrets);
                    if (!safeChunk) return;
                    frameworkStreamed = true;
                    agentTerminals.output(task.id, frameworkExecutionId, safeChunk);
                    appendTerminalStream(this.terminalLines, safeChunk);
                  },
                })
                : await executeStepCommand({
                  command,
                  connection: prepared.connection,
                  approvedHighRisk,
                  executionId: frameworkExecutionId,
                  secretValues: scopedSecrets,
                  onProgress: (safeChunk) => {
                    if (!lifetime.current()) return;
                    frameworkStreamed = true;
                    agentTerminals.output(task.id, frameworkExecutionId, safeChunk);
                    appendTerminalStream(this.terminalLines, safeChunk);
                  },
                });
              }, { intent, effect: "change", subkey: intent.digest });
              const safeFrameworkOutput = redactExecutionOutput(frameworkResult.output, scopedSecrets);
              if (safeFrameworkOutput && !frameworkStreamed) {
                agentTerminals.completionOutput(task.id, frameworkExecutionId, `${safeFrameworkOutput}\n`);
              }
              agentTerminals.finish(
                task.id,
                frameworkExecutionId,
                frameworkResult.exitCode ?? (frameworkResult.success ? 0 : 1),
              );
              return { ...frameworkResult, output: safeFrameworkOutput };
            } catch (error) {
              invalidateAgentSession();
              throw error;
            } finally {
              task.currentExecutionId = undefined;
            }
          };
          const rollbackShellStartup = async (reason: string) => {
            if (!startupTransaction || startupRollbackAttempted) return startupRollbackSucceeded ?? false;
            startupRollbackAttempted = true;
            this.pushMessage(task, {
              role: "system",
              kind: "event",
              content: `Shell 启动文件事务未通过（${reason}），正在从执行器快照自动回滚…`,
            });
            try {
              const rollbackResult = await executeFrameworkCommand(
                startupTransaction.rollbackCommand,
                uid("startup-rollback"),
                true,
              );
              startupRollbackSucceeded = rollbackResult.success;
              startupRollbackOutput = rollbackResult.output;
            } catch (error) {
              startupRollbackSucceeded = false;
              startupRollbackOutput = String(error);
            }
            this.pushMessage(task, {
              role: "system",
              kind: "event",
              content: startupRollbackSucceeded
                ? "Shell 启动文件已自动恢复到执行前状态；快照保留供审计。"
                : "Shell 启动文件自动回滚失败，任务必须暂停并人工检查。",
            });
            return startupRollbackSucceeded;
          };
          if (startupTransaction) {
            const snapshotResult = await executeFrameworkCommand(
              startupTransaction.snapshotCommand,
              uid("startup-snapshot"),
            );
            if (!snapshotResult.success) {
              throw new Error(`Shell 启动文件快照失败（退出码 ${snapshotResult.exitCode ?? 1}）`);
            }
            this.pushMessage(task, {
              role: "system",
              kind: "event",
              content: `Shell 启动文件执行前快照已建立：${startupTransaction.backupPaths.join("、")}`,
            });
            rollbackShellStartupOnFailure = rollbackShellStartup;
          }
          const requirement = latestTaskRequirement(task);
          step.executionPolicy = freezeCommandExecutionPolicy(step, executionId, Date.now(), step.executionPolicy);
          this.persist(true);
          const commandLifecycle = await runCommandLifecycle({
            task,
            step,
            requirement,
            command: prepared.resolvedCommand,
            validation: prepared.resolvedValidation,
            executionId,
            executionPolicy: step.executionPolicy,
            connection: prepared.connection,
            runtimeModel: prepared.runtimeModel,
            secretValues: scopedSecrets,
            isCancelled: () => !lifetime.current() || !this.isServerConnected(targetServerId)
              || this.serverConnection(targetServerId).generation !== connectionGeneration,
            onExecutionChange: (activeExecutionId) => {
              if (lifetime.current()) task.currentExecutionId = activeExecutionId;
            },
            onProgress: (safeChunk, streamedOutput) => {
              if (!lifetime.current()) return;
              if (safeChunk) this.recordAdjustmentExecution(task, step.id);
              step.output = `$ ${step.command}\n${streamedOutput}`;
              appendTerminalStream(this.terminalLines, safeChunk);
            },
            onHeartbeat: (elapsedSeconds, progressMessage) => {
              if (!lifetime.current()) return;
              step.elapsedSeconds = elapsedSeconds;
              step.progressMessage = progressMessage;
            },
            onEvent: (role, content) => {
              if (!lifetime.current()) return;
              this.pushMessage(task, { role, kind: "event", content });
              this.persist();
            },
            onAudit: ({ round, context, modelDecision, acceptedDecision }) => {
              this.addLog(buildPeriodicReviewAudit({
                stepTitle: step.title,
                round,
                context,
                modelDecision,
                acceptedDecision,
                serverId: targetServerId,
                taskId,
              }));
            },
            onError: (title, detail) => {
              this.addLog({
                category: "system",
                level: "warning",
                title,
                detail,
                serverId: targetServerId,
                taskId,
              });
            },
            cancelExecution: async () => {
              assertConnection();
              if (useAgentSandbox && prepared.connection && agentSession) {
                await backend.interruptAgentCommand(prepared.connection, agentSession, executionId);
                return;
              }
              if (prepared.connection) await backend.cancelCommand(prepared.connection, executionId);
            },
            sampleRuntimeProgress: useAgentSandbox && prepared.connection && agentSession
              ? async () => { assertConnection(); return backend.sampleAgentExecutionProgress(prepared.connection!, agentSession!, executionId); }
              : undefined,
          }, async (input) => this.recordStepExecution(task, step, "command", input.executionId, () => lifetime.current(), async () => {
            assertConnection();
            commandSubmitted = true;
            // Browser tests and the one-version rollback use the existing
            // independent stateless SSH executor. Neither route writes user PTY.
            if (!useAgentSandbox || !prepared.connection || !agentSession) {
              return executeStepCommand(input);
            }
            agentTerminals.begin(task.id, input.executionId, step.command, step.executionScope!, false);
            const result = await backend.executeAgentCommand({
              connection: prepared.connection,
              session: agentSession,
              executionId: input.executionId,
              command: input.command,
              scope: step.executionScope!,
              approvedHighRisk: input.approvedHighRisk,
              promptCredential: interactivePromptCredential,
              onSessionInvalidated: invalidateAgentSession,
              onProgress: (event) => {
                if (!lifetime.current() || !event.data || (event.stream !== "stdout" && event.stream !== "stderr")) return;
                const safeChunk = redactExecutionOutput(event.data, scopedSecrets, {
                  exactSecretKeys: input.exactSecretKeys,
                });
                if (!safeChunk) return;
                agentTerminals.output(task.id, input.executionId, safeChunk);
                input.onProgress?.(safeChunk, {
                  executionId: input.executionId,
                  data: safeChunk,
                  stream: event.stream,
                });
              },
            });
            agentTerminals.finish(task.id, input.executionId, result.exitCode);
            return {
              ...result,
              output: redactExecutionOutput(result.output, scopedSecrets, {
                exactSecretKeys: input.exactSecretKeys,
              }),
            };
          }));
          const result = commandLifecycle.result;
          if (lifetime.current()) this.recordAdjustmentExecution(task, step.id);
          const streamedOutput = commandLifecycle.streamedOutput;
          const monitorState = commandLifecycle.monitorState;
          if (monitorState.modelServiceError) {
            monitoringModelError = new ModelInvocationError("长任务模型复核额度不足", undefined, monitorState.modelServiceError);
          }
          const monitorDecision = monitorState.decision;
          const monitorValidationPassed = monitorState.validationPassed;
          const monitorRound = monitorState.reviewRound;
          if (monitorState.skippedModelReviewCount > 0) {
            this.addLog({
              category: "system", level: "info", title: `${step.title} · 长任务模型调用统计`,
              detail: JSON.stringify({
                samplingRound: monitorRound,
                modelReviewCount: monitorState.modelReviewCount,
                skippedModelReviewCount: monitorState.skippedModelReviewCount,
                reason: "CPU/I/O 有活动且无新错误时继续本地监控，周期性保留模型复核",
              }),
              serverId: targetServerId, taskId,
            });
          }
          if (!lifetime.current()) {
            await rollbackShellStartup("任务已取消");
            return;
          }
          let safeOutput = result.output;
          const authentication = recordAuthentication(task, step, this.secretMetadata, result, "main", executionId);
          if (authentication) this.addDeveloperLog({
            level: authentication.outcome === "authenticated" ? "success" : "warning",
            operation: "authentication_evidence", title: "主命令认证证据", summary: authentication.outcome,
            response: authentication, taskId, serverId: targetServerId
          });
          // Explicit consent applies to one attempt, not future retries.
          step.authenticationGate = undefined;
          if (monitorDecision?.decision === "adjust") {
            await rollbackShellStartup("长任务复核已停止当前命令");
          } else if (!result.success) {
            await rollbackShellStartup("主命令未成功完成");
          }
          if (startupRollbackAttempted) {
            safeOutput = `${safeOutput}\n--- Shell 启动文件事务回滚 ---\n${startupRollbackOutput || (startupRollbackSucceeded ? "rollback completed" : "rollback failed")}`;
          }
          step.output = safeOutput;
          appendCommandCompletion(this.terminalLines, safeOutput, Boolean(streamedOutput));
          const completionLines: string[] = [];
          appendCommandCompletion(completionLines, safeOutput, Boolean(streamedOutput));
          if (!streamedOutput && completionLines.length) {
            agentTerminals.completionOutput(task.id, executionId, `${completionLines.join("\n")}\n`);
          }
          this.addLog(buildCommandResultAudit({
            stepTitle: step.title,
            commandTemplate: prepared.commandTemplate,
            output: safeOutput,
            success: result.success,
            serverId: targetServerId,
            taskId,
          }));
          if (monitorDecision?.decision === "adjust") {
            const coordination = applyPeriodicReviewAdjustment(step, {
              review: monitorDecision,
              output: safeOutput,
              exitCode: result.exitCode,
              reviewRound: monitorRound,
              elapsedSeconds: step.elapsedSeconds,
              validationPassed: monitorValidationPassed,
              evidenceId: uid("evidence-long-review"),
              collectedAt: now(),
              scope: failureScope,
            });
            recordExecutionUncertainty(task, step, "长任务复核已停止当前变更，需先核对进程状态及已经产生的副作用。");
            holdFailureDependents(step, task.plan.filter(item => item.status === "pending"));
            if (step.result && startupTransaction) {
              step.result.facts.shellStartupSnapshot = startupTransaction.backupPaths.join(",");
              step.result.facts.shellStartupRollback = startupRollbackSucceeded ? "success" : "failed";
            }
            if (monitoringModelError && this.pauseStepModelServiceFailure(task, step, monitoringModelError)) return;
            await this.markExecutionReviewed(step);
            if (!lifetime.current()) return;
            transitionTask(task, coordination.taskStatus);
            task.pauseReason = coordination.pauseReason;
            this.pushMessage(task, {
              role: "assistant",
              kind: "event",
              content: coordination.eventMessage,
            });
            this.persist();
            lifetime.release();
            await this.routeAutomaticAdjustment(taskId);
            return;
          }
          if (!result.success) {
            if (result.exitCode === 130 || !lifetime.current()) return;
            const failure = applyCommandFailure(step, {
              output: safeOutput,
              exitCode: result.exitCode,
              evidenceId: uid("evidence-main"),
              collectedAt: now(),
              scope: failureScope,
            });
            if (authenticationChannelFailure(safeOutput)
              && (hasFixedPromptChannel || safeOutput.includes("PTY_AUTH_CHANNEL_UNAVAILABLE"))) {
              holdFailureDependents(step, task.plan.filter(item => item.status === "pending"));
              await this.archiveTaskStepEvidence(task, step);
              if (!lifetime.current()) return;
              transitionTask(task, "needs_adjustment");
              task.pauseReason = "AUTH_CHANNEL_UNAVAILABLE：认证终端不可用，执行结果已保留。请先修复并验证认证通道；不会重复执行，也不会再次索取同一份凭据。";
              task.autoAdjustmentSeconds = undefined;
              task.managedAdjustmentPhase = "manual_required";
              task.managedStopReason = "workflow_error";
              this.pushMessage(task, { role: "assistant", kind: "event", content: task.pauseReason });
              this.persist();
              return;
            }
            if ([124, 137].includes(result.exitCode ?? -1)) {
              recordExecutionUncertainty(task, step, "变更超时或被强制终止，需先核对是否仍有子进程及已产生的副作用。");
            }
            holdFailureDependents(step, task.plan.filter(item => item.status === "pending"));
            if (step.result && startupTransaction) {
              step.result.facts.shellStartupSnapshot = startupTransaction.backupPaths.join(",");
              step.result.facts.shellStartupRollback = startupRollbackSucceeded ? "success" : "failed";
            }
            if (monitoringModelError && this.pauseStepModelServiceFailure(task, step, monitoringModelError)) return;
            const model = this.models.find((item) => item.id === task.modelId);
            const apiKey = this.modelApiKeys[task.modelId];
            transitionTask(task, "validating");
            this.pushMessage(task, {
              role: "assistant",
              kind: "event",
              content: `${step.title}执行未成功，正在结合用户需求、完整计划和执行记录进行一次异常模型复核…`,
            });
            this.persist();
            const reviewPipeline = await runCommandFailureReviewPipeline({
              task,
              step,
              failureReason: failure.failure.reason,
              failureCategory: failure.failure.facts.category,
              model,
              apiKey,
              serverId: targetServerId,
              taskId,
              isCancelled: () => !lifetime.current(),
            });
            if (reviewPipeline.cancelled || !lifetime.current()) return;
            reviewPipeline.audits.forEach((event) => this.addLog(event));
            const coordination = reviewPipeline.coordination;
            await this.markExecutionReviewed(step);
            if (!lifetime.current()) return;
            transitionTask(task, coordination.taskStatus);
            task.pauseReason = coordination.pauseReason;
            this.pushMessage(task, {
              role: "assistant",
              kind: "event",
              content: coordination.eventMessage,
            });
            this.persist();
            if (!coordination.shouldAdvance) return;
            await wait(250);
            if (!lifetime.current()) return;
            lifetime.release();
            await this.advanceTask(taskId);
            return;
          }

          if (step.sessionContextChange && useAgentSandbox && agentSession) {
            const context = mergeAgentSessionContext(agentSession.context, step.sessionContextChange);
            agentSession = await backend.updateAgentSessionContext(agentSession, context);
            task.agentSessionGeneration = agentSession.generation;
            agentTerminals.registerSession(agentSession);
            agentTerminals.system(task.id, `AgentSessionContext 已更新（revision ${agentSession.context.revision}）`);
          }

          transitionStep(step, "validating");
          transitionTask(task, "validating");
          const commandResultOnly = step.kind === "observe";
          if (!commandResultOnly) executionPhase = "validation";
          step.progressMessage = commandResultOnly
            ? "主命令已完成，正在整理观察证据"
            : "主命令已完成，正在执行独立后置校验";
          this.pushMessage(task, {
            role: "system",
            kind: "event",
            content: commandResultOnly
              ? `${step.title}的主命令已完成，正在将返回结果整理为观察证据…`
              : `${step.title}的主命令已完成，正在执行独立后置校验…`,
          });
          this.persist();
          const validationLifecycle = commandResultOnly
            ? {
              validation: {
                passed: true,
                detail: "观察步骤使用主命令结果作为证据",
                output: undefined,
                exitCode: result.exitCode,
                emptyResult: result.emptyResult,
              },
              retried: false,
              firstFailedOutput: "",
              attemptCount: 0,
            }
            : await (async () => {
              return runValidationLifecycle({
                step,
                validation: prepared.resolvedValidation,
                initialExecutionId: uid("validation"),
                createRetryExecutionId: () => uid("validation-retry"),
                connection: prepared.connection,
                secretValues: serverSecretValues(this.secretValues, targetServerId),
                isCancelled: () => !lifetime.current(),
                onExecutionChange: (activeExecutionId) => {
                  if (lifetime.current()) task.currentExecutionId = activeExecutionId;
                },
                onProgress: (safeChunk) => {
                  if (!lifetime.current()) return;
                  appendTerminalStream(this.terminalLines, safeChunk);
                },
                onRetry: (firstValidationOutput, maxRetries) => {
                  step.output = appendFirstValidationFailureOutput(step.output, firstValidationOutput);
                  this.pushMessage(task, {
                    role: "system",
                    kind: "event",
                    content: `${step.title}的后置状态尚未稳定，将在有界窗口内自动复核最多 ${maxRetries} 次…`,
                  });
                  agentTerminals.system(task.id, "Agent 状态稳定复核");
                },
                onTransportRetry: useAgentSandbox ? async (attempt) => {
                  if (!lifetime.current()) return;
                  this.pushMessage(task, {
                    role: "system", kind: "event",
                    content: `后置校验 SSH 建连失败，正在重连并重试校验（${attempt}/2）；主命令结果已保留。`,
                  });
                  agentSession = await this.ensureTaskAgentSession(task.id);
                  if (!agentSession || agentSession.state !== "ready") {
                    throw new Error("终端执行通道异常：Agent 校验会话尚未就绪，停止自动重试");
                  }
                  step.attemptContext = taskAttemptContext(task);
                  this.persist();
                } : undefined,
              }, async input => this.recordStepExecution(task, step, "validation", input.executionId, () => lifetime.current(), async () => {
                if (useAgentSandbox && prepared.connection && agentSession) {
                  assertConnection();
                  let agentValidationStreamed = false;
                  agentTerminals.begin(
                    task.id,
                    input.executionId,
                    input.step.validation,
                    input.step.validationScope ?? "isolated_exec",
                    true,
                  );
                  const result = await backend.executeAgentCommand({
                    connection: prepared.connection!,
                    session: agentSession!,
                    executionId: input.executionId,
                    command: input.step.validation,
                    scope: input.step.validationScope ?? "isolated_exec",
                    approvedHighRisk: false,
                    promptCredential: validationPromptCredential,
                    onSessionInvalidated: invalidateAgentSession,
                    onProgress: (event) => {
                      if (!lifetime.current() || !event.data || (event.stream !== "stdout" && event.stream !== "stderr")) return;
                      const safeChunk = redactExecutionOutput(event.data, scopedSecrets, {
                        exactSecretKeys: input.exactSecretKeys,
                      });
                      if (!safeChunk) return;
                      agentValidationStreamed = true;
                      agentTerminals.output(task.id, input.executionId, safeChunk);
                      input.onProgress?.(safeChunk, {
                        executionId: input.executionId,
                        data: safeChunk,
                        stream: event.stream,
                      });
                    },
                  });
                  const safeValidationOutput = redactExecutionOutput(result.output, scopedSecrets, {
                    exactSecretKeys: input.exactSecretKeys,
                  });
                  if (!agentValidationStreamed && safeValidationOutput) {
                    agentTerminals.completionOutput(
                      task.id,
                      input.executionId,
                      `${safeValidationOutput}\n`,
                    );
                  }
                  agentTerminals.finish(task.id, input.executionId, result.exitCode);
                  return {
                    passed: result.success,
                    detail: result.success ? "后置校验通过" : `后置校验退出码 ${result.exitCode}`,
                    output: safeValidationOutput,
                    exitCode: result.exitCode,
                    emptyResult: result.emptyResult,
                  };
                }
                assertConnection(); return executeStepValidation(input);
              }, { effect: "read" }));
            })();
          if (!lifetime.current()) {
            await rollbackShellStartup("任务在验收期间已取消");
            return;
          }
          let validation = validationLifecycle.validation;
          if (step.validation && step.kind !== "observe") {
            const authentication = recordAuthentication(task, step, this.secretMetadata,
              { success: validation.passed, exitCode: validation.exitCode, output: validation.output ?? validation.detail }, "validation", `${executionId}:validation`);
            if (authentication) this.addDeveloperLog({
              level: authentication.outcome === "authenticated" ? "success" : "warning",
              operation: "authentication_evidence", title: "独立校验认证证据", summary: authentication.outcome,
              response: authentication, taskId, serverId: targetServerId
            });
          }
          if (!validation.passed && startupTransaction) {
            await rollbackShellStartup("新 Shell 验收未通过");
            validation = {
              ...validation,
              output: `${validation.output ?? ""}\n--- Shell 启动文件事务回滚 ---\n${startupRollbackOutput || (startupRollbackSucceeded ? "rollback completed" : "rollback failed")}`.trim(),
              detail: `${validation.detail}；自动回滚${startupRollbackSucceeded ? "已完成" : "失败"}`,
            };
          }
          const assembledValidation = assembleFinalValidationOutput(step.output, validation.output);
          step.output = assembledValidation.stepOutput;
          if (assembledValidation.validationOutput) {
            appendTerminalBlock(
              this.terminalLines,
              `验证 › ${step.validation}`,
              assembledValidation.validationOutput,
            );
          }
          const classified = classifyStepResult(
            step,
            { ...result, output: safeOutput },
            { ...validation, output: assembledValidation.validationOutput },
            {
              targetId: targetServerId,
              sessionId: task.agentSessionId,
              generation: task.agentSessionGeneration,
              shell: "bash",
            },
          );
          applyValidatedStepResult(step, classified);
          if (!classified.accepted || classified.result.facts.semanticAcceptanceRequired === true) {
            holdFailureDependents(step, task.plan.filter(item => item.status === "pending"));
          }
          if (step.result && startupTransaction) {
            step.result.facts.shellStartupSnapshot = startupTransaction.backupPaths.join(",");
            if (startupRollbackAttempted) {
              step.result.facts.shellStartupRollback = startupRollbackSucceeded ? "success" : "failed";
            }
          }
          this.addLog(buildValidationResultAudit({
            stepTitle: step.title,
            accepted: classified.accepted,
            verificationMode: commandResultOnly ? "command_result" : "postcondition",
            validator: step.validator,
            result: classified.result,
            validationTemplate: prepared.validationTemplate,
            validationOutput: assembledValidation.validationOutput,
            serverId: targetServerId,
            taskId,
          }));
          const postconditionReview = !classified.accepted
            && classified.result.executionStatus === "success";
          const reviewRequired = postconditionReview || classified.needsModelReview;
          if (monitoringModelError) {
            if (!reviewRequired) { transitionStep(step, "completed"); await this.markExecutionVerified(step); }
            if (!lifetime.current()) return;
            this.pauseStepModelServiceFailure(task, step, monitoringModelError);
            return;
          }
          const model = this.models.find((item) => item.id === task.modelId);
          const apiKey = this.modelApiKeys[task.modelId];
          if (reviewRequired) {
            this.pushMessage(task, {
              role: "assistant",
              kind: "event",
              content: postconditionReview
                ? `${step.title}的后置校验未通过，正在结合主命令输出进行一次异常模型复核…`
                : `${step.title}的证据需要解释，正在进行一次异常模型复核…`,
            });
            this.persist();
          }
          const reviewPipeline = await runEvidenceReviewPipeline({
            task,
            step,
            reviewRequired,
            postconditionReview,
            validationExitCode: validation.exitCode,
            model,
            apiKey,
            blockingFacts: classified.result.facts,
            serverId: targetServerId,
            taskId,
            isCancelled: () => !lifetime.current(),
          });
          if (reviewPipeline.cancelled || !lifetime.current()) return;
          reviewPipeline.audits.forEach((event) => this.addLog(event));
          const coordination = reviewPipeline.coordination;
          transitionTask(task, coordination.taskStatus);
          if (step.status === "completed") await this.markExecutionVerified(step);
          else await this.markExecutionReviewed(step);
          if (!lifetime.current()) return;
          task.pauseReason = coordination.pauseReason;
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: coordination.eventMessage,
          });
          this.persist();
          if (!coordination.shouldAdvance) return;
          await wait(250);
          if (!lifetime.current()) return;
          lifetime.release();
          await this.advanceTask(taskId);
        } catch (error) {
          if (error instanceof ExecutionLedgerError) {
            if (lifetime.current()) this.handleExecutionLedgerError(task, step, error);
            else await this.refreshExecutionLedger(taskId);
            return;
          }
          if (!lifetime.current()) return;
          if (this.pauseStepModelServiceFailure(task, step, error)) return;
          // An exception after submission may mean a command ran remotely.
          // Count that attempt once; only proven pre-dispatch failures are free.
          if (commandSubmitted && !isSshConnectionSetupFailure(error)) {
            this.recordAdjustmentExecution(task, step.id);
          }
          if (isConnectionTransportFailure(String(error))) this.reportConnectionFailure(targetServerId, String(error));
          if (step.status === "completed") {
            this.pauseWorkflowFailure(task, error);
            return;
          }
          if (useAgentSandbox && isTerminalTransportFailure(error)) invalidateAgentSession();
          if (rollbackShellStartupOnFailure) {
            await rollbackShellStartupOnFailure("执行或验收通道异常");
          }
          if (!lifetime.current()) return;
          if (executionPhase === "validation") {
            const failure = failValidationProtocol(step, error);
            holdFailureDependents(step, task.plan.filter(item => item.status === "pending"));
            if (monitoringModelError && this.pauseStepModelServiceFailure(task, step, monitoringModelError)) return;
            if (isTerminalTransportFailure(error)) {
              recordExecutionUncertainty(task, step, "主命令已执行但验收通道中断，需只读核对实际结果。");
              transitionStep(step, "failed");
              transitionTask(task, "needs_adjustment");
              task.pauseReason = failure.pauseReason;
              this.pushMessage(task, {
                role: "assistant",
                kind: "event",
                content: `${failure.pauseReason}。已转入终端通道恢复，不会让模型改写业务计划。`,
              });
              this.persist();
              lifetime.release();
              await this.routeAutomaticAdjustment(taskId, { transportRecovery: true });
              return;
            }
            const model = this.models.find((item) => item.id === task.modelId);
            const apiKey = this.modelApiKeys[task.modelId];
            transitionTask(task, "validating");
            task.pauseReason = failure.pauseReason;
            this.pushMessage(task, {
              role: "assistant",
              kind: "event",
              content: failure.eventMessage,
            });
            this.persist();
            try {
              const reviewPipeline = await runEvidenceReviewPipeline({
                task,
                step,
                reviewRequired: true,
                postconditionReview: true,
                model,
                apiKey,
                blockingFacts: step.result?.facts ?? {},
                serverId: targetServerId,
                taskId,
                isCancelled: () => !lifetime.current(),
              });
              if (reviewPipeline.cancelled || !lifetime.current()) return;
              reviewPipeline.audits.forEach((event) => this.addLog(event));
              const coordination = reviewPipeline.coordination;
              await this.markExecutionReviewed(step);
              if (!lifetime.current()) return;
              transitionTask(task, coordination.taskStatus);
              task.pauseReason = coordination.pauseReason;
              this.pushMessage(task, {
                role: "assistant",
                kind: "event",
                content: coordination.eventMessage,
              });
              this.persist();
            } catch (reviewError) {
              if (!lifetime.current()) return;
              if (this.pauseStepModelServiceFailure(task, step, reviewError)) return;
              const reviewFailure = applyStepExecutionException(step, reviewError);
              transitionTask(task, reviewFailure.taskStatus);
              task.pauseReason = `${failure.pauseReason}；模型异常复核暂不可用。`;
              this.pushMessage(task, {
                role: "assistant",
                kind: "event",
                content: `${failure.pauseReason}；模型异常复核暂不可用，任务已安全暂停。`,
              });
              this.persist();
            }
            return;
          }
          const failure = applyStepExecutionException(step, error);
          if (isTerminalTransportFailure(error) && step.result) {
            step.result.facts.category = "terminal_transport";
            if (isSshConnectionSetupFailure(error)) step.result.facts.commandDispatched = false;
            step.result.facts.terminalReleased = false;
            step.progressMessage = "终端执行通道待恢复";
          }
          if (commandSubmitted && !isSshConnectionSetupFailure(error)) {
            recordExecutionUncertainty(task, step, "已提交命令返回异常，执行结果未知，需核对实际副作用。");
          }
          transitionTask(task, failure.taskStatus);
          task.pauseReason = failure.pauseReason;
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: failure.eventMessage,
          });
          this.persist();
          if (step.result?.facts.category === "terminal_transport") {
            lifetime.release();
            await this.routeAutomaticAdjustment(taskId, { transportRecovery: true });
          }
        }
      } finally {
        lifetime.release();
        void this.refreshExecutionLedger(taskId);
      }
    },

    async provideUserInput(taskId: string, rawValues: Record<string, string>, expectedCallId?: string) {
      const request = this.pendingUserInputs.find((item) => item.taskId === taskId);
      const task = this.tasks.find((item) => item.id === taskId);
      if (task && taskRemovals.has(task)) return;
      const step = task?.plan.find((item) => item.id === request?.stepId);
      if (!request || !task || !step || task.cancelRequested || task.requirementProcessing
        || task.status !== "awaiting_input" || step.status !== "awaiting_input"
        || expectedCallId !== undefined && request.callId !== expectedCallId
        || request.roundId !== undefined && request.roundId !== task.currentRoundId
        || request.workflowEpoch !== undefined && request.workflowEpoch !== (task.workflowEpoch ?? 0)
        || request.command !== undefined && request.command !== stepOperationText(step)
        || request.serverId !== undefined && request.serverId !== executionServerId(task)) return false;
      const targetServerId = executionServerId(task);

      const missing = request.fields.find((field) => field.required && !String(rawValues[field.key] ?? "").trim());
      if (missing) {
        request.error = missing.type === "select"
          ? `请选择必填参数“${missing.label}”`
          : `请填写必填参数“${missing.label}”`;
        return false;
      }
      const invalidSelection = request.fields.find(field => field.type === "select"
        && String(rawValues[field.key] ?? "") !== ""
        && !field.options?.some(option => option.value === String(rawValues[field.key])));
      if (invalidSelection) {
        request.error = `参数“${invalidSelection.label}”必须选择当前候选项中的有效选项`;
        return false;
      }
      const invalidNumber = request.fields.find((field) => field.type === "number" && String(rawValues[field.key] ?? "").trim()
        && !Number.isFinite(Number(rawValues[field.key])));
      if (invalidNumber) {
        request.error = `参数“${invalidNumber.label}”必须是有效数字`;
        return false;
      }

      const lifetime = claimTaskOperation(submittingTaskInputs, task);
      if (!lifetime) return false;
      const currentRequest = () => lifetime.current() && task.status === "awaiting_input"
        && task.plan.find(item => item.id === step.id) === step && step.status === "awaiting_input"
        && this.pendingUserInputs.includes(request) && executionServerId(task) === targetServerId
        && (request.command === undefined || request.command === stepOperationText(step));
      const assertCurrentRequest = () => { if (!currentRequest()) throw new Error("用户确认请求已过期"); };
      const credentialWrite = request.fields.some(field => field.type === "password")
        ? reserveInputCredentialWrite(this) : undefined;
      try {
        if (credentialWrite) await credentialWrite.ready;
        if (!currentRequest()) return false;
        const values: Record<string, string | number> = {};
        const submittedInputs = { ...task.submittedInputs };
        const submittedSecretBindings = { ...task.submittedSecretBindings };
        const confirmedSecretKeys = [...(task.confirmedSecretKeys ?? [])];
        let credentialChanged = false;
        try {
          this.credentialError = "";
          const submittedAt = now();
          const handledCredentialFields = new Set<string>();
          const credentialPair = inferCredentialInputPair(request.title, request.fields);
          if (credentialPair) {
            const username = String(rawValues[credentialPair.usernameField.key] ?? "").trim();
            const secretValue = String(rawValues[credentialPair.secretField.key] ?? "");
            if (Boolean(username) !== Boolean(secretValue.trim())) {
              request.error = "用户名与密码/令牌必须作为同一凭据组完整提交";
              return false;
            }
            const usernameError = username
              ? credentialUsernameValidationError(credentialPair.kind, username)
              : undefined;
            if (usernameError) {
              request.error = usernameError;
              return false;
            }
            if (username && secretValue.trim()) {
              const serverMetadata = this.secretMetadata.filter((item) => item.serverId === targetServerId);
              const currentSecrets = serverSecretValues(this.secretValues, targetServerId);
              const existingGroup = findMatchingCredentialGroup(
                serverMetadata,
                currentSecrets,
                credentialPair,
                username,
              );
              const requestedSecretKey = normalizeCredentialStorageKey(credentialPair.secretField.key);
              const reusableLegacySecret = existingGroup ? undefined : serverMetadata.find((item) => (
                !item.credentialGroupId
                && item.key === requestedSecretKey
                && currentSecrets[item.key] === secretValue
              ));
              const allocated = existingGroup
                ? { usernameKey: existingGroup.username.key, secretKey: existingGroup.secret.key }
                : reusableLegacySecret
                  ? {
                    ...allocateCredentialPairKeys(
                      serverMetadata.filter((item) => item !== reusableLegacySecret),
                      credentialPair.usernameField.key,
                      `${credentialPair.secretField.key}_RESERVED`,
                    ),
                    secretKey: reusableLegacySecret.key,
                  }
                  : allocateCredentialPairKeys(
                    serverMetadata,
                    credentialPair.usernameField.key,
                    credentialPair.secretField.key,
                  );
              const groupId = existingGroup?.id ?? uid("credential");
              const writes = [
                { key: allocated.usernameKey, value: username, previous: currentSecrets[allocated.usernameKey] },
                { key: allocated.secretKey, value: secretValue, previous: currentSecrets[allocated.secretKey] },
              ].filter(({ value, previous }) => value !== previous);
              const applied: typeof writes = [];
              try {
                for (const write of writes) {
                  await backend.saveCredential("secret", secretValueId(targetServerId, write.key), write.value);
                  applied.push(write);
                  assertCurrentRequest();
                }
              } catch (error) {
                await Promise.allSettled(applied.map((write) => write.previous === undefined
                  ? backend.deleteCredential("secret", secretValueId(targetServerId, write.key))
                  : backend.saveCredential("secret", secretValueId(targetServerId, write.key), write.previous)));
                throw error;
              }

              const groupFields = [
                {
                  key: allocated.usernameKey,
                  field: credentialPair.usernameField,
                  role: "username" as const,
                  value: username,
                },
                {
                  key: allocated.secretKey,
                  field: credentialPair.secretField,
                  role: "secret" as const,
                  value: secretValue,
                },
              ];
              groupFields.forEach(({ key, field, role, value }) => {
                const metadata = this.secretMetadata.find((item) => item.key === key && item.serverId === targetServerId);
                const groupMetadata = {
                  credentialGroupId: groupId,
                  credentialKind: credentialPair.kind,
                  credentialRole: role,
                  credentialTarget: credentialPair.target,
                  credentialLabel: credentialPair.label,
                };
                if (metadata) Object.assign(metadata, { description: field.description, ...groupMetadata });
                else this.secretMetadata.push({
                  key,
                  description: field.description,
                  scope: "server",
                  serverId: targetServerId,
                  ...groupMetadata,
                });
                this.secretValues[secretValueId(targetServerId, key)] = value;
                if (!confirmedSecretKeys.includes(key)) confirmedSecretKeys.push(key);
                submittedSecretBindings[key] = {
                  key,
                  label: field.label,
                  description: field.description,
                  groupId,
                  groupTitle: credentialPair.label,
                  submittedAt,
                };
                values[field.key] = `已安全保存为 \${secret.${key}}`;
                handledCredentialFields.add(field.key);
              });
              delete submittedInputs[credentialPair.usernameField.key];
              if (writes.length) credentialChanged = true;
            }
          }
          for (const field of request.fields) {
            if (handledCredentialFields.has(field.key)) continue;
            const supplied = String(rawValues[field.key] ?? "");
            // Select values are identifiers, not display text; preserve exact identity.
            const raw = field.type === "password" || field.type === "select" ? supplied : supplied.trim();
            // An empty optional selection is an explicit omission for this form;
            // record it so an older value with the same key cannot be reused.
            if (!raw.trim() && field.type !== "select") {
              // A new non-secret answer supersedes the old answer, even when
              // intentionally omitted. Blank passwords do not revoke credentials.
              if (field.type !== "password") delete submittedInputs[field.key];
              continue;
            }
            if (field.type === "password") {
              const secretKey = field.key.toUpperCase();
              const valueId = secretValueId(targetServerId, secretKey);
              if (this.secretValues[valueId] !== raw) credentialChanged = true;
              // Commit to the encrypted vault before advertising the metadata in
              // memory/localStorage. A failed vault write must leave the input
              // card open instead of creating a phantom "saved" credential.
              const previous = this.secretValues[valueId];
              await backend.saveCredential("secret", valueId, raw);
              if (!currentRequest()) {
                await Promise.allSettled([previous === undefined
                  ? backend.deleteCredential("secret", valueId)
                  : backend.saveCredential("secret", valueId, previous)]);
                return false;
              }
              this.secretValues[valueId] = raw;
              const metadata = this.secretMetadata.find((item) => item.key === secretKey && item.serverId === targetServerId);
              if (!metadata) {
                this.secretMetadata.push({ key: secretKey, description: field.description, scope: "server", serverId: targetServerId });
              } else if (metadata.description !== field.description) {
                metadata.description = field.description;
              }
              if (!confirmedSecretKeys.includes(secretKey)) confirmedSecretKeys.push(secretKey);
              submittedSecretBindings[secretKey] = {
                key: secretKey,
                label: field.label,
                description: field.description,
                groupId: request.callId,
                groupTitle: request.title,
                submittedAt,
              };
              values[field.key] = `已安全保存为 \${secret.${secretKey}}`;
            } else {
              const value = field.type === "number" ? Number(raw) : raw;
              values[field.key] = value;
              submittedInputs[field.key] = {
                value,
                label: field.label,
                description: field.description,
                type: field.type,
                allowedValues: field.type === "select" ? field.options?.map(option => option.value) : undefined,
                groupId: request.callId,
                groupTitle: request.title,
                submittedAt,
                scope: confirmedInputScope(task, step.id),
              };
            }
          }
          assertCurrentRequest();
          task.submittedInputs = submittedInputs;
          task.submittedSecretBindings = submittedSecretBindings;
          task.confirmedSecretKeys = confirmedSecretKeys;
          if (credentialChanged) markTaskCredentialRevision(this.tasks, targetServerId, this.secretMetadata);
        } catch (error) {
          if (!currentRequest()) return false;
          this.credentialError = String(error);
          request.error = `保存输入失败：${this.credentialError}`;
          this.persist(true);
          return false;
        }

        // Persist metadata and non-sensitive companion inputs before advancing
        // the task. This closes the window where a refresh after submission left
        // a vault value with no visible row in Sensitive Information.
        this.persist(true);
        credentialWrite?.release();

        request.error = undefined;
        this.pendingUserInputs = this.pendingUserInputs.filter((item) => item !== request);
        transitionStep(step, "pending");
        const call: ToolCall = { id: request.callId, toolId: "user.request_input", arguments: {} };
        const lifecycle = await runToolStepLifecycle({
          step,
          call,
          execute: async () => ({ callId: call.id, toolId: call.toolId, success: true, data: { title: request.title, values } }),
          createEvidenceId: () => uid("evidence-user-input"),
          now,
          isCancelled: () => !lifetime.current(),
          onStart: () => {
            transitionTask(task, "running");
            this.pushMessage(task, {
              role: "user",
              kind: "event",
              content: `已提交参数：${request.fields.filter((field) => field.key in values).map((field) => field.label).join("、")}。`,
            });
          },
        });
        if (lifecycle.cancelled || !lifetime.current()) return false;
        transitionTask(task, lifecycle.taskStatus);
        task.pauseReason = lifecycle.pauseReason;
        task.managedAdjustmentPhase = undefined;
        task.managedStopReason = undefined;
        this.pushMessage(task, { role: "assistant", kind: "event", content: "用户输入已安全确认，正在基于这些参数继续任务。" });
        this.persist();
        lifetime.release();
        if (lifecycle.shouldAdvance) await this.advanceTask(taskId);
        if (task.permission === "managed" && ["needs_adjustment", "awaiting_continuation"].includes(task.status)) {
          void this.queueManagedAdjustment(task.id, 5);
        }
        return true;
      } finally {
        credentialWrite?.release();
        lifetime.release();
      }
    },

    async provideSecret(value: string) {
      const request = this.pendingSecret;
      if (!request || !value) return false;
      const task = this.tasks.find((item) => item.id === request.taskId);
      const step = task?.plan.find((item) => item.id === request.stepId);
      if (!task || !step || task.cancelRequested || task.requirementProcessing || task.status !== "awaiting_input" || step.status !== "awaiting_input"
        || request.roundId !== undefined && request.roundId !== task.currentRoundId
        || request.workflowEpoch !== undefined && request.workflowEpoch !== (task.workflowEpoch ?? 0)
        || request.serverId !== undefined && request.serverId !== executionServerId(task)
        || request.command !== undefined && request.command !== stepOperationText(step)) return false;
      const lifetime = claimTaskOperation(submittingTaskInputs, task);
      if (!lifetime) return false;
      const credentialWrite = reserveInputCredentialWrite(this);
      try {
        await credentialWrite.ready;
        const targetServerId = executionServerId(task);
        const currentRequest = () => lifetime.current() && this.pendingSecret === request
          && task.status === "awaiting_input" && step.status === "awaiting_input"
          && task.plan.includes(step) && executionServerId(task) === targetServerId
          && (request.command === undefined || request.command === stepOperationText(step));
        if (!currentRequest()) return false;
        const valueId = secretValueId(targetServerId, request.key);
        const previous = this.secretValues[valueId];
        const credentialChanged = this.secretValues[valueId] !== value;
        this.credentialError = "";
        request.error = undefined;
        try {
          // The encrypted vault is the source of truth. Do not expose metadata or an
          // in-memory value until durable storage has accepted the credential.
          await backend.saveCredential("secret", valueId, value);
        } catch (error) {
          if (!currentRequest()) return false;
          this.credentialError = String(error);
          request.error = `安全保存失败：${this.credentialError}`;
          this.persist(true);
          return false;
        }
        if (!currentRequest()) {
          await Promise.allSettled([previous === undefined
            ? backend.deleteCredential("secret", valueId)
            : backend.saveCredential("secret", valueId, previous)]);
          return false;
        }
        this.secretValues[valueId] = value;
        if (credentialChanged) markTaskCredentialRevision(this.tasks, targetServerId, this.secretMetadata);
        if (!this.secretMetadata.some((item) => item.key === request.key && item.serverId === targetServerId)) {
          this.secretMetadata.push({ key: request.key, description: request.description, scope: "server", serverId: targetServerId });
        }
        this.pendingSecret = null;
        task.confirmedSecretKeys ??= [];
        if (!task.confirmedSecretKeys.includes(request.key)) task.confirmedSecretKeys.push(request.key);
        resumeStepAfterSecret(step);
        transitionTask(task, "running");
        this.pushMessage(task, { role: "user", kind: "event", content: `已安全提供“${request.label}”，正在解锁并继续当前步骤。` });
        task.managedStopReason = undefined;
        task.managedAdjustmentPhase = undefined;
        this.persist();
        credentialWrite.release();
        lifetime.release();
        await this.runStep(request.taskId, request.stepId);
        if (task.permission === "managed" && ["needs_adjustment", "awaiting_continuation"].includes(task.status)) {
          void this.queueManagedAdjustment(task.id, 5);
        }
        return true;
      } finally {
        credentialWrite.release();
        lifetime.release();
      }
    },

    addSecretMetadata(key: string, description: string, value: string, serverId: string) {
      const normalized = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!normalized || !serverId || this.secretMetadata.some((item) => item.key === normalized && item.serverId === serverId)) return;
      this.secretMetadata.push({ key: normalized, description: description.trim() || "敏感变量", scope: "server", serverId });
      if (value) this.secretValues[secretValueId(serverId, normalized)] = value;
      markTaskCredentialRevision(this.tasks, serverId, this.secretMetadata);
      this.persist();
    },

    async renameSecretMetadata(oldKey: string, nextKey: string, serverId: string) {
      const normalized = nextKey.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!normalized || normalized === oldKey) return normalized === oldKey;
      if (this.secretMetadata.some((item) => item.key === normalized && item.serverId === serverId)) return false;
      const secret = this.secretMetadata.find((item) => item.key === oldKey && item.serverId === serverId);
      if (!secret) return false;
      const oldId = secretValueId(serverId, oldKey);
      const nextId = secretValueId(serverId, normalized);
      const value = this.secretValues[oldId] ?? "";
      if (value) await backend.saveCredential("secret", nextId, value);
      await backend.deleteCredential("secret", oldId);
      secret.key = normalized;
      if (value) this.secretValues[nextId] = value;
      delete this.secretValues[oldId];
      markTaskCredentialRevision(this.tasks, serverId, this.secretMetadata);
      this.persist(true);
      return true;
    },

    async removeSecretMetadata(key: string, serverId: string) {
      const selected = this.secretMetadata.find((item) => item.key === key && item.serverId === serverId);
      const removed = selected?.credentialGroupId
        ? this.secretMetadata.filter((item) => item.serverId === serverId
          && item.credentialGroupId === selected.credentialGroupId)
        : selected ? [selected] : [];
      await Promise.all(removed.map((item) => backend.deleteCredential("secret", secretValueId(serverId, item.key))));
      const removedKeys = new Set(removed.map((item) => item.key));
      this.secretMetadata = this.secretMetadata.filter((item) => item.serverId !== serverId || !removedKeys.has(item.key));
      removedKeys.forEach((removedKey) => delete this.secretValues[secretValueId(serverId, removedKey)]);
      markTaskCredentialRevision(this.tasks, serverId, this.secretMetadata);
      this.persist(true);
    },

    async saveSecretSettings() {
      await this.hydrateCredentials();
      if (!this.credentialsHydrated) {
        throw new Error(this.credentialError || "加密凭据尚未完整加载，已取消保存以避免误删已有凭据数据");
      }
      const invalidUsername = this.secretMetadata.find((secret) => secret.credentialRole === "username"
        && secret.credentialKind
        && credentialUsernameValidationError(
          secret.credentialKind,
          this.secretValues[secretValueId(secret.serverId, secret.key)] ?? "",
        ));
      if (invalidUsername?.credentialKind) {
        const reason = credentialUsernameValidationError(
          invalidUsername.credentialKind,
          this.secretValues[secretValueId(invalidUsername.serverId, invalidUsername.key)] ?? "",
        );
        this.credentialError = `${invalidUsername.credentialLabel || invalidUsername.key}：${reason}`;
        throw new Error(this.credentialError);
      }
      await Promise.all(this.secretMetadata.map((secret) => {
        const id = secretValueId(secret.serverId, secret.key);
        const value = this.secretValues[id] ?? "";
        return value
          ? backend.saveCredential("secret", id, value)
          : backend.deleteCredential("secret", id);
      }));
      [...new Set(this.secretMetadata.map((secret) => secret.serverId))]
        .forEach((serverId) => markTaskCredentialRevision(this.tasks, serverId, this.secretMetadata));
      this.persist(true);
    },

    getServerSecretValues(serverId: string) {
      return serverSecretValues(this.secretValues, serverId);
    },

    setServerSecretValue(serverId: string, key: string, value: string) {
      this.secretValues[secretValueId(serverId, key)] = value;
    },

    addModel() {
      const model: ModelProfile = {
        id: uid("model"),
        name: "新模型",
        provider: "",
        model: "",
        endpoint: "",
        enabled: true,
        hasApiKey: false,
        timeoutSeconds: 90,
      };
      this.models.push(model);
      this.modelAvailability[model.id] = { status: "unknown", reason: "请完成配置后保存" };
      this.persist(true);
      return this.models[this.models.length - 1];
    },

    async removeModel(modelId: string) {
      await backend.deleteCredential("model", modelId);
      this.models = this.models.filter((model) => model.id !== modelId);
      delete this.modelApiKeys[modelId];
      delete this.modelAvailability[modelId];
      this.tasks.forEach((task) => {
        if (task.modelId === modelId) task.modelId = this.availableModels[0]?.id ?? "";
      });
      this.persist(true);
    },

    async runTerminalCommand(command: string, serverId?: string) {
      if (!command.trim()) return;
      const connection = serverId ? this.getRuntimeConnection(serverId) : undefined;
      if (serverId && !connection) throw new Error("SSH 未连接，请先重连后再执行命令");
      const activeServer = this.servers.find((item) => item.id === serverId);
      const prompt = activeServer ? `${activeServer.username}@${activeServer.host}:~$` : "local:~$";
      appendTerminalBlock(this.terminalLines, `${prompt} ${command}`);
      const result = await backend.executeCommand(command, connection);
      const terminalOutput = result.output.split("\n");
      if (terminalOutput[0]?.startsWith("$ ")) terminalOutput.shift();
      appendTerminalBlock(this.terminalLines, "", terminalOutput.join("\n"));
      this.addLog({
        category: "command",
        level: result.success ? "success" : "error",
        title: "手动终端命令",
        detail: `${command}\n${result.output}`,
        serverId,
      });
    },

    async saveModelProfile(model: ModelProfile, apiKey: string) {
      if (model.source === "official" || this.models.some(item => item.id === model.id && item.source === "official")) throw new Error("官方连接由账号服务管理");
      validateModelConfiguration(model);
      // Persist the credential first; a failed vault write must not commit the draft.
      if (apiKey) await backend.saveCredential("model", model.id, apiKey);
      else await backend.deleteCredential("model", model.id);
      const saved = { ...model, hasApiKey: Boolean(apiKey) };
      const index = this.models.findIndex(item => item.id === model.id);
      if (index < 0) this.models.push(saved); else this.models[index] = saved;
      this.modelApiKeys[model.id] = apiKey;
      this.modelAvailability[model.id] = { status: "unknown", reason: "配置已保存，尚未测试", checkedAt: now() };
      this.persist(true);
    },

    async saveModels() {
      for (const model of this.models) {
        validateModelConfiguration(model);
      }
      this.aiGenerationSettings = normalizeAiGenerationSettings(this.aiGenerationSettings);
      this.models = this.models.filter((model) => model.provider !== "Built-in" && model.id !== "model-local");
      const credentials = this.models.filter(model => model.source !== "official").map(async (model) => {
        const apiKey = this.modelApiKeys[model.id] ?? "";
        if (apiKey) await backend.saveCredential("model", model.id, apiKey);
        else await backend.deleteCredential("model", model.id);
        model.hasApiKey = Boolean(apiKey);
      });
      try {
        await Promise.all(credentials);
        this.credentialError = "";
      } catch (error) {
        this.credentialError = String(error);
        throw error;
      } finally {
        this.persist(true);
      }
      // Saving settings never performs a paid generation request.
    },

    async refreshModelAvailability() {
      await this.hydrateCredentials();
      await Promise.all(this.models.map(async (model) => {
        // Official availability includes account/credit state and is refreshed by the account store.
        if (model.source === "official") return;
        if (!model.enabled) {
          this.modelAvailability[model.id] = { status: "unavailable", reason: "模型已停用", checkedAt: now() };
          return;
        }
        const apiKey = this.modelApiKeys[model.id] ?? "";
        if (!apiKey) {
          this.modelAvailability[model.id] = { status: "unavailable", reason: "未配置 API Key", checkedAt: now() };
          return;
        }
        if (!model.endpoint.trim() || !model.model.trim()) {
          this.modelAvailability[model.id] = {
            status: "unavailable",
            reason: !model.endpoint.trim() ? "未配置接口地址" : "未配置模型名称",
            checkedAt: now(),
          };
          return;
        }
        this.modelAvailability[model.id] = { status: "checking", reason: "正在检查模型服务…" };
        try {
          const result = await backend.checkModel({
            apiKey,
            endpoint: model.endpoint,
            model: model.model,
            // Background availability only uses the model-list endpoint. Explicit
            // parameter/JSON generation tests live in the model editor.
            timeoutSeconds: model.timeoutSeconds,
          });
          this.modelAvailability[model.id] = {
            status: result.available ? "available" : "unavailable",
            reason: result.reason,
            checkedAt: now(),
          };
        } catch (error) {
          this.modelAvailability[model.id] = {
            status: "unavailable",
            reason: String(error),
            checkedAt: now(),
          };
        }
      }));
    },
  },
});
