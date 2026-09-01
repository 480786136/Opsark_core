import { defineStore } from "pinia";
import { backend, buildExecutionSummary, isTauri, ModelInvocationError, normalizePlanPreconditions } from "@/services/backend";
import {
  classifyStepResult,
  ensureStepValidator,
  isMutatingStepCommand,
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
} from "@/features/tools/toolExecutor";
import {
  buildAgentContext,
  extractKnownExecutionFacts,
  trimEvidence,
} from "@/features/agent/agentContext";
import { normalizePermissionLevel, requiresStepApproval } from "@/features/agent/approvalPolicy";
import { transitionTask } from "@/features/agent/taskMachine";
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
  prependDeveloperLog,
  type DeveloperLogDraft,
} from "@/features/agent/developerLog";
import {
  buildPeriodicReviewAudit,
} from "@/features/agent/reviewAudit";
import {
  findUnresolvedBlockingStep,
  latestTaskRequirement,
  resolveTaskProgression,
} from "@/features/agent/taskProgression";
import {
  activeRoundSteps,
  archiveActivePhase,
  capturePreviousRound,
  captureWorkflowState,
  commitPreviousRound,
  mergeTaskSkillIds,
  normalizeRequirementRelation,
  restoreWorkflowState,
  taskGoal,
} from "@/features/agent/taskGoal";
import { isPlanProgressMessage } from "@/features/agent/taskMessages";
import {
  planTaskAdjustment,
  reviewTaskGoal,
  summarizeFailedTask,
} from "@/features/agent/agentService";
import {
  runDiscoveryRefinement,
  runTaskCompletion,
} from "@/features/agent/taskAdvancement";
import {
  runCommandFailureReviewPipeline,
  runEvidenceReviewPipeline,
  runPreconditionReviewPipeline,
} from "@/features/agent/stepReviewPipeline";
import {
  acceptStepApproval,
  hasCurrentStepApproval,
  requestStepApproval,
} from "@/features/agent/stepApproval";
import {
  runCommandLifecycle,
  runValidationLifecycle,
} from "@/features/agent/executionLifecycle";
import { prepareStepExecution } from "@/features/agent/executionPreparation";
import { executeStepCommand } from "@/features/agent/executionRunner";
import { buildShellStartupTransaction } from "@/features/agent/shellStartupConfig";
import { redactExecutionOutput } from "@/features/agent/secretTool";
import { findSecretKeys } from "@/features/agent/secretTool";
import { secretPurposeMismatch } from "@/features/agent/secretPurpose";
import { buildSecretUnlockRequest } from "@/features/agent/secretUnlockPrompt";
import {
  buildAdjustmentBlockerSnapshot,
  isSameAdjustmentIncident,
  isTerminalTransportFailure,
  openAdjustmentIncident,
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
  createSkillConfiguration,
  buildSkillContext,
  normalizeSkillRegistry,
  parseSkillConfiguration,
  resetSkillDefinition,
  resolveSkillRegistry,
  resolveTaskSkills,
} from "@/features/skills/skillRegistry";
import { validateSkillDefinition } from "@/features/skills/skillValidation";


const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const executionServerId = (task: Pick<OpsTask, "serverId" | "executionTargetServerId">) => (
  task.executionTargetServerId ?? task.serverId
);
let persistTimer: number | undefined;
let credentialHydration: Promise<void> | undefined;
const adjustingTaskIds = new Set<string>();
const managedAdjustmentSchedulers = new Map<string, { requested: boolean }>();
const recoveringAdjustmentTaskIds = new Set<string>();
const resumingTransportTaskIds = new Set<string>();
const secretValueId = (serverId: string, key: string) => `${serverId}::${key}`;

function serverSecretValues(values: Record<string, string>, serverId: string) {
  const prefix = `${serverId}::`;
  return Object.fromEntries(
    Object.entries(values)
      .filter(([id]) => id.startsWith(prefix))
      .map(([id, value]) => [id.slice(prefix.length), value]),
  );
}

function markTaskCredentialRevision(tasks: OpsTask[], serverId: string) {
  tasks
    .filter((task) => executionServerId(task) === serverId)
    .forEach((task) => {
      task.credentialRevision = (task.credentialRevision ?? 0) + 1;
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
    && (input.type === "text" || input.type === "number")
    && (typeof input.value === "string" || typeof input.value === "number")
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

function applySafetyNormalization(step: PlanStep, command: string, validation: string) {
  const changed = step.command !== command || step.validation !== validation;
  const normalized = ensureStepValidator({
    ...step,
    command,
    validation,
    validator: step.validator ? { ...step.validator, command: validation } : undefined,
    safetyApprovalSnapshot: changed ? undefined : step.safetyApprovalSnapshot,
    approvedSafetySnapshot: changed ? undefined : step.approvedSafetySnapshot,
  });
  Object.assign(step, normalized);
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
  maxOutputTokens: 5000,
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
    maxOutputTokens: positiveInteger(settings.maxOutputTokens, defaultAiGenerationSettings.maxOutputTokens, 256),
    maxTextChars: positiveInteger(settings.maxTextChars, defaultAiGenerationSettings.maxTextChars),
    maxCommandChars: positiveInteger(settings.maxCommandChars, defaultAiGenerationSettings.maxCommandChars),
  };
}

function initialAiGenerationSettings() {
  return normalizeAiGenerationSettings(
    readSaved<Partial<AiGenerationSettings>>("opsark.aiGenerationSettings", {}),
  );
}

function initialTools() {
  return resolveToolRegistry(parseToolOverrides(readSaved<unknown>("opsark.toolOverrides", [])));
}

function initialSkills() {
  return resolveSkillRegistry(parseSkillConfiguration(readSaved<unknown>("opsark.skillConfiguration", {})));
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

function initialModels() {
  const saved = readSaved<ModelProfile[]>("opsark.models", defaultModels)
    .filter((model) => model.provider !== "Built-in" && model.id !== "model-local")
    .filter((model) => !(
      model.id === "model-deepseek"
      && model.name === "DeepSeek V4 Flash"
      && model.model === "deepseek-v4-flash"
      && model.hasApiKey !== true
    ));
  return saved.length ? saved : defaultModels.map((model) => ({ ...model }));
}

function initialSecretMetadata() {
  const serverIds = new Set(initialServers().map(({ id }) => id));
  return readSaved<SecretMetadata[]>("opsark.secretMetadata", [])
    .filter((secret) => secret.scope !== "server" || Boolean(secret.serverId && serverIds.has(secret.serverId)));
}

function migrateFinishedSideQuestionDisplay(task: OpsTask) {
  if (
    task.lastRequirementRelation !== "side_question"
    || !["completed", "failed", "cancelled"].includes(task.status)
    || !task.plan.length
  ) return;
  const userMessages = task.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user" && message.kind === "message");
  if (userMessages.length < 2) return;
  const latest = userMessages[userMessages.length - 1];
  const previous = userMessages[userMessages.length - 2];
  const alreadyArchived = task.planHistory?.some((round) => round.createdAt === previous.message.createdAt);
  if (!alreadyArchived) {
    task.planHistory ??= [];
    task.planHistory.push({
      id: `round-history-${task.id}-side-question-migration`,
      requirement: previous.message.content,
      status: task.status,
      plan: activeRoundSteps(task).map((step) => structuredClone(step)),
      finalPlan: task.plan.map((step) => structuredClone(step)),
      phases: (task.phaseHistory ?? [])
        .filter((phase) => phase.roundId === task.currentRoundId)
        .map((phase) => structuredClone(phase)),
      response: task.messages
        .slice(previous.index + 1, latest.index)
        .find((message) => message.role === "assistant" && message.kind === "message"),
      records: task.messages
        .slice(previous.index + 1, latest.index)
        .filter((message) => message.kind === "event")
        .map((message) => ({ ...message })),
      summary: task.summary,
      pauseReason: task.pauseReason,
      executionConstraints: task.executionConstraints,
      createdAt: previous.message.createdAt,
      completedAt: latest.message.createdAt,
    });
  }
  if (task.currentRoundId) {
    task.phaseHistory = (task.phaseHistory ?? []).filter((phase) => phase.roundId !== task.currentRoundId);
  }
  task.plan = [];
  task.summary = undefined;
  task.pauseReason = undefined;
  task.executionConstraints = undefined;
  task.currentInstruction = latest.message.content;
  task.currentRoundId = uid("round");
}

function initialTasks() {
  return readSaved<OpsTask[]>("opsark.tasks", []).map((task) => {
    task.permission = normalizePermissionLevel(task.permission);
    task.adjustmentInProgress = false;
    task.confirmedSecretKeys = [];
    task.submittedInputs = normalizeSubmittedInputs(task.submittedInputs);
    task.submittedSecretBindings = normalizeSubmittedSecretBindings(task.submittedSecretBindings);
    task.plan = task.plan.map(ensureStepValidator);
    task.phaseHistory ??= [];
    task.phaseHistory.forEach((phase) => {
      phase.plan = phase.plan.map(ensureStepValidator);
    });
    task.planHistory?.forEach((round) => {
      round.plan = round.plan.map(ensureStepValidator);
      round.finalPlan = round.finalPlan?.map(ensureStepValidator);
      round.phases?.forEach((phase) => {
        phase.plan = phase.plan.map(ensureStepValidator);
      });
      if (round.status === "needs_adjustment" && round.summary) {
        round.pauseReason = round.summary;
        round.summary = undefined;
      }
    });
    if (task.status === "needs_adjustment" && task.summary) {
      task.pauseReason = task.summary;
      task.summary = undefined;
    }
    const latestRequirement = latestTaskRequirement(task);
    task.rootGoal ||= latestRequirement;
    task.currentInstruction ||= [...task.messages]
      .reverse()
      .find((message) => message.role === "user" && message.kind === "message")?.content
      ?? task.rootGoal;
    task.currentRoundId ||= uid("round");
    migrateFinishedSideQuestionDisplay(task);
    if (task.status === "completed" && /^本轮处理完成，共执行/.test(task.summary ?? "")) {
      task.summary = buildExecutionSummary(latestRequirement, task.plan);
    }
    task.planHistory?.forEach((round) => {
      if (round.status === "completed" && /^本轮处理完成，共执行/.test(round.summary ?? "")) {
        round.summary = buildExecutionSummary(round.requirement, round.plan);
      }
    });
    return task;
  });
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
      records: round.records?.slice(-(aggressive ? 40 : 120)),
    })),
  }));
}

