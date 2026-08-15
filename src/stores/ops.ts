import { defineStore } from "pinia";
import { backend, buildExecutionSummary, normalizePlanPreconditions } from "@/services/backend";
import {
  classifyStepResult,
  ensureStepValidator,
  isMutatingStepCommand,
  requiresReadOnlyDiagnosis,
} from "@/features/agent/evidenceReview";
import {
  applyCommandFailure,
  applyValidatedStepResult,
} from "@/features/agent/commandStepResult";
import { applyPeriodicReviewAdjustment } from "@/features/agent/reviewCoordination";
import {
  createToolOverrides,
  parseToolOverrides,
  resetToolDefinition,
  resolveToolRegistry,
} from "@/features/tools/toolRegistry";
import { normalizeToolDefinition, validateToolDefinition } from "@/features/tools/toolValidation";
import { executeToolCall as executeRegisteredToolCall } from "@/features/tools/toolExecutor";
import {
  buildAgentContext,
  extractKnownExecutionFacts,
  trimEvidence,
} from "@/features/agent/agentContext";
import { requiresStepApproval } from "@/features/agent/approvalPolicy";
import { transitionTask } from "@/features/agent/taskMachine";
import { transitionStep } from "@/features/agent/stepMachine";
import {
  cancelStep,
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
  buildPeriodicReviewAudit,
} from "@/features/agent/reviewAudit";
import {
  findUnresolvedBlockingStep,
  latestTaskRequirement,
  resolveTaskProgression,
} from "@/features/agent/taskProgression";
import {
  planTaskAdjustment,
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
  requestStepApproval,
} from "@/features/agent/stepApproval";
import {
  runCommandLifecycle,
  runValidationLifecycle,
} from "@/features/agent/executionLifecycle";
import { prepareStepExecution } from "@/features/agent/executionPreparation";
import {
  buildCommandResultAudit,
  buildValidationResultAudit,
} from "@/features/agent/executionAudit";
import { resolveStepDispatch } from "@/features/agent/executionDispatch";
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
  Metrics,
  ModelAvailability,
  ModelProfile,
  OpsTask,
  PermissionLevel,
  PlanStep,
  ServerProfile,
  SecretMetadata,
  TaskMessage,
} from "@/types";
import type {
  FileStructureRequest,
  FileStructureResult,
  ToolCall,
} from "@/features/tools/types";
import { useFileWorkspaceStore } from "@/features/files/fileWorkspaceStore";
import { useAgentWorkspaceStore } from "@/features/agent/agentWorkspaceStore";
import { useTerminalSessionStore } from "@/features/terminal/terminalSessionStore";

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let persistTimer: number | undefined;
let credentialHydration: Promise<void> | undefined;

const emptyServerInfo = {
  os: "等待采集…",
  kernel: "—",
  cpu: "—",
  cores: 0,
  memoryGb: 0,
  diskGb: 0,
  uptime: "—",
};

const defaultModels: ModelProfile[] = [
  {
    id: "model-deepseek",
    name: "DeepSeek V4 Flash",
    provider: "DeepSeek",
    model: "deepseek-v4-flash",
    endpoint: "https://api.deepseek.com",
    enabled: true,
    hasApiKey: false,
  },
];

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

function readSaved<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function initialServers() {
  return readSaved<ServerProfile[]>("opsark.servers", []);
}

function initialModels() {
  const saved = readSaved<ModelProfile[]>("opsark.models", defaultModels)
    .filter((model) => model.provider !== "Built-in" && model.id !== "model-local");
  return saved.length ? saved : defaultModels.map((model) => ({ ...model }));
}

function initialTasks() {
  return readSaved<OpsTask[]>("opsark.tasks", []).map((task) => {
    task.confirmedSecretKeys = [];
    task.plan = task.plan.map(ensureStepValidator);
    task.planHistory?.forEach((round) => {
      round.plan = round.plan.map(ensureStepValidator);
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

export const useOpsStore = defineStore("ops", {
  state: () => ({
    servers: initialServers(),
    tasks: initialTasks(),
    models: initialModels(),
    aiGenerationSettings: initialAiGenerationSettings(),
    tools: initialTools(),
    toolSaveError: "",
    modelAvailability: {} as Record<string, ModelAvailability>,
    logs: readSaved<AuditEvent[]>("opsark.logs", []),
    metrics: {
      cpu: 32,
      memory: 56,
      disk: 68,
      networkIn: 5.2,
      networkOut: 1.8,
      sampledAt: now(),
    } as Metrics,
    activeTaskId: null as string | null,
    serverPasswords: {} as Record<string, string>,
    modelApiKeys: {} as Record<string, string>,
    connectedServerIds: [] as string[],
    secretMetadata: readSaved<SecretMetadata[]>("opsark.secretMetadata", [
      { key: "DB_PASSWORD", description: "数据库密码", scope: "server", serverId: "srv-tencent-test" },
      { key: "GIT_TOKEN", description: "代码仓库访问令牌", scope: "global" },
    ]),
    secretValues: {} as Record<string, string>,
    pendingSecret: null as { taskId: string; stepId: string; key: string } | null,
    terminalLines: [
      "Opsark Secure Terminal",
      "连接服务器后可直接使用交互式 PTY；智能任务命令也会在此显示。",
    ],
    isCollecting: false,
    metricsLoading: false,
    credentialsHydrated: false,
    credentialsLoading: false,
    credentialError: "",
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
  },

  actions: {
    persist(immediate = false) {
      if (persistTimer !== undefined) window.clearTimeout(persistTimer);
      const store = this;
      const write = () => {
        localStorage.setItem("opsark.servers", JSON.stringify(store.servers));
        localStorage.setItem("opsark.tasks", JSON.stringify(store.tasks));
        localStorage.setItem("opsark.models", JSON.stringify(store.models));
        localStorage.setItem("opsark.aiGenerationSettings", JSON.stringify(store.aiGenerationSettings));
        localStorage.setItem("opsark.toolOverrides", JSON.stringify(createToolOverrides(store.tools)));
        localStorage.setItem("opsark.logs", JSON.stringify(store.logs.slice(0, 500)));
        localStorage.setItem("opsark.secretMetadata", JSON.stringify(store.secretMetadata));
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
        const secretCredentials = await Promise.allSettled(
          this.secretMetadata.map(async (secret) => ({
            id: secret.key,
            value: await backend.loadCredential("secret", secret.key),
          })),
        );
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
          }
        }
        const rejected = [...serverCredentials, ...modelCredentials, ...secretCredentials]
          .find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") this.credentialError = String(rejected.reason);
        this.credentialsHydrated = true;
        this.credentialsLoading = false;
      })().finally(() => {
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
      this.logs = prependAuditEvent(
        this.logs,
        createAuditEvent(event, uid("log"), now()),
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
          server.info = await backend.collectServerInfo();
          server.status = "online";
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
      this.serverPasswords[serverId] = password;
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
      delete this.serverPasswords[serverId];
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

    async executeToolCall(serverId: string, call: ToolCall) {
      const connection = this.getRuntimeConnection(serverId);
      if (!connection) throw new Error("请先连接真实服务器");
      const startedAt = performance.now();
      const result = await executeRegisteredToolCall(call, this.tools, {
        getRemoteFileStructure: (request) => backend.getRemoteFileStructure(connection, request),
      });
      const fileResult = result.data as FileStructureResult | undefined;
      this.addLog({
        category: "tool",
        level: result.success ? (fileResult?.warnings.length ? "warning" : "success") : "error",
        title: result.success ? "工具调用完成" : "工具调用失败",
        detail: JSON.stringify({
          toolId: call.toolId,
          callId: call.id,
          arguments: call.arguments,
          result: result.success ? {
            totalNodes: fileResult?.totalNodes,
            truncated: result.truncated,
            warnings: fileResult?.warnings,
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

    removeServer(serverId: string) {
      this.servers = this.servers.filter((server) => server.id !== serverId);
      delete this.serverPasswords[serverId];
      this.connectedServerIds = this.connectedServerIds.filter((id) => id !== serverId);
      useFileWorkspaceStore().removeServer(serverId);
      useAgentWorkspaceStore().removeServer(serverId);
      void backend.deleteCredential("server", serverId);
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
        createdAt: now(),
        updatedAt: now(),
        adjustmentCount: 0,
        confirmedSecretKeys: [],
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
        const terminalSessions = useTerminalSessionStore();
        const agentPaneId = terminalSessions.resolveTaskPaneId(task.serverId, task.id);
        if (agentPaneId) {
          const timestamp = new Date(created.createdAt).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          });
          terminalSessions.publishAgentOutput(agentPaneId, `[${timestamp}] ${message.content}\n`);
        }
      }
      return created;
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
      const terminalSessions = useTerminalSessionStore();
      if (!terminalSessions.resolveTaskPaneId(serverId, task.id)) {
        terminalSessions.bindAgentTask(serverId, task.id);
      }
      const requestsCurrentRoundAdjustment =
        task.status === "needs_adjustment"
        && /^(?:请)?(?:进行|生成|重新)?(?:一次|一下)?(?:调整|调整计划|重试)(?:吧|。)?$/i.test(content);
      if (requestsCurrentRoundAdjustment) {
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
      const previousExecution = previousRequirement
        ? {
            requirement: previousRequirement.content,
            status: task.status,
            summary: task.summary,
            executionConstraints: task.executionConstraints,
            steps: task.plan.map(({ title, command, expected, status, output, review, result, evidence }) => ({
              title,
              command,
              expected,
              status,
              output: trimEvidence(output),
              review,
              result,
              evidence: evidence?.map(({ type, source, facts }) => ({ type, source, facts })),
            })),
          }
        : undefined;
      if (task.messages.some((message) => message.role === "user" && message.kind === "message")) {
        const previousRequirementIndex = task.messages
          .map((message, index) => ({ message, index }))
          .reverse()
          .find(({ message }) => message.role === "user" && message.kind === "message")?.index ?? -1;
        const previousRequirement = task.messages[previousRequirementIndex];
        task.planHistory ??= [];
        task.planHistory.push({
          id: uid("round"),
          requirement: previousRequirement?.content ?? task.title,
          status: task.status,
          plan: task.plan.map((step) => ({ ...step })),
          response: task.messages
            .slice(previousRequirementIndex + 1)
            .find((message) => message.role === "assistant" && message.kind === "message"),
          records: task.messages
            .slice(previousRequirementIndex + 1)
            .filter((message) => message.kind === "event")
            .map((message) => ({ ...message })),
          summary: task.summary,
          pauseReason: task.pauseReason,
          executionConstraints: task.executionConstraints,
          createdAt: previousRequirement?.createdAt ?? task.updatedAt,
          completedAt: now(),
        });
        this.pushMessage(task, {
          role: "system",
          kind: "event",
          content: "开始处理本任务中的新一轮需求；上一轮执行记录已保留在对话与日志中。",
        });
      }
      task.permission = permission;
      task.modelId = modelId;
      task.title = task.title === "新任务" ? content.slice(0, 22) : task.title;
      transitionTask(task, "planning");
      task.plan = [];
      task.summary = undefined;
      task.pauseReason = undefined;
      task.executionConstraints = undefined;
      task.confirmedSecretKeys = [];
      task.adjustmentCount = 0;
      task.discoveryRefined = false;
      task.cancelRequested = false;
      task.currentExecutionId = undefined;
      this.activeTaskId = task.id;
      this.pushMessage(task, { role: "user", kind: "message", content });
      const understandingMessage = this.pushMessage(task, {
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
        const context = JSON.stringify(buildAgentContext({
          server,
          metrics: this.metrics,
          permission,
          terminalReference: terminalReference || undefined,
          conversationHistory: priorConversation,
          previousExecution,
          knownExecutionFacts: extractKnownExecutionFacts(task),
          tools: this.tools,
          secretMetadata: this.secretMetadata,
          serverId,
        }));
        const processed = await backend.processRequirement(
          content,
          {
            apiKey: apiKey ?? "",
            endpoint: model.endpoint,
            model: model.model,
            context,
            generationSettings: this.aiGenerationSettings,
          },
        );
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
        const requiresReadOnlyPlan =
          processed.constraints?.changePolicy === "read_only"
          || requiresReadOnlyDiagnosis(content);
        task.plan = requiresReadOnlyPlan
          ? processed.plan.filter((step) => !isMutatingStepCommand(step.command)).map(ensureStepValidator)
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
            context: JSON.parse(context),
            plan: task.plan,
          }, null, 2),
          serverId,
          taskId: task.id,
        });
        this.pushMessage(task, {
          role: "assistant",
          kind: "message",
          content: permission === "managed"
            ? `已生成 ${task.plan.length} 个执行步骤，完全托管模式已自动批准计划并开始运行。`
            : permission === "autonomous"
              ? `已生成 ${task.plan.length} 个执行步骤，自动执行模式已开始运行。`
            : `已生成 ${task.plan.length} 个执行步骤。请检查风险、命令和预期结果后确认计划。`,
        });
        this.persist();
        if (task.cancelRequested) {
          transitionTask(task, "cancelled");
          return;
        }
        if (["autonomous", "managed"].includes(permission)) {
          await this.approvePlan(task.id, true);
        }
      } catch (error) {
        if (task.cancelRequested) return;
        transitionTask(task, "failed");
        task.summary = `本轮计划生成失败：${String(error)}`;
        this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
        this.persist();
      }
    },

    async adjustTask(taskId: string) {
      await this.hydrateCredentials();
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || !["needs_adjustment", "failed"].includes(task.status)) return;
      task.adjustmentCount ??= 0;
      if (task.adjustmentCount >= 1) {
        await this.finalizeFailedTask(
          task.id,
          "自动调整已达到 1 次上限。为避免反复重拟计划，本任务已停止。",
        );
        return;
      }
      task.adjustmentCount += 1;
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
        });
        task.plan = adjustment.plan;
        transitionTask(task, "awaiting_plan_approval");
        this.pushMessage(task, {
          role: "assistant",
          kind: "message",
          content: task.permission === "managed"
            ? `已根据失败结果生成 ${adjustment.replacement.length} 个调整步骤，完全托管模式将自动批准并继续。`
            : `已根据失败结果生成 ${adjustment.replacement.length} 个调整步骤，请重新审查并批准。`,
        });
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
      } catch (error) {
        const reason = `调整计划生成失败：${String(error)}`;
        this.pushMessage(task, { role: "system", kind: "event", content: reason });
        transitionTask(task, "needs_adjustment");
        task.pauseReason = `${reason}。原执行证据和未完成目标已保留，可再次生成解决方案。`;
        task.summary = undefined;
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
      if (task.status === "awaiting_plan_approval" && task.permission === "managed") {
        await this.approvePlan(task.id, true);
      }
    },

    async requestAdjustment(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || !["needs_adjustment", "failed"].includes(task.status)) return;
      if ((task.adjustmentCount ?? 0) >= 1) {
        task.adjustmentCount = 0;
        transitionTask(task, "needs_adjustment");
        task.summary = undefined;
        this.pushMessage(task, {
          role: "user",
          kind: "event",
          content: "用户明确请求再次生成解决方案，开始新的人工调整周期。",
        });
      }
      await this.adjustTask(taskId);
    },

    async approvePlan(taskId: string, automatic = false) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || task.status !== "awaiting_plan_approval") return;
      task.plan = normalizePlanPreconditions(task.plan);
      transitionTask(task, "running");
      task.pauseReason = undefined;
      this.pushMessage(task, {
        role: automatic ? "system" : "user",
        kind: "event",
        content: automatic
          ? task.permission === "managed"
            ? "完全托管模式已自动批准计划，开始执行。"
            : "自动执行模式已批准计划，开始执行。"
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
      this.pushMessage(task, { role: "assistant", kind: "summary", content: task.summary });
      this.persist();
    },

    async terminateTask(taskId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (!task || ["completed", "failed", "cancelled"].includes(task.status)) return;
      task.cancelRequested = true;
      this.pushMessage(task, { role: "user", kind: "event", content: "正在终止本次业务及其当前远程进程…" });
      const executionId = task.currentExecutionId;
      const server = this.servers.find((item) => item.id === task.serverId);
      const password = this.serverPasswords[task.serverId];
      if (executionId && server && password) {
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
      const progression = resolveTaskProgression(task);
      if (progression.kind !== "execute-step") {
        if (progression.kind === "refine-discovery") {
          task.discoveryRefined = true;
          transitionTask(task, "planning");
          const requirement = latestTaskRequirement(task);
          const model = this.models.find((item) => item.id === task.modelId);
          const apiKey = this.modelApiKeys[task.modelId];
          const server = this.servers.find((item) => item.id === task.serverId);
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
          this.pushMessage(task, {
            role: "assistant",
            kind: "message",
            content: refinement.eventMessage,
          });
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
        const completionPipeline = await runTaskCompletion({
          task,
          model,
          apiKey,
          serverId: task.serverId,
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
          serverId: task.serverId,
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
    },

    async runToolStep(taskId: string, stepId: string, call: ToolCall) {
      const task = this.tasks.find((item) => item.id === taskId);
      const step = task?.plan.find((item) => item.id === stepId);
      if (!task || !step) return;
      const lifecycle = await runToolStepLifecycle({
        step,
        call,
        execute: () => this.executeToolCall(task.serverId, call),
        createEvidenceId: () => uid("evidence-tool"),
        now,
        isCancelled: () => task.cancelRequested === true,
        onStart: (eventMessage) => {
          transitionTask(task, "running");
          this.pushMessage(task, { role: "assistant", kind: "event", content: eventMessage });
          this.persist();
        },
      });
      if (lifecycle.cancelled || task.cancelRequested) return;
      transitionTask(task, lifecycle.taskStatus);
      task.pauseReason = lifecycle.pauseReason;
      this.pushMessage(task, {
        role: "assistant",
        kind: "event",
        content: lifecycle.eventMessage,
      });
      this.persist();
      if (!lifecycle.shouldAdvance) return;
      await this.advanceTask(taskId);
    },

    async runStep(taskId: string, stepId: string) {
      const task = this.tasks.find((item) => item.id === taskId);
      const step = task?.plan.find((item) => item.id === stepId);
      if (!task || !step) return;
      const dispatch = resolveStepDispatch(
        step,
        task.confirmedSecretKeys ?? [],
        uid("tool-call"),
      );
      const secretKey = dispatch.kind === "await-secret" ? dispatch.key : undefined;
      const metadata = secretKey
        ? this.secretMetadata.find((item) => item.key === secretKey)
        : undefined;
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
          this.pendingSecret = { taskId, stepId, key: entry.pendingSecretKey };
        }
        this.pushMessage(task, {
          role: "assistant",
          kind: "event",
          content: entry.eventMessage,
        });
        this.persist();
        return;
      }
      transitionTask(task, entry.taskStatus);
      this.pushMessage(task, { role: "assistant", kind: "event", content: entry.eventMessage });
      appendTerminalBlock(this.terminalLines, entry.terminalHeader);
      const terminalSessions = useTerminalSessionStore();
      const targetPaneId = terminalSessions.resolveTaskPaneId(task.serverId, task.id)
        ?? terminalSessions.bindAgentTask(task.serverId, task.id);
      const publishAgentOutput = (data: string) => {
        if (targetPaneId) terminalSessions.publishAgentOutput(targetPaneId, data);
      };
      publishAgentOutput(`\n\u001b[36m[Agent]\u001b[0m ${entry.terminalHeader}\n`);
      this.persist();

      try {
        const server = this.servers.find((item) => item.id === task.serverId);
        const password = this.serverPasswords[task.serverId];
        const runtimeModel = this.models.find((item) => item.id === task.modelId);
        const runtimeApiKey = this.modelApiKeys[task.modelId];
        const prepared = prepareStepExecution({
          step,
          server,
          serverPassword: password,
          model: runtimeModel,
          modelApiKey: runtimeApiKey,
          secretValues: this.secretValues,
        });
        step.command = prepared.commandTemplate;
        step.validation = prepared.validationTemplate;
        const executionId = uid("exec");
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
          secretValues: this.secretValues,
          isCancelled: () => task.cancelRequested === true,
          onExecutionChange: (activeExecutionId) => {
            task.currentExecutionId = activeExecutionId;
          },
          onProgress: (safeChunk, streamedOutput) => {
            step.output = `$ ${step.command}\n${streamedOutput}`;
            appendTerminalStream(this.terminalLines, safeChunk);
            publishAgentOutput(safeChunk);
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
              serverId: task.serverId,
              taskId,
            }));
          },
          onError: (title, detail) => {
            this.addLog({
              category: "system",
              level: "warning",
              title,
              detail,
              serverId: task.serverId,
              taskId,
            });
          },
        });
        const result = commandLifecycle.result;
        const streamedOutput = commandLifecycle.streamedOutput;
        const monitorState = commandLifecycle.monitorState;
        const monitorDecision = monitorState.decision;
        const monitorValidationPassed = monitorState.validationPassed;
        const monitorRound = monitorState.reviewRound;
        if (task.cancelRequested) return;
        const safeOutput = result.output;
        step.output = safeOutput;
        appendCommandCompletion(this.terminalLines, safeOutput, Boolean(streamedOutput));
        const completionLines: string[] = [];
        appendCommandCompletion(completionLines, safeOutput, Boolean(streamedOutput));
        if (completionLines.length) publishAgentOutput(`${completionLines.join("\n")}\n`);
        this.addLog(buildCommandResultAudit({
          stepTitle: step.title,
          commandTemplate: prepared.commandTemplate,
          output: safeOutput,
          success: result.success,
          serverId: task.serverId,
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
          transitionTask(task, coordination.taskStatus);
          task.pauseReason = coordination.pauseReason;
          this.pushMessage(task, {
            role: "assistant",
            kind: "event",
            content: coordination.eventMessage,
          });
          this.persist();
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
            serverId: task.serverId,
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

        transitionStep(step, "validating");
        transitionTask(task, "validating");
        this.persist();
        let validationStreamed = false;
        publishAgentOutput(`\n\u001b[36m[Agent 验证]\u001b[0m ${step.validation}\n`);
        const validationLifecycle = await runValidationLifecycle({
          step,
          validation: prepared.resolvedValidation,
          initialExecutionId: uid("validation"),
          createRetryExecutionId: () => uid("validation-retry"),
          connection: prepared.connection,
          secretValues: this.secretValues,
          isCancelled: () => task.cancelRequested === true,
          onExecutionChange: (activeExecutionId) => {
            task.currentExecutionId = activeExecutionId;
          },
          onProgress: (safeChunk) => {
            validationStreamed = true;
            appendTerminalStream(this.terminalLines, safeChunk);
            publishAgentOutput(safeChunk);
          },
          onRetry: (firstValidationOutput) => {
            step.output = appendFirstValidationFailureOutput(step.output, firstValidationOutput);
            this.pushMessage(task, {
              role: "system",
              kind: "event",
              content: `${step.title}的独立网络校验与主结果不一致，正在自动重试一次…`,
            });
            publishAgentOutput("\n\u001b[33m[Agent 验证重试]\u001b[0m\n");
          },
        });
        if (task.cancelRequested) return;
        const validation = validationLifecycle.validation;
        const assembledValidation = assembleFinalValidationOutput(step.output, validation.output);
        step.output = assembledValidation.stepOutput;
        if (assembledValidation.validationOutput) {
          appendTerminalBlock(
            this.terminalLines,
            `验证 › ${step.validation}`,
            assembledValidation.validationOutput,
          );
          if (!validationStreamed) {
            publishAgentOutput(`${assembledValidation.validationOutput}\n`);
          }
        }
        const classified = classifyStepResult(
          step,
          { ...result, output: safeOutput },
          { ...validation, output: assembledValidation.validationOutput },
        );
        applyValidatedStepResult(step, classified);
        this.addLog(buildValidationResultAudit({
          stepTitle: step.title,
          accepted: classified.accepted,
          validator: step.validator,
          result: classified.result,
          validationTemplate: prepared.validationTemplate,
          validationOutput: assembledValidation.validationOutput,
          serverId: task.serverId,
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
          serverId: task.serverId,
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
        const failure = applyStepExecutionException(step, error);
        transitionTask(task, failure.taskStatus);
        task.pauseReason = failure.pauseReason;
        this.pushMessage(task, {
          role: "assistant",
          kind: "event",
          content: failure.eventMessage,
        });
        this.persist();
      }
    },

    async provideSecret(value: string) {
      const request = this.pendingSecret;
      if (!request || !value) return;
      this.secretValues[request.key] = value;
      if (!this.secretMetadata.some((item) => item.key === request.key)) {
        this.secretMetadata.push({ key: request.key, description: "任务执行时请求的敏感变量", scope: "global" });
      }
      this.pendingSecret = null;
      const task = this.tasks.find((item) => item.id === request.taskId);
      const step = task?.plan.find((item) => item.id === request.stepId);
      if (!task || !step) return;
      task.confirmedSecretKeys ??= [];
      if (!task.confirmedSecretKeys.includes(request.key)) task.confirmedSecretKeys.push(request.key);
      resumeStepAfterSecret(step);
      transitionTask(task, "running");
      this.pushMessage(task, { role: "user", kind: "event", content: `已安全提供变量 ${request.key}。` });
      this.persist();
      await this.runStep(request.taskId, request.stepId);
    },

    addSecretMetadata(key: string, description: string, value = "") {
      const normalized = key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!normalized || this.secretMetadata.some((item) => item.key === normalized)) return;
      this.secretMetadata.push({ key: normalized, description: description.trim() || "敏感变量", scope: "global" });
      if (value) this.secretValues[normalized] = value;
      this.persist();
    },

    async renameSecretMetadata(oldKey: string, nextKey: string) {
      const normalized = nextKey.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!normalized || normalized === oldKey) return normalized === oldKey;
      if (this.secretMetadata.some((item) => item.key === normalized)) return false;
      const secret = this.secretMetadata.find((item) => item.key === oldKey);
      if (!secret) return false;
      const value = this.secretValues[oldKey] ?? "";
      if (value) await backend.saveCredential("secret", normalized, value);
      await backend.deleteCredential("secret", oldKey);
      secret.key = normalized;
      if (value) this.secretValues[normalized] = value;
      delete this.secretValues[oldKey];
      this.persist(true);
      return true;
    },

    async removeSecretMetadata(key: string) {
      await backend.deleteCredential("secret", key);
      this.secretMetadata = this.secretMetadata.filter((item) => item.key !== key);
      delete this.secretValues[key];
      this.persist(true);
    },

    async saveSecretSettings() {
      await Promise.all(this.secretMetadata.map((secret) => {
        const value = this.secretValues[secret.key] ?? "";
        return value
          ? backend.saveCredential("secret", secret.key, value)
          : backend.deleteCredential("secret", secret.key);
      }));
      this.persist(true);
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