export const useOpsStore = defineStore("ops", {
  state: () => ({
    servers: initialServers(),
    tasks: initialTasks(),
    models: initialModels(),
    aiGenerationSettings: initialAiGenerationSettings(),
    tools: initialTools(),
    toolSaveError: "",
    skills: initialSkills(),
    skillSaveError: "",
    modelAvailability: {} as Record<string, ModelAvailability>,
    logs: initialLogs(),
    developerLogs: initialDeveloperLogs(),
    metrics: {
      cpu: 0,
      memory: 0,
      disk: 0,
      networkIn: 0,
      networkOut: 0,
      sampledAt: "",
    } as Metrics,
    activeTaskId: null as string | null,
    serverPasswords: {} as Record<string, string>,
    modelApiKeys: {} as Record<string, string>,
    connectedServerIds: [] as string[],
    secretMetadata: initialSecretMetadata(),
    secretValues: {} as Record<string, string>,
    pendingSecret: null as PendingSecretRequest | null,
    pendingUserInputs: [] as PendingUserInput[],
    terminalLines: [] as string[],
    isCollecting: false,
    metricsLoading: false,
    credentialsHydrated: false,
    credentialsLoading: false,
    credentialError: "",
    persistenceWarning: "",
  }),

  getters: {
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
    persist(immediate = false) {
      if (persistTimer !== undefined) window.clearTimeout(persistTimer);
      const store = this;
      const write = () => {
        try {
          localStorage.setItem("opsark.tasks", JSON.stringify(compactPersistedTasks(store.tasks)));
          localStorage.setItem("opsark.logs", JSON.stringify(store.logs.slice(0, 300)));
          localStorage.setItem("opsark.developerLogs", JSON.stringify(store.developerLogs.slice(0, 30)));
          localStorage.setItem("opsark.servers", JSON.stringify(store.servers));
          localStorage.setItem("opsark.models", JSON.stringify(store.models));
          localStorage.setItem("opsark.aiGenerationSettings", JSON.stringify(store.aiGenerationSettings));
          localStorage.setItem("opsark.toolOverrides", JSON.stringify(createToolOverrides(store.tools)));
          localStorage.setItem("opsark.skillConfiguration", JSON.stringify(createSkillConfiguration(store.skills)));
          localStorage.setItem("opsark.secretMetadata", JSON.stringify(store.secretMetadata));
          store.persistenceWarning = "";
        } catch (error) {
          // 本地记录空间不足不能改变远程命令结果；降级保存精简快照并继续任务。
          store.persistenceWarning = `任务记录空间不足，已自动压缩历史：${String(error)}`;
          try {
            localStorage.setItem("opsark.tasks", JSON.stringify(compactPersistedTasks(store.tasks, true)));
            localStorage.setItem("opsark.logs", JSON.stringify(store.logs.slice(0, 80)));
            localStorage.setItem("opsark.developerLogs", JSON.stringify(compactDeveloperLogs(store.developerLogs)));
          } catch {
            // 极端情况下保留内存态，禁止把持久化失败误报为执行失败。
          }
        }
        persistTimer = undefined;
      };
      if (immediate) write();
      else persistTimer = window.setTimeout(write, 200);
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
      this.skills.push(skill);
      this.skillSaveError = "";
      return skill;
    },

    removeSkill(skillId: string) {
      const skill = this.skills.find((item) => item.id === skillId);
      if (!skill || skill.builtIn) return false;
      this.skills = this.skills.filter((item) => item.id !== skillId);
      this.skillSaveError = "";
      this.persist(true);
      return true;
    },

    saveSkills() {
      this.skillSaveError = "";
      const normalized = normalizeSkillRegistry(this.skills);
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
            .filter((model) => model.provider !== "Built-in")
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
          // particular, an empty in-memory value after a failed keychain read
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
      if (this.connectedServerIds.includes(serverId)) return true;
      const password = this.serverPasswords[serverId];
      if (!password) return false;
      await this.connectServer(serverId, password, false);
      return this.connectedServerIds.includes(serverId);
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
      this.persist();
    },

    async refreshServer(serverId: string) {
      const server = this.servers.find((item) => item.id === serverId);
      if (!server) return;
      this.isCollecting = true;
      server.status = "testing";
      try {
        const password = this.serverPasswords[serverId];
        if (password) {
          const probe = await backend.probeSsh({
            host: server.host,
            port: server.port,
            username: server.username,
            password,
          });
          server.info = probe.info;
          server.environment = probe.environment;
          if (!this.connectedServerIds.includes(serverId)) this.connectedServerIds.push(serverId);
          server.status = "online";
          const connection = { host: server.host, port: server.port, username: server.username, password };
          void Promise.allSettled([
            useFileWorkspaceStore().loadDirectory(serverId, connection, "/"),
            this.refreshMetrics(serverId),
          ]);
        } else {
          throw new Error("未找到该服务器的 SSH 凭据，请重新连接");
        }
        this.addLog({
          category: "system",
          level: "success",
          title: "服务器信息已刷新",
          detail: `${server.name} 连接测试成功，基础信息采集完成`,
          serverId,
        });
      } catch (error) {
        server.status = "offline";
        this.addLog({
          category: "system",
          level: "error",
          title: "服务器连接失败",
          detail: String(error),
          serverId,
        });
      } finally {
        this.isCollecting = false;
        this.persist();
      }
    },

    async connectServer(serverId: string, password: string, remember = true) {
      const credentialChanged = this.serverPasswords[serverId] !== password;
      this.serverPasswords[serverId] = password;
      if (credentialChanged) markTaskCredentialRevision(this.tasks, serverId);
      await this.refreshServer(serverId);
      if (this.connectedServerIds.includes(serverId)) {
        if (remember) {
          try {
            await backend.saveCredential("server", serverId, password);
          } catch (error) {
            this.credentialError = String(error);
          }
        }
      } else {
        delete this.serverPasswords[serverId];
      }
    },

    disconnectServer(serverId: string) {
      const hadCredential = Boolean(this.serverPasswords[serverId]);
      delete this.serverPasswords[serverId];
      if (hadCredential) markTaskCredentialRevision(this.tasks, serverId);
      this.connectedServerIds = this.connectedServerIds.filter((id) => id !== serverId);
      const server = this.servers.find((item) => item.id === serverId);
      if (server) server.status = "offline";
    },

    async refreshMetrics(serverId?: string) {
      if (this.metricsLoading) return;
      this.metricsLoading = true;
      try {
        const server = this.servers.find((item) => item.id === serverId);
        const password = serverId ? this.serverPasswords[serverId] : undefined;
        this.metrics = server && password
          ? await backend.getSshMetrics({ host: server.host, port: server.port, username: server.username, password })
          : await backend.getMetrics();
      } catch {
        // Keep the last valid sample when a remote collection fails.
      } finally {
        this.metricsLoading = false;
      }
    },

    async executeToolCall(
      serverId: string,
      call: ToolCall,
      onProgress?: (message: string) => void,
      _legacyPaneId?: string,
      taskId?: string,
    ) {
      const connection = this.getRuntimeConnection(serverId);
      if (!connection) throw new Error("请先连接真实服务器");
      const startedAt = performance.now();
      const result = await executeRegisteredToolCall(call, this.tools, {
        resolveServerConnection: async (
          request: ServerConnectionLookupRequest,
        ): Promise<ServerConnectionLookupResult> => {
          const port = request.port ?? 22;
          const target = this.servers.find((server) => server.host === request.host && server.port === port);
          const scopedSecrets = serverSecretValues(this.secretValues, serverId);
          const reusableGroups = collectServerCredentialGroups(this.secretMetadata, serverId)
            .filter((group) => group.kind === "ssh-password"
              && group.target?.toLocaleLowerCase() === request.host.toLocaleLowerCase()
              && Boolean(scopedSecrets[group.username.key])
              && Boolean(scopedSecrets[group.secret.key]));
          const reusableGroup = reusableGroups.length === 1 ? reusableGroups[0] : undefined;
          const managedCredentialAvailable = Boolean(target && this.serverPasswords[target.id]);
          const credentialAvailable = managedCredentialAvailable || Boolean(reusableGroup);
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
          const port = request.port ?? 22;
          let username = request.username;
          let password: string | undefined;
          let usernamePlaceholder: string | undefined;
          if (request.credentialRef?.startsWith("managed-server:")) {
            const targetId = request.credentialRef.slice("managed-server:".length);
            const managedTarget = this.servers.find((server) => server.id === targetId);
            if (!managedTarget || managedTarget.host !== request.host || managedTarget.port !== port) {
              throw new Error("credentialRef 与目标服务器不匹配，请重新查询连接资料");
            }
            username = managedTarget.username;
            password = this.serverPasswords[managedTarget.id];
          } else if (request.credentialRef?.startsWith("server-credential:")) {
            const credentialGroupId = request.credentialRef.slice("server-credential:".length);
            const credentialGroup = collectServerCredentialGroups(this.secretMetadata, serverId)
              .find((group) => group.id === credentialGroupId);
            if (!credentialGroup
              || credentialGroup.kind !== "ssh-password"
              || credentialGroup.target?.toLocaleLowerCase() !== request.host.toLocaleLowerCase()) {
              throw new Error("credentialRef 与目标服务器不匹配，请重新查询连接资料");
            }
            const scopedSecrets = serverSecretValues(this.secretValues, serverId);
            const groupedUsername = scopedSecrets[credentialGroup.username.key];
            if (request.username && request.username !== groupedUsername) {
              throw new Error("用户名与 credentialRef 对应的服务器凭据组不匹配");
            }
            username = groupedUsername;
            password = scopedSecrets[credentialGroup.secret.key];
            usernamePlaceholder = `\${secret.${credentialGroup.username.key}}`;
          } else if (request.passwordSecretKey) {
            password = serverSecretValues(this.secretValues, serverId)[request.passwordSecretKey];
          }
          if (!username) throw new Error("缺少目标服务器 SSH 用户名，请先查询连接资料或向用户收集");
          if (credentialUsernameValidationError("ssh-password", username)) {
            throw new Error("SSH 凭据组中的用户名格式不安全，请在敏感信息管理中修正");
          }
          if (!password) throw new Error("缺少目标服务器 SSH 密码，请先查询连接资料或通过用户输入工具安全收集");
          if (isTauri()) {
            await backend.probeSsh({ host: request.host, port, username, password });
          }
          let target = this.servers.find((server) => server.host === request.host && server.port === port);
          if (target) {
            target.username = username;
            if (request.name) target.name = request.name;
            if (request.group) target.group = request.group;
          } else {
            target = this.addServer({
              name: request.name ?? request.host,
              host: request.host,
              port,
              username,
              group: request.group ?? "智能连接",
            });
          }
          this.serverPasswords[target.id] = password;
          if (!this.connectedServerIds.includes(target.id)) this.connectedServerIds.push(target.id);
          target.status = "online";
          const task = taskId ? this.tasks.find((candidate) => candidate.id === taskId) : undefined;
          if (task) {
            task.executionTargetServerId = target.id;
            await this.ensureTaskAgentSession(task.id);
          }
          try {
            await backend.saveCredential("server", target.id, password);
          } catch (error) {
            this.credentialError = String(error);
          }
          this.persist(true);
          return {
            serverId: target.id,
            name: target.name,
            host: target.host,
            port: target.port,
            username: usernamePlaceholder ?? target.username,
            connected: true,
            info: { agentTarget: true, credentialRef: request.credentialRef },
          };
        },
        getRemoteFileStructure: (request) => backend.getRemoteFileStructure(connection, request),
        readRemoteFileContent: async (request: FileContentRequest): Promise<FileContentResult> => {
          const maxBytes = request.maxBytes ?? 65_536;
          const file = await backend.readSftpFilePrefix(connection, request.path, maxBytes);
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
        checkSoftware: async (request) => {
          const command = buildSoftwareCheckCommand(request);
          const result = await backend.executeCommand(command, connection, false, {
            executionId: call.id,
            onProgress: (event) => onProgress?.(event.data),
          });
          if (!result.success) throw new Error(`软件检查命令退出码为 ${result.exitCode}`);
          return parseSoftwareCheckOutput(result.output);
        },
        transferFileBetweenServers: async (request: ServerFileTransferRequest) => {
          const target = this.servers.find((server) => [server.id, server.name, server.host].includes(request.targetServer));
          if (!target) throw new Error(`目标服务器“${request.targetServer}”尚未加入服务器管理`);
          if (target.id === serverId) throw new Error("源服务器和目标服务器不能相同");
          const targetConnection = this.getRuntimeConnection(target.id);
          if (!targetConnection) throw new Error(`目标服务器“${target.name}”缺少已保存的连接凭据，请先在服务器管理中连接该服务器`);
          const transfer = await backend.transferSftpBetweenServers(
            connection, targetConnection, call.id, request.sourcePath, request.targetPath,
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
      });
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
          elapsedMs: Math.round(performance.now() - startedAt),
        }, null, 2),
        serverId,
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
      const password = this.serverPasswords[serverId];
      return server && password
        ? { host: server.host, port: server.port, username: server.username, password }
        : undefined;
    },

    async ensureTaskAgentSession(taskId: string) {
      const task = this.tasks.find(({ id }) => id === taskId);
      const targetServerId = task ? executionServerId(task) : undefined;
      const connection = targetServerId ? this.getRuntimeConnection(targetServerId) : undefined;
      if (!task || !connection || !isTauri() || !agentSandboxTerminalV1Enabled()) return undefined;
      const session = await backend.createAgentTerminal(targetServerId!, task.id, {
        host: connection.host,
        port: connection.port,
        username: connection.username,
      });
      task.agentSessionId = session.id;
      task.agentSessionGeneration = session.generation;
      useAgentTerminalStore().registerSession(session);
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
      this.persist(true);
      const credential = password || this.serverPasswords[serverId];
      if (connectionChanged) {
        this.connectedServerIds = this.connectedServerIds.filter((id) => id !== serverId);
        server.status = credential ? "testing" : "offline";
      }
      if (credential && (password || connectionChanged)) void this.connectServer(serverId, credential, Boolean(password));
    },

    removeServer(serverId: string) {
      const removedSecrets = this.secretMetadata.filter((secret) => secret.serverId === serverId);
      this.servers = this.servers.filter((server) => server.id !== serverId);
      this.secretMetadata = this.secretMetadata.filter((secret) => secret.serverId !== serverId);
      for (const secret of removedSecrets) delete this.secretValues[secretValueId(serverId, secret.key)];
      delete this.serverPasswords[serverId];
      this.connectedServerIds = this.connectedServerIds.filter((id) => id !== serverId);
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
    },

    deleteTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task) return false;
      if (
        task.currentExecutionId
        || ["planning", "running", "validating"].includes(task.status)
      ) return false;

      const wasActive = this.activeTaskId === taskId;
      this.tasks = this.tasks.filter((item) => item.id !== taskId);
      if (this.pendingSecret?.taskId === taskId) this.pendingSecret = null;
      this.pendingUserInputs = this.pendingUserInputs.filter((item) => item.taskId !== taskId);
      if (wasActive) {
        this.activeTaskId = this.tasks.find((item) => item.serverId === task.serverId)?.id ?? null;
      }
      this.addLog({
        category: "task",
        level: "info",
        title: "删除任务",
        detail: `已删除任务“${task.title}”及其本地对话、计划和执行记录。`,
        serverId: task.serverId,
      });
      this.persist(true);
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
      const failureSummary = await summarizeFailedTask({
        task,
        reason: fallbackReason,
        model,
        apiKey,
      });
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
    ) {
      await this.hydrateCredentials();
      let task = selectedTaskId
        ? this.tasks.find((item) => item.id === selectedTaskId && item.serverId === serverId)
        : this.activeTask;
      if (!task || task.serverId !== serverId) {
        task = this.createTask(serverId, permission, modelId);
      }
      await this.ensureTaskAgentSession(task.id);
      const sourceTask = task;
      const requestsCurrentRoundAdjustment =
        ["needs_adjustment", "awaiting_continuation"].includes(task.status)
        && /^(?:请)?(?:进行|生成|重新)?(?:一次|一下)?(?:调整|调整计划|重试)(?:吧|。)?$/i.test(content);
      if (requestsCurrentRoundAdjustment) {
        task.rootGoal ||= latestTaskRequirement(task);
        task.currentInstruction = content;
        task.lastRequirementRelation = "continue";
        this.pushMessage(task, {
          role: "user",
          kind: "event",
          content: `用户请求${content.replace(/[。！!]/g, "")}。`,
        });
        await this.requestAdjustment(task.id);
        return;
      }
      const priorConversation = task.messages
        .filter((message) => message.kind !== "event" || message.role !== "system")
        .slice(-24)
        .map(({ role, kind, content }) => ({ role, kind, content }));
      const previousRequirement = [...task.messages]
        .reverse()
        .find((message) => message.role === "user" && message.kind === "message");
      if (!task.rootGoal && previousRequirement) task.rootGoal = previousRequirement.content;
      const workflowSnapshot = captureWorkflowState(task);
      const previousRoundSnapshot = capturePreviousRound(task);
      const previousExecution = previousRequirement
        ? {
            requirement: previousRequirement.content,
            status: task.status,
            summary: task.summary,
            executionConstraints: task.executionConstraints,
            steps: activeRoundSteps(task).map(({ title, command, expected, status, output, review, result, evidence }) => ({
              title,
              command,
              expected,
              status,
              output: trimEvidence(output),
              review,
              result,
              evidence: evidence?.map(({ type, source, facts, scope }) => ({ type, source, facts, scope })),
            })),
          }
        : undefined;
      task.permission = permission;
      task.modelId = modelId;
      transitionTask(task, "planning");
      task.cancelRequested = false;
      task.currentExecutionId = undefined;
      this.activeTaskId = task.id;
      const submittedMessage = this.pushMessage(task, { role: "user", kind: "message", content });
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
          const keychainDetail = this.credentialError ? ` 系统凭据读取错误：${this.credentialError}` : "";
          throw new Error(`“${model.name}”的 API Key 未恢复，请前往“模型与设置”重新保存一次。${keychainDetail}`);
        }
        const server = this.servers.find((item) => item.id === serverId);
        const contextMetrics = this.metrics;
        const contextSecrets = serverSecretValues(this.secretValues, serverId);
        const availableTerminalLines = this.terminalLines.slice(-400)
          .map((line) => redactExecutionOutput(line, contextSecrets));
        const selectedLines = terminalReference
          ? terminalReference.split("\n").map((line) => redactExecutionOutput(line, contextSecrets))
          : [];
        let requestedTerminalLines = selectedLines.length;
        let context = "";
        let processed;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const includedLines = selectedLines.length
            ? selectedLines
            : requestedTerminalLines > 0
              ? availableTerminalLines.slice(-requestedTerminalLines)
              : [];
          context = JSON.stringify(buildAgentContext({
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
            taskGoal: task.rootGoal ? {
              rootGoal: task.rootGoal,
              currentInstruction: task.currentInstruction,
              status: workflowSnapshot.status,
            } : undefined,
            knownExecutionFacts: extractKnownExecutionFacts(task, resolveTaskSkills(task, this.skills)),
            tools: this.tools,
            skills: resolveTaskSkills(task, this.skills),
            skillDirectory: this.enabledSkills,
            secretMetadata: this.secretMetadata,
            serverId,
          }));
          const skillDefinitions = buildSkillContext(this.enabledSkills);
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
              apiKey: apiKey ?? "",
              endpoint: model.endpoint,
              model: model.model,
              context,
              generationSettings: this.aiGenerationSettings,
            }, skillDefinitions);
            const { developerTrace, ...response } = processed;
            this.addDeveloperLog({
              level: processed.planError ? "error" : "success",
              operation: "requirement_processing",
              title: processed.planError ? "需求处理完成，但计划编译失败" : "需求处理模型调用完成",
              summary: processed.planError ?? `模型返回 ${processed.intent}，共生成 ${processed.plan.length} 个计划步骤。`,
              request: developerRequest,
              response,
              trace: developerTrace,
              serverId,
              taskId: task.id,
              modelProfileId: model.id,
              modelName: `${model.name} / ${model.model}`,
              endpoint: model.endpoint,
              durationMs: Date.now() - startedAt,
            });
          } catch (error) {
            this.addDeveloperLog({
              level: "error",
              operation: "requirement_processing",
              title: "需求处理模型调用失败",
              summary: error instanceof Error ? error.message : String(error),
              request: developerRequest,
              trace: error instanceof ModelInvocationError ? error.developerTrace : undefined,
              error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
              stack: error instanceof Error ? error.stack : undefined,
              serverId,
              taskId: task.id,
              modelProfileId: model.id,
              modelName: `${model.name} / ${model.model}`,
              endpoint: model.endpoint,
              durationMs: Date.now() - startedAt,
            });
            throw error;
          }
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
        const relation = normalizeRequirementRelation(processed, content, Boolean(sourceTask.rootGoal));
        if (relation === "side_question") {
          sourceTask.lastRequirementRelation = relation;
          sourceTask.currentInstruction = content;
          sourceTask.messages = sourceTask.messages.filter((message) => message.id !== understandingMessage.id);
          const previousRoundEnded = ["completed", "failed", "cancelled"].includes(workflowSnapshot.status);
          if (sourceTask.rootGoal && previousRoundEnded) {
            // A side question starts a display-only round after a finished workflow.
            // Archive the old plan before appending the answer so it cannot appear
            // as the current plan of the new question.
            commitPreviousRound(sourceTask, previousRoundSnapshot);
            sourceTask.plan = [];
            sourceTask.summary = undefined;
            sourceTask.pauseReason = undefined;
            sourceTask.executionConstraints = undefined;
            sourceTask.currentRoundId = uid("round");
            transitionTask(sourceTask, "completed");
          } else if (sourceTask.rootGoal) {
            // A pending approval/input/adjustment still belongs to the active
            // workflow and must survive a temporary question.
            restoreWorkflowState(sourceTask, workflowSnapshot);
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
            transitionTask(sourceTask, "cancelled");
            sourceTask.pauseReason = `用户已将整体目标替换为：${content}`;
          } else {
            restoreWorkflowState(sourceTask, workflowSnapshot);
          }
          task = this.createTask(serverId, permission, modelId);
          transitionTask(task, "planning");
          task.rootGoal = content;
          task.currentInstruction = content;
          task.lastRequirementRelation = "new_goal";
          task.title = content.slice(0, 22);
          task.currentRoundId = uid("round");
          this.pushMessage(task, { role: "user", kind: "message", content });
          await this.ensureTaskAgentSession(task.id);
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
          if (previousRoundSnapshot) {
            commitPreviousRound(task, previousRoundSnapshot);
            this.pushMessage(task, {
              role: "system",
              kind: "event",
              content: "开始处理本任务中的新一轮需求；整体目标保持不变，上一轮执行记录已保留，计划、输出和校验证据已归档。",
            });
          }
          task.rootGoal ||= content;
          task.currentInstruction = content;
          task.lastRequirementRelation = relation;
          task.currentRoundId = uid("round");
          task.title = task.title === "新任务" ? task.rootGoal.slice(0, 22) : task.title;
        }
        task.plan = [];
        task.summary = undefined;
        task.pauseReason = undefined;
        task.executionConstraints = undefined;
        task.confirmedSecretKeys = [];
        task.adjustmentCount = 0;
        task.adjustmentInProgress = false;
        task.adjustmentIncident = undefined;
        task.lastAdjustmentBlocker = undefined;
        task.transportRecovery = undefined;
        task.discoveryRefined = false;
        task.refinementCount = 0;
        task.cancelRequested = false;
        task.currentExecutionId = undefined;
        this.activeTaskId = task.id;
        const selectedSkillIds = processed.selectedSkillIds ?? [];
        task.activeSkillIds = mergeTaskSkillIds(task.activeSkillIds, selectedSkillIds, relation);
        if (processed.planError) {
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
            level: "error",
            title: "Skill 选择已保留，计划生成失败",
            detail: JSON.stringify({
              requirement: content,
              selectedSkillIds: task.activeSkillIds ?? [],
              error: processed.planError,
            }, null, 2),
            serverId,
            taskId: task.id,
          });
          transitionTask(task, "planning_failed");
          task.summary = undefined;
          task.pauseReason = `计划生成未通过协议或安全校验：${processed.planError}。未向服务器发送任何计划命令；整体目标、Skill 选择和已有证据均已保留，可直接重试规划。`;
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
        task.executionConstraints = processed.constraints;
        const requiresReadOnlyPlan = processed.constraints?.changePolicy === "read_only";
        task.plan = requiresReadOnlyPlan
          ? processed.plan.filter((step) => (
              step.kind !== "change"
              && !isMutatingStepCommand(step.command)
            )).map(ensureStepValidator)
          : processed.plan.map(ensureStepValidator);
        if (!task.plan.length) {
          throw new Error("模型计划只包含未经用户请求的变更操作，已安全拦截；请明确要求修复，或重新生成只读诊断计划");
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
        if (task.cancelRequested) return;
        transitionTask(task, "planning_failed");
        task.summary = undefined;
        const message = error instanceof Error ? error.message : String(error);
        task.pauseReason = `本轮计划生成失败：${message}。未执行服务器变更，可直接重试规划。`;
        this.pushMessage(task, { role: "assistant", kind: "summary", content: task.pauseReason });
        this.persist();
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

    async routeAutomaticAdjustment(
      taskId: string,
      options: { transportRecovery?: boolean } = {},
    ) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || !["needs_adjustment", "awaiting_continuation", "failed"].includes(task.status)) return;

      if (options.transportRecovery) {
        const failed = [...task.plan].reverse().find((step) => step.status === "failed");
        const snapshot = buildAdjustmentBlockerSnapshot(
          task,
          failed,
          this.adjustmentTargetState(task),
        );
        // 终端通道恢复是执行器内部事务，三种模式均可自动推进；
        // 但只能进入 transport 恢复分支，不得借此触发模型重拟业务计划。
        if (snapshot.kind === "transport") {
          if (task.permission === "managed") {
            task.managedAdjustmentPhase = "waiting_transport";
            task.managedStopReason = "transport_recovery";
          }
          await this.requestAdjustment(taskId, true);
          return;
        }
        const mismatchNotice = "终端恢复入口未检测到终端通道阻断，已停止自动恢复；不会由该入口生成业务调整计划。";
        task.pauseReason = task.pauseReason ?? mismatchNotice;
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
      const guidance = `${modeLabel}不会自动调用模型生成业务调整计划；请检查当前证据后手动生成调整方案。`;
      if (!task.pauseReason?.includes(guidance)) {
        task.pauseReason = task.pauseReason ? `${task.pauseReason}；${guidance}` : guidance;
      }
      if (!task.messages.some((message) => message.kind === "event" && message.content === guidance)) {
        this.pushMessage(task, { role: "system", kind: "event", content: guidance });
      }
      this.persist();
    },

    async waitForAdjustmentTransportRecovery(taskId: string) {
      if (recoveringAdjustmentTaskIds.has(taskId)) return;
      recoveringAdjustmentTaskIds.add(taskId);
      try {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const task = this.tasks.find((item) => item.id === taskId);
          if (!task || task.cancelRequested || task.adjustmentIncident?.kind !== "transport") return;
          const target = this.adjustmentTargetState(task);
          const ready = target.paneId
            ? target.terminalStatus === "connected" && !target.terminalBusy
            : this.connectedServerIds.includes(task.serverId);
          if (ready) {
            this.pushMessage(task, {
              role: "system",
              kind: "event",
              content: "终端执行通道已恢复，正在恢复被中断的步骤；本次恢复不占用业务调整次数。",
            });
            this.persist();
            await this.routeAutomaticAdjustment(taskId, { transportRecovery: true });
            return;
          }
          await wait(250);
        }
        const task = this.tasks.find((item) => item.id === taskId);
        if (task?.adjustmentIncident?.kind === "transport") {
          task.pauseReason = "绑定终端仍未恢复。请重连或刷新终端；系统不会把执行通道故障交给模型改写业务计划。";
          this.pushMessage(task, { role: "system", kind: "event", content: task.pauseReason });
          this.persist();
        }
      } finally {
        recoveringAdjustmentTaskIds.delete(taskId);
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
          task.adjustmentIncident = undefined;
          task.lastAdjustmentBlocker = undefined;
          task.pauseReason = `终端执行通道已恢复；${failed.result.failureReason ?? "长任务仍需调整执行方式"}`;
          await this.routeAutomaticAdjustment(taskId);
          return;
        }

        const commandWasNotSent = failed.result?.facts.commandCompleted === false
          && category === "terminal_transport";
        if (!commandWasNotSent) {
          task.pauseReason = category === "validation_protocol_exception"
            ? "终端通道已恢复，主命令已执行，但后置校验未取得真实退出码。系统不会重放主命令或让模型猜测结果；请检查当前状态后重新校验。"
            : "终端通道已恢复，但无法确定原命令是否产生副作用。系统不会自动重放或让模型猜测；请检查当前服务器状态后重试。";
          if (!task.messages.some((message) => message.kind === "event" && message.content === task.pauseReason)) {
            this.pushMessage(task, { role: "system", kind: "event", content: task.pauseReason });
          }
          // The transport incident has been consumed. Leaving it active lets
          // concurrent recovery/countdown callbacks route the same stale event
          // repeatedly and flood the task timeline.
          task.adjustmentIncident = undefined;
          task.lastAdjustmentBlocker = undefined;
          task.transportRecovery = undefined;
          this.persist();
          return;
        }

        const retry = clearStepRuntime(failed, uid("transport-retry"));
        const remaining = task.plan.filter((step) => step !== failed && ["pending", "awaiting_approval", "awaiting_input"].includes(step.status));
        archiveActivePhase(task, "adjustment");
        task.plan = [retry, ...remaining];
        task.pauseReason = undefined;
        task.summary = undefined;
        task.adjustmentIncident = undefined;
        task.lastAdjustmentBlocker = undefined;
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

    async beginAdjustment(taskId: string, _automatic = false, expectedFingerprint?: string) {
      if (adjustingTaskIds.has(taskId)) return;
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || !["needs_adjustment", "awaiting_continuation", "failed"].includes(task.status)) return;
      if (expectedFingerprint && task.adjustmentIncident?.fingerprint !== expectedFingerprint) return;
      adjustingTaskIds.add(taskId);
      task.adjustmentInProgress = true;
      if (task.permission === "managed") {
        task.managedAdjustmentPhase = "generating";
        task.managedStopReason = undefined;
      }
      this.persist();
      try {
        await this.hydrateCredentials();
        if (task.cancelRequested || !["needs_adjustment", "awaiting_continuation", "failed"].includes(task.status)) return;
        if (expectedFingerprint && task.adjustmentIncident?.fingerprint !== expectedFingerprint) return;
        const phaseSummary = task.pauseReason;
        task.pauseReason = undefined;
        const failed = task.plan.find((step) => step.status === "failed");
        const model = this.models.find((item) => item.id === task.modelId);
        const apiKey = this.modelApiKeys[task.modelId];
        if (!model) {
          await this.finalizeFailedTask(task.id, "调整计划失败：所选模型配置不存在。");
          return;
        }
        if (model.provider !== "Built-in" && !apiKey) {
          await this.finalizeFailedTask(
            task.id,
            `调整计划失败：“${model.name}”的 API Key 未恢复，请前往“模型与设置”重新保存。`,
          );
          return;
        }
        const server = this.servers.find((item) => item.id === task.serverId);
        transitionTask(task, "planning");
        this.pushMessage(task, { role: "system", kind: "event", content: "正在结合失败输出重新生成调整计划…" });
        this.persist();
        try {
          const adjustment = await planTaskAdjustment({
            task,
            failedStep: failed,
            server,
            metrics: this.metrics,
            tools: this.tools,
            secretMetadata: this.secretMetadata,
            model,
            apiKey,
            generationSettings: this.aiGenerationSettings,
            skills: resolveTaskSkills(task, this.skills),
          });
          archiveActivePhase(task, "adjustment", now(), phaseSummary);
          task.plan = adjustment.plan;
          transitionTask(task, "awaiting_plan_approval");
          this.pushPlanProgressMessage(
            task,
            task.permission === "managed"
              ? `已进入下一阶段，包含 ${adjustment.replacement.length} 个执行步骤。`
              : `下一阶段计划已生成，包含 ${adjustment.replacement.length} 个执行步骤，等待批准。`,
          );
          this.addLog({
            category: "model",
            level: "warning",
            title: "模型调整计划已返回",
            detail: JSON.stringify({
              context: adjustment.context,
              replacement: adjustment.replacement,
            }, null, 2),
            serverId: task.serverId,
            taskId,
          });
          this.persist();
          task.adjustmentInProgress = false;
          if (task.permission === "managed") {
            await this.approvePlan(task.id, true);
          }
        } catch (error) {
          const reason = `调整计划生成失败：${String(error)}`;
          this.pushMessage(task, { role: "system", kind: "event", content: reason });
          transitionTask(task, "needs_adjustment");
          const phaseCompleted = task.plan.length > 0
            && task.plan.every((step) => step.status === "completed");
          task.pauseReason = phaseCompleted
            ? `当前阶段的 ${task.plan.length} 个步骤已成功完成，证据保持有效；${reason}。整体目标尚未完成，可基于现有证据继续生成后续方案。`
            : `${reason}。原执行证据和未完成目标已保留，可生成调整方案。`;
          task.summary = undefined;
          if (task.permission === "managed") {
            task.managedAdjustmentPhase = "manual_required";
            task.managedStopReason = "model_generation_failed";
          }
          this.addLog({
            category: "model",
            level: "warning",
            title: "调整计划格式异常，任务保持可恢复",
            detail: task.pauseReason,
            serverId: task.serverId,
            taskId,
          });
        }
        this.persist();
      } finally {
        task.adjustmentInProgress = false;
        adjustingTaskIds.delete(taskId);
        this.persist();
      }
    },

    async adjustTask(taskId: string, automatic = false) {
      await this.requestAdjustment(taskId, automatic);
    },

    async requestAdjustment(taskId: string, automatic = false) {
      if (adjustingTaskIds.has(taskId)) return;
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || !["needs_adjustment", "awaiting_continuation", "failed"].includes(task.status)) return;
      const failed = [...task.plan].reverse().find((step) => step.status === "failed");
      const target = this.adjustmentTargetState(task);
      const snapshot = buildAdjustmentBlockerSnapshot(task, failed, target);
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
        if (task.status === "failed") transitionTask(task, "needs_adjustment");
        const ready = target.paneId
          ? target.terminalStatus === "connected" && !target.terminalBusy
          : this.connectedServerIds.includes(task.serverId);
        if (ready && failed) {
          const replayable = snapshot.category === "terminal_transport"
            && failed.result?.facts.commandCompleted === false;
          if (replayable) {
            if (task.transportRecovery?.targetFingerprint !== snapshot.targetFingerprint) {
              task.transportRecovery = {
                targetFingerprint: snapshot.targetFingerprint,
                replayCount: 0,
                updatedAt: now(),
              };
            }
            if ((task.transportRecovery?.replayCount ?? 0) >= 1) {
              task.pauseReason = "当前终端代次已自动重放过一次，但相同传输故障仍然出现。已停止重复重放；请重连终端后继续。";
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
      if (incident.attemptCount >= 1) {
        if (task.permission === "managed") {
          task.managedAdjustmentPhase = "manual_required";
          task.managedStopReason = "retry_exhausted";
        }
        await this.finalizeFailedTask(
          task.id,
          automatic
            ? "相同阻塞事件在自动调整后仍无新证据，系统已停止重复重拟。新凭据、新终端代次或新执行证据出现后可开启新事件。"
            : "相同阻塞事件没有新证据，已停止重复生成调整计划。请先补充凭据、恢复终端或更新凭据后再继续。",
        );
        return;
      }
      incident.attemptCount += 1;
      incident.updatedAt = now();
      task.adjustmentCount = incident.attemptCount;
      await this.beginAdjustment(taskId, automatic, incident.fingerprint);
    },

    async queueManagedAdjustment(taskId: string, seconds = 5) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || task.permission !== "managed"
        || !["needs_adjustment", "awaiting_continuation"].includes(task.status)) return;
      const activeScheduler = managedAdjustmentSchedulers.get(taskId);
      if (activeScheduler) {
        // Nested approve/advance calls may discover another continuation while
        // the prior adjustment promise is still unwinding. Record the request
        // instead of silently dropping it behind the old countdown lock.
        activeScheduler.requested = true;
        return;
      }
      const scheduler = { requested: true };
      managedAdjustmentSchedulers.set(taskId, scheduler);
      try {
        while (scheduler.requested) {
          scheduler.requested = false;
          const current = this.tasks.find((item) => item.id === taskId);
          if (!current || current.permission !== "managed"
            || !["needs_adjustment", "awaiting_continuation"].includes(current.status)
            || current.cancelRequested) break;
          current.managedAdjustmentPhase = "countdown";
          current.managedStopReason = undefined;
          for (let remaining = seconds; remaining > 0; remaining -= 1) {
            if (!["needs_adjustment", "awaiting_continuation"].includes(current.status)
              || current.cancelRequested) break;
            current.autoAdjustmentSeconds = remaining;
            this.persist();
            await wait(1_000);
          }
          if (!["needs_adjustment", "awaiting_continuation"].includes(current.status)
            || current.cancelRequested) continue;
          current.autoAdjustmentSeconds = undefined;
          current.managedAdjustmentPhase = "generating";
          this.pushMessage(current, {
            role: "system",
            kind: "event",
            content: "完全托管模式倒计时结束，开始生成调整方案；生成后将自动继续，高风险步骤仍需单独确认。",
          });
          await this.requestAdjustment(taskId, true);
          // A successful adjustment may synchronously execute the replacement
          // plan and land in another continuation before requestAdjustment
          // returns. Keep the same scheduler alive for that next round.
          if (current.status === "awaiting_continuation") scheduler.requested = true;
        }
      } finally {
        const current = this.tasks.find((item) => item.id === taskId);
        if (current) {
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
        managedAdjustmentSchedulers.delete(taskId);
        this.persist();
      }
    },

    async approvePlan(taskId: string, automatic = false) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || task.status !== "awaiting_plan_approval") return;
      const beforeNormalization = task.plan.map(({ id, command, validation }) => ({ id, command, validation }));
      task.plan = normalizePlanPreconditions(task.plan, latestTaskRequirement(task), this.tools);
      const changedSteps = task.plan.filter((step) => {
        const before = beforeNormalization.find((candidate) => candidate.id === step.id);
        return before && (before.command !== step.command || before.validation !== step.validation);
      });
      if (changedSteps.length) {
        this.pushMessage(task, {
          role: "system",
          kind: "event",
          content: `执行前安全规范化更新了 ${changedSteps.length} 个步骤的命令或后置校验，计划已显示最终内容。`,
        });
        if (!automatic) {
          task.pauseReason = "计划内容在批准前完成了安全规范化，请检查更新后的最终命令并重新确认。";
          this.persist();
          return;
        }
      }
      transitionTask(task, "running");
      task.pauseReason = undefined;
      this.pushMessage(task, {
        role: automatic ? "system" : "user",
        kind: "event",
        content: automatic
          ? "完全托管模式已自动批准计划，开始执行。"
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
      if (!task || ["completed", "failed", "cancelled"].includes(task.status)) return;
      transitionTask(task, "cancelled");
      const pending = task.plan.find((step) => step.status === "awaiting_approval");
      if (pending) cancelStep(pending, "用户取消");
      this.pushMessage(task, { role: "user", kind: "event", content: "用户已停止本次执行。" });
      task.summary = task.pauseReason
        ? `本次任务已由用户结束。结束前的暂停原因：${task.pauseReason}`
        : "本次任务已由用户取消，未再执行后续步骤。";
      task.pauseReason = undefined;
      this.pendingUserInputs = this.pendingUserInputs.filter((item) => item.taskId !== taskId);
      this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
      this.persist();
    },

    async terminateTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || ["completed", "failed", "cancelled"].includes(task.status)) return;
      task.cancelRequested = true;
      this.pushMessage(task, { role: "user", kind: "event", content: "正在终止本次业务及其当前远程进程…" });
      const executionId = task.currentExecutionId;
      const targetServerId = executionServerId(task);
      const server = this.servers.find((item) => item.id === targetServerId);
      const password = this.serverPasswords[targetServerId];
      const agentSession = useAgentTerminalStore().sessionsByTask[task.id];
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
      transitionTask(task, "cancelled");
      this.pendingUserInputs = this.pendingUserInputs.filter((item) => item.taskId !== taskId);
      if (this.pendingSecret?.taskId === taskId) this.pendingSecret = null;
      const active = task.plan.find((step) => ["running", "validating", "awaiting_approval", "awaiting_input"].includes(step.status));
      if (active) {
        cancelStep(active, "用户终止");
      }
      task.currentExecutionId = undefined;
      task.summary = "本次业务已由用户终止，后续步骤未再执行。";
      task.pauseReason = undefined;
      this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
      this.persist(true);
    },

    needsApproval(permission: PermissionLevel, step: PlanStep) {
      return requiresStepApproval(permission, step);
    },

    async advanceTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || !["running", "awaiting_step_approval"].includes(task.status)) return;
      const targetServerId = executionServerId(task);
      const progression = resolveTaskProgression(task, this.tools);
      if (progression.kind !== "execute-step") {
        if (progression.kind === "refine-discovery") {
          task.discoveryRefined = true;
          task.refinementCount = (task.refinementCount ?? 0) + 1;
          transitionTask(task, "planning");
          const requirement = latestTaskRequirement(task);
          const model = this.models.find((item) => item.id === task.modelId);
          const apiKey = this.modelApiKeys[task.modelId];
          const server = this.servers.find((item) => item.id === targetServerId);
          const refinement = await runDiscoveryRefinement({
            task,
            requirement,
            server,
            metrics: this.metrics,
            tools: this.tools,
            secretMetadata: this.secretMetadata,
            model,
            apiKey,
            generationSettings: this.aiGenerationSettings,
            skills: resolveTaskSkills(task, this.skills),
            isCancelled: () => task.cancelRequested === true,
            onStart: () => {
              this.pushMessage(task, {
                role: "system",
                kind: "event",
                content: "发现阶段已完成，正在依据真实证据生成一次后续变更与验收计划…",
              });
              this.persist();
            },
          });
          if (refinement.kind === "cancelled") return;
          if (refinement.kind !== "success") {
            transitionTask(task, "needs_adjustment");
            task.pauseReason = refinement.pauseReason;
            if (refinement.kind === "failed") {
              this.pushMessage(task, {
                role: "assistant",
                kind: "event",
                content: refinement.eventMessage,
              });
            }
            this.persist();
            return;
          }
          task.plan = [...task.plan, ...refinement.pending];
          transitionTask(task, "awaiting_plan_approval");
          this.pushPlanProgressMessage(task, refinement.eventMessage);
          this.persist();
          if (refinement.autoApprove) {
            await this.approvePlan(task.id, true);
          }
          return;
        }
        transitionTask(task, "validating");
        this.pushMessage(task, { role: "system", kind: "event", content: "执行步骤已完成，正在根据实际输出整理本轮结果…" });
        this.persist();
        const model = this.models.find((item) => item.id === task.modelId);
        const apiKey = this.modelApiKeys[task.modelId];
        const goalReview = await reviewTaskGoal({
          task,
          model,
          apiKey,
          skills: resolveTaskSkills(task, this.skills),
        });
        this.addLog({
          category: "model",
          level: goalReview.complete ? "success" : "warning",
          title: goalReview.complete ? "整体目标完成门禁已通过" : "当前阶段结束但整体目标尚未完成",
          detail: JSON.stringify({
            rootGoal: goalReview.requirement,
            decision: goalReview.decision,
          }, null, 2),
          serverId: targetServerId,
          taskId,
        });
        if (!goalReview.complete) {
          transitionTask(task, "awaiting_continuation");
          task.pauseReason = goalReview.decision.summary;
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: `当前计划阶段已完成，但整体目标尚未验收：${goalReview.decision.summary}`,
          });
          this.persist();
          return;
        }
        const completionPipeline = await runTaskCompletion({
          task,
          model,
          apiKey,
          serverId: targetServerId,
          taskId,
          isCancelled: () => task.cancelRequested === true,
        });
        completionPipeline.audits.forEach((event) => this.addLog(event));
        if (completionPipeline.cancelled || task.cancelRequested) return;
        task.summary = completionPipeline.completion.summary;
        transitionTask(task, "completed");
        task.pauseReason = undefined;
        this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
        this.persist();
        return;
      }
      const step = progression.step;

      const blockerStep = findUnresolvedBlockingStep(task, step);
      if (blockerStep) {
        const model = this.models.find((item) => item.id === task.modelId);
        const apiKey = this.modelApiKeys[task.modelId];
        transitionTask(task, "validating");
        this.pushMessage(task, {
          role: "assistant",
          kind: "event",
          content: "发现未解决的前置条件，正在结合用户需求、执行记录、完整计划和剩余步骤进行一次模型复核…",
        });
        this.persist();
        const reviewPipeline = await runPreconditionReviewPipeline({
          task,
          step,
          blockerStep,
          model,
          apiKey,
          serverId: targetServerId,
          taskId,
          isCancelled: () => task.cancelRequested === true,
        });
        if (reviewPipeline.cancelled || task.cancelRequested) return;
        reviewPipeline.audits.forEach((event) => this.addLog(event));
        const coordination = reviewPipeline.coordination;
        transitionTask(task, coordination.taskStatus);
        task.pauseReason = coordination.pauseReason;
        this.pushMessage(task, {
          role: "assistant",
          kind: "event",
          content: coordination.eventMessage,
        });
        this.persist();
        if (!coordination.shouldExecute) return;
      }

      if (!/^opsark-tool(?:\s|$)/i.test(step.command.trim())) {
        step.progressMessage = "正在进行执行前安全检查…";
        const safety = await inspectPlanSafety(step.command, step.validation, true);
        if (safety.repairedFields.length) {
          applySafetyNormalization(step, safety.normalizedCommand, safety.normalizedValidation);
          this.pushMessage(task, {
            role: "system",
            kind: "event",
            content: `执行前安全检查已修正步骤“${step.title}”的 ${safety.repairedFields.join("、")} 退出状态传播；计划已更新为最终内容。`,
          });
        }
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

      const approval = requestStepApproval(task.permission, step);
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
      await this.runStep(taskId, step.id);
    },

    async approveStep(taskId: string, stepId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      const step = task?.plan.find((item) => item.id === stepId);
      if (!task || !step) return;
      const approval = acceptStepApproval(step);
      if (!approval) return;
      transitionTask(task, approval.taskStatus);
      await this.runStep(taskId, stepId);
      if (task.permission === "managed" && ["needs_adjustment", "awaiting_continuation"].includes(task.status)) {
        void this.queueManagedAdjustment(task.id, 5);
      }
    },

    async runToolStep(taskId: string, stepId: string, call: ToolCall) {
      const task = this.tasks.find((item) => item.id === taskId);
      const step = task?.plan.find((item) => item.id === stepId);
      if (!task || !step) return;
      const toolDefinition = this.tools.find((tool) => tool.id === call.toolId);
      if (toolDefinition?.executionMode === "user-input") {
        try {
          const request = parseUserInputArguments(call.arguments);
          transitionStep(step, "awaiting_input");
          transitionTask(task, "awaiting_input");
          step.startedAt = now();
          step.progressMessage = "等待用户补充参数";
          this.pendingUserInputs = this.pendingUserInputs
            .filter((item) => item.taskId !== taskId)
            .concat({ taskId, stepId, callId: call.id, ...request });
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: `需要用户补充 ${request.fields.length} 个参数后才能继续；每个参数的用途已在输入区说明。`,
          });
          this.persist();
        } catch (error) {
          const failure = failToolCommandParsing(step, error);
          transitionTask(task, "needs_adjustment");
          task.pauseReason = failure.pauseReason;
          this.pushMessage(task, { role: "assistant", kind: "event", content: failure.eventMessage });
          this.persist();
        }
        return;
      }
      task.currentExecutionId = call.id;
      const lifecycle = await runToolStepLifecycle({
        step,
        call,
        execute: async () => {
          return this.executeToolCall(
            executionServerId(task),
            call,
            (message) => { step.progressMessage = message; },
            undefined,
            task.id,
          );
        },
        createEvidenceId: () => uid("evidence-tool"),
        now,
        isCancelled: () => task.cancelRequested === true,
        onStart: (eventMessage) => {
          transitionTask(task, "running");
          this.pushMessage(task, { role: "assistant", kind: "event", content: eventMessage });
          this.persist();
        },
      });
      task.currentExecutionId = undefined;
      if (lifecycle.cancelled || task.cancelRequested) return;
      transitionTask(task, lifecycle.taskStatus);
      task.pauseReason = lifecycle.pauseReason;
      this.pushMessage(task, {
        role: "assistant",
        kind: "event",
        content: lifecycle.eventMessage,
      });
      this.persist();
      if (!lifecycle.shouldAdvance) {
        if (isTerminalTransportFailure(lifecycle.pauseReason) && step.result) {
          step.result.facts.category = "terminal_transport";
          step.result.facts.commandCompleted = false;
          step.result.facts.terminalReleased = false;
          await this.routeAutomaticAdjustment(taskId, { transportRecovery: true });
        }
        return;
      }
      await this.advanceTask(taskId);
    },

    async runStep(taskId: string, stepId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      const step = task?.plan.find((item) => item.id === stepId);
      if (!task || !step) return;
      const targetServerId = executionServerId(task);
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
      const dispatch = resolveStepDispatch(
        step,
        task.confirmedSecretKeys ?? [],
        uid("tool-call"),
        this.tools,
        Object.keys(serverSecretValues(this.secretValues, targetServerId)),
        [...new Set(resolveTaskSkills(task, this.skills).flatMap((skill) => skill.forbiddenToolIds ?? []))],
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
          await this.runToolStep(taskId, stepId, entry.call);
          return;
        }
        if (entry.kind === "stop") {
          transitionTask(task, entry.taskStatus);
          task.pauseReason = entry.pauseReason;
          if (entry.pendingSecretKey) {
            this.pendingSecret = buildSecretUnlockRequest({
              taskId,
              step,
              key: entry.pendingSecretKey,
              metadataDescription: metadata?.description,
            });
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

      if (requiresStepApproval(task.permission, step) && !hasCurrentStepApproval(step)) {
        if (step.status !== "awaiting_approval") transitionStep(step, "awaiting_approval");
        transitionTask(task, "awaiting_step_approval");
        step.safetyApprovalSnapshot = undefined;
        step.approvedSafetySnapshot = undefined;
        this.pushMessage(task, {
          role: "assistant",
          kind: "event",
          content: `步骤“${step.title}”的命令或后置校验在批准后发生变化，原批准已失效；请检查最终内容后重新确认。`,
        });
        this.persist();
        return;
      }

      const server = this.servers.find((item) => item.id === targetServerId);
      const password = this.serverPasswords[targetServerId];
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
      step.executionScope = scopedStep.executionScope;
      step.validationScope = scopedStep.validationScope;
      step.runtimeClass = scopedStep.runtimeClass;
      const useAgentSandbox = agentSandboxTerminalV1Enabled()
        && isTauri()
        && Boolean(prepared.connection);
      agentTerminals.system(task.id, entry.terminalHeader);
      this.persist();

      let executionPhase: "command" | "validation" = "command";
      let agentSession: import("@/types").AgentSessionRef | undefined = agentTerminals.sessionsByTask[task.id];
      let rollbackShellStartupOnFailure: ((reason: string) => Promise<boolean>) | undefined;
      try {
        if (useAgentSandbox && prepared.connection) {
          agentSession = await this.ensureTaskAgentSession(task.id);
        }
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
            const frameworkResult = useAgentSandbox && prepared.connection && agentSession
              ? await backend.executeAgentCommand({
                  connection: prepared.connection,
                  session: agentSession,
                  executionId: frameworkExecutionId,
                  command,
                  scope: "isolated_exec",
                  approvedHighRisk,
                  onProgress: (event) => {
                    if (!event.data || (event.stream !== "stdout" && event.stream !== "stderr")) return;
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
                    frameworkStreamed = true;
                    agentTerminals.output(task.id, frameworkExecutionId, safeChunk);
                    appendTerminalStream(this.terminalLines, safeChunk);
                  },
                });
            const safeFrameworkOutput = redactExecutionOutput(frameworkResult.output, scopedSecrets);
            if (safeFrameworkOutput && !frameworkStreamed) {
              agentTerminals.output(task.id, frameworkExecutionId, `${safeFrameworkOutput}\n`);
            }
            agentTerminals.finish(
              task.id,
              frameworkExecutionId,
              frameworkResult.exitCode ?? (frameworkResult.success ? 0 : 1),
            );
            return { ...frameworkResult, output: safeFrameworkOutput };
          } catch (error) {
            agentTerminals.finish(task.id, frameworkExecutionId, 1);
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
        const commandLifecycle = await runCommandLifecycle({
          task,
          step,
          requirement,
          command: prepared.resolvedCommand,
          validation: prepared.resolvedValidation,
          executionId,
          connection: prepared.connection,
          runtimeModel: prepared.runtimeModel,
          secretValues: scopedSecrets,
          isCancelled: () => task.cancelRequested === true,
          onExecutionChange: (activeExecutionId) => {
            task.currentExecutionId = activeExecutionId;
          },
          onProgress: (safeChunk, streamedOutput) => {
            step.output = `$ ${step.command}\n${streamedOutput}`;
            appendTerminalStream(this.terminalLines, safeChunk);
          },
          onHeartbeat: (elapsedSeconds, progressMessage) => {
            step.elapsedSeconds = elapsedSeconds;
            step.progressMessage = progressMessage;
          },
          onEvent: (role, content) => {
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
            if (useAgentSandbox && prepared.connection && agentSession) {
              await backend.interruptAgentCommand(prepared.connection, agentSession, executionId);
              return;
            }
            if (prepared.connection) await backend.cancelCommand(prepared.connection, executionId);
          },
          sampleRuntimeProgress: useAgentSandbox && prepared.connection && agentSession
            ? () => backend.sampleAgentExecutionProgress(prepared.connection!, agentSession!, executionId)
            : undefined,
        }, async (input) => {
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
            onProgress: (event) => {
              if (!event.data || (event.stream !== "stdout" && event.stream !== "stderr")) return;
              const safeChunk = redactExecutionOutput(event.data, scopedSecrets);
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
          return { ...result, output: redactExecutionOutput(result.output, scopedSecrets) };
        });
        const result = commandLifecycle.result;
        const streamedOutput = commandLifecycle.streamedOutput;
        const monitorState = commandLifecycle.monitorState;
        const monitorDecision = monitorState.decision;
        const monitorValidationPassed = monitorState.validationPassed;
        const monitorRound = monitorState.reviewRound;
        if (task.cancelRequested) {
          await rollbackShellStartup("任务已取消");
          return;
        }
        let safeOutput = result.output;
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
          agentTerminals.output(task.id, executionId, `${completionLines.join("\n")}\n`);
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
          });
          if (step.result && startupTransaction) {
            step.result.facts.shellStartupSnapshot = startupTransaction.backupPaths.join(",");
            step.result.facts.shellStartupRollback = startupRollbackSucceeded ? "success" : "failed";
          }
          transitionTask(task, coordination.taskStatus);
          task.pauseReason = coordination.pauseReason;
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: coordination.eventMessage,
          });
          this.persist();
          await this.routeAutomaticAdjustment(taskId);
          return;
        }
        if (!result.success) {
          if (result.exitCode === 130 || task.cancelRequested) return;
          const failure = applyCommandFailure(step, {
            output: safeOutput,
            exitCode: result.exitCode,
            evidenceId: uid("evidence-main"),
            collectedAt: now(),
          });
          if (step.result && startupTransaction) {
            step.result.facts.shellStartupSnapshot = startupTransaction.backupPaths.join(",");
            step.result.facts.shellStartupRollback = startupRollbackSucceeded ? "success" : "failed";
          }
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
            isCancelled: () => task.cancelRequested === true,
          });
          if (reviewPipeline.cancelled || task.cancelRequested) return;
          reviewPipeline.audits.forEach((event) => this.addLog(event));
          const coordination = reviewPipeline.coordination;
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
        let validationStreamed = false;
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
                isCancelled: () => task.cancelRequested === true,
                onExecutionChange: (activeExecutionId) => {
                  task.currentExecutionId = activeExecutionId;
                },
                onProgress: (safeChunk) => {
                  validationStreamed = true;
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
              }, useAgentSandbox && prepared.connection && agentSession
                ? async (input) => {
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
                    onProgress: (event) => {
                      if (!event.data || (event.stream !== "stdout" && event.stream !== "stderr")) return;
                      const safeChunk = redactExecutionOutput(event.data, scopedSecrets);
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
                    passed: result.success,
                    detail: result.success ? "后置校验通过" : `后置校验退出码 ${result.exitCode}`,
                    output: result.output,
                    exitCode: result.exitCode,
                    emptyResult: result.emptyResult,
                  };
                }
                : undefined);
            })();
        if (task.cancelRequested) {
          await rollbackShellStartup("任务在验收期间已取消");
          return;
        }
        let validation = validationLifecycle.validation;
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
          if (!validationStreamed) agentTerminals.output(task.id, task.currentExecutionId ?? "validation", `${assembledValidation.validationOutput}\n`);
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
          isCancelled: () => task.cancelRequested === true,
        });
        if (reviewPipeline.cancelled || task.cancelRequested) return;
        reviewPipeline.audits.forEach((event) => this.addLog(event));
        const coordination = reviewPipeline.coordination;
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
        await this.advanceTask(taskId);
      } catch (error) {
        if (rollbackShellStartupOnFailure) {
          await rollbackShellStartupOnFailure("执行或验收通道异常");
        }
        if (executionPhase === "validation") {
          const failure = failValidationProtocol(step, error);
          if (isTerminalTransportFailure(error)) {
            transitionStep(step, "failed");
            transitionTask(task, "needs_adjustment");
            task.pauseReason = failure.pauseReason;
            this.pushMessage(task, {
              role: "assistant",
              kind: "event",
              content: `${failure.pauseReason}。已转入终端通道恢复，不会让模型改写业务计划。`,
            });
            this.persist();
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
              isCancelled: () => task.cancelRequested === true,
            });
            if (reviewPipeline.cancelled || task.cancelRequested) return;
            reviewPipeline.audits.forEach((event) => this.addLog(event));
            const coordination = reviewPipeline.coordination;
            transitionTask(task, coordination.taskStatus);
            task.pauseReason = coordination.pauseReason;
            this.pushMessage(task, {
              role: "assistant",
              kind: "event",
              content: coordination.eventMessage,
            });
            this.persist();
          } catch (reviewError) {
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
          step.result.facts.terminalReleased = false;
          step.progressMessage = "终端执行通道待恢复";
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
          await this.routeAutomaticAdjustment(taskId, { transportRecovery: true });
        }
      }
    },

    async provideUserInput(taskId: string, rawValues: Record<string, string>) {
      const request = this.pendingUserInputs.find((item) => item.taskId === taskId);
      const task = this.tasks.find((item) => item.id === taskId);
      const step = task?.plan.find((item) => item.id === request?.stepId);
      if (!request || !task || !step) return false;
      const targetServerId = executionServerId(task);

      const missing = request.fields.find((field) => field.required && !String(rawValues[field.key] ?? "").trim());
      if (missing) {
        request.error = `请填写必填参数“${missing.label}”`;
        return false;
      }
      const invalidNumber = request.fields.find((field) => field.type === "number" && String(rawValues[field.key] ?? "").trim()
        && !Number.isFinite(Number(rawValues[field.key])));
      if (invalidNumber) {
        request.error = `参数“${invalidNumber.label}”必须是有效数字`;
        return false;
      }

      const values: Record<string, string | number> = {};
      let credentialChanged = false;
      try {
        this.credentialError = "";
        task.submittedInputs ??= {};
        task.submittedSecretBindings ??= {};
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
              task.confirmedSecretKeys ??= [];
              if (!task.confirmedSecretKeys.includes(key)) task.confirmedSecretKeys.push(key);
              task.submittedSecretBindings![key] = {
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
            delete task.submittedInputs[credentialPair.usernameField.key];
            if (writes.length) credentialChanged = true;
          }
        }
        for (const field of request.fields) {
          if (handledCredentialFields.has(field.key)) continue;
          const supplied = String(rawValues[field.key] ?? "");
          const raw = field.type === "password" ? supplied : supplied.trim();
          if (!raw.trim()) continue;
          if (field.type === "password") {
            const secretKey = field.key.toUpperCase();
            const valueId = secretValueId(targetServerId, secretKey);
            if (this.secretValues[valueId] !== raw) credentialChanged = true;
            // Commit to the system keychain before advertising the metadata in
            // memory/localStorage. A failed keychain write must leave the input
            // card open instead of creating a phantom "saved" credential.
            await backend.saveCredential("secret", valueId, raw);
            this.secretValues[valueId] = raw;
            const metadata = this.secretMetadata.find((item) => item.key === secretKey && item.serverId === targetServerId);
            if (!metadata) {
              this.secretMetadata.push({ key: secretKey, description: field.description, scope: "server", serverId: targetServerId });
            } else if (metadata.description !== field.description) {
              metadata.description = field.description;
            }
            task.confirmedSecretKeys ??= [];
            if (!task.confirmedSecretKeys.includes(secretKey)) task.confirmedSecretKeys.push(secretKey);
            task.submittedSecretBindings[secretKey] = {
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
            task.submittedInputs[field.key] = {
              value,
              label: field.label,
              description: field.description,
              type: field.type,
              groupId: request.callId,
              groupTitle: request.title,
              submittedAt,
            };
          }
        }
        if (credentialChanged) markTaskCredentialRevision(this.tasks, targetServerId);
      } catch (error) {
        this.credentialError = String(error);
        request.error = `保存输入失败：${this.credentialError}`;
        this.persist(true);
        return false;
      }

      // Persist metadata and non-sensitive companion inputs before advancing
      // the task. This closes the window where a refresh after submission left
      // a keychain value with no visible row in Sensitive Information.
      this.persist(true);

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
        isCancelled: () => task.cancelRequested === true,
        onStart: () => {
          transitionTask(task, "running");
          this.pushMessage(task, {
            role: "user",
            kind: "event",
            content: `已提交参数：${request.fields.filter((field) => field.key in values).map((field) => field.label).join("、")}。`,
          });
        },
      });
      if (lifecycle.cancelled || task.cancelRequested) return false;
      transitionTask(task, lifecycle.taskStatus);
      task.pauseReason = lifecycle.pauseReason;
      this.pushMessage(task, { role: "assistant", kind: "event", content: "用户输入已安全确认，正在基于这些参数继续任务。" });
      this.persist();
      if (lifecycle.shouldAdvance) await this.advanceTask(taskId);
      if (task.permission === "managed" && ["needs_adjustment", "awaiting_continuation"].includes(task.status)) {
        void this.queueManagedAdjustment(task.id, 5);
      }
      return true;
    },

    async provideSecret(value: string) {
      const request = this.pendingSecret;
      if (!request || !value) return false;
      const task = this.tasks.find((item) => item.id === request.taskId);
      const step = task?.plan.find((item) => item.id === request.stepId);
      if (!task || !step) return false;
      const targetServerId = executionServerId(task);
      const valueId = secretValueId(targetServerId, request.key);
      const credentialChanged = this.secretValues[valueId] !== value;
      this.credentialError = "";
      request.error = undefined;
      try {
        // The keychain is the source of truth. Do not expose metadata or an
        // in-memory value until durable storage has accepted the credential.
        await backend.saveCredential("secret", valueId, value);
      } catch (error) {
        this.credentialError = String(error);
        request.error = `安全保存失败：${this.credentialError}`;
        this.persist(true);
        return false;
      }
      this.secretValues[valueId] = value;
      if (credentialChanged) markTaskCredentialRevision(this.tasks, targetServerId);
      if (!this.secretMetadata.some((item) => item.key === request.key && item.serverId === targetServerId)) {
        this.secretMetadata.push({ key: request.key, description: request.description, scope: "server", serverId: targetServerId });
      }
      this.pendingSecret = null;
      task.confirmedSecretKeys ??= [];
      if (!task.confirmedSecretKeys.includes(request.key)) task.confirmedSecretKeys.push(request.key);
      resumeStepAfterSecret(step);
      transitionTask(task, "running");
      this.pushMessage(task, { role: "user", kind: "event", content: `已安全提供“${request.label}”，正在解锁并继续当前步骤。` });
      this.persist();
      await this.runStep(request.taskId, request.stepId);
      if (task.permission === "managed" && ["needs_adjustment", "awaiting_continuation"].includes(task.status)) {
        void this.queueManagedAdjustment(task.id, 5);
      }
      return true;
    },

    addSecretMetadata(key: string, description: string, value: string, serverId: string) {
      const normalized = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!normalized || !serverId || this.secretMetadata.some((item) => item.key === normalized && item.serverId === serverId)) return;
      this.secretMetadata.push({ key: normalized, description: description.trim() || "敏感变量", scope: "server", serverId });
      if (value) this.secretValues[secretValueId(serverId, normalized)] = value;
      markTaskCredentialRevision(this.tasks, serverId);
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
      markTaskCredentialRevision(this.tasks, serverId);
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
      markTaskCredentialRevision(this.tasks, serverId);
      this.persist(true);
    },

    async saveSecretSettings() {
      await this.hydrateCredentials();
      if (!this.credentialsHydrated) {
        throw new Error(this.credentialError || "系统凭据尚未完整加载，已取消保存以避免误删钥匙串数据");
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
        .forEach((serverId) => markTaskCredentialRevision(this.tasks, serverId));
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
        provider: "OpenAI Compatible",
        model: "",
        endpoint: "",
        enabled: true,
        hasApiKey: false,
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
      const activeServer = this.servers.find((item) => item.id === serverId);
      const prompt = activeServer ? `${activeServer.username}@${activeServer.host}:~$` : "local:~$";
      appendTerminalBlock(this.terminalLines, `${prompt} ${command}`);
      const server = this.servers.find((item) => item.id === serverId);
      const password = serverId ? this.serverPasswords[serverId] : undefined;
      const connection = server && password
        ? { host: server.host, port: server.port, username: server.username, password }
        : undefined;
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

    async saveModels() {
      this.aiGenerationSettings = normalizeAiGenerationSettings(this.aiGenerationSettings);
      this.models = this.models.filter((model) => model.provider !== "Built-in" && model.id !== "model-local");
      const credentials = this.models.map(async (model) => {
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
      await this.refreshModelAvailability();
    },

    async refreshModelAvailability() {
      await this.hydrateCredentials();
      await Promise.all(this.models.map(async (model) => {
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
