import type {
  AgentSessionContext,
  ExecutionPersistence,
  ExecutionScope,
  ExecutionScopeEvidence,
  PlanStep,
  RuntimeClass,
} from "@/types";
import { shellStartupValidationScope } from "@/features/agent/shellStartupConfig";

const VALID_SCOPES = new Set<ExecutionScope>([
  "agent_session",
  "isolated_exec",
  "fresh_interactive_shell",
  "fresh_login_shell",
  "managed_service",
  "user_action",
]);

const VALIDATION_SCOPES = new Set<ExecutionScope>([
  "isolated_exec",
  "fresh_interactive_shell",
  "fresh_login_shell",
]);

const SAFE_CONTEXT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_CONTEXT_NAME = /(?:PASSWORD|PASSWD|TOKEN|SECRET|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY|_PWD$)/i;

export function defaultAgentSessionContext(): AgentSessionContext {
  return { environment: {}, sourceFiles: [], shell: "bash", revision: 0 };
}

export function mergeAgentSessionContext(
  current: AgentSessionContext,
  change: Partial<AgentSessionContext>,
): AgentSessionContext {
  const merged: AgentSessionContext = {
    cwd: change.cwd === undefined ? current.cwd : change.cwd,
    environment: { ...current.environment, ...(change.environment ?? {}) },
    sourceFiles: change.sourceFiles === undefined
      ? [...current.sourceFiles]
      : [...new Set(change.sourceFiles)],
    shell: change.shell ?? current.shell,
    revision: current.revision,
  };
  validatePlanStepExecutionScope({
    id: "agent-context-update",
    kind: "observe",
    title: "AgentSessionContext update",
    description: "structured Agent context update",
    command: "true",
    expected: "Agent task context updated",
    validation: "",
    risk: "low",
    status: "pending",
    executionScope: "agent_session",
    sessionContextChange: merged,
  });
  return merged;
}

function normalizeRuntimeClass(value: RuntimeClass | undefined, scope: ExecutionScope): RuntimeClass {
  if (value === "bounded" || value === "progressive" || value === "persistent_service") return value;
  return scope === "managed_service" ? "persistent_service" : "bounded";
}

export function normalizePlanStepExecutionScope(step: PlanStep): PlanStep {
  const executionScope = VALID_SCOPES.has(step.executionScope as ExecutionScope)
    ? step.executionScope as ExecutionScope
    : "isolated_exec";
  const startupValidationScope = shellStartupValidationScope(step);
  const validationScope = step.kind === "observe"
    ? undefined
    : startupValidationScope
      ?? (VALIDATION_SCOPES.has(step.validationScope as ExecutionScope)
        ? step.validationScope as ExecutionScope
        : "isolated_exec");
  return {
    ...step,
    executionScope,
    validationScope,
    runtimeClass: normalizeRuntimeClass(step.runtimeClass, executionScope),
  };
}

export function validatePlanStepExecutionScope(step: PlanStep) {
  const normalized = normalizePlanStepExecutionScope(step);
  const semantics = `${normalized.title}\n${normalized.description}\n${normalized.expected}`;
  if (normalized.executionScope === "user_action" && normalized.status === "running") {
    throw new Error("用户操作步骤不得由 Agent 自动执行");
  }
  if (normalized.kind === "change" && !VALIDATION_SCOPES.has(normalized.validationScope!)) {
    throw new Error("变更步骤的 validation 必须在独立或全新 Shell 中执行");
  }
  if (/(?:当前|已打开|原有).{0,12}(?:Shell|会话)|(?:current|existing)\s+(?:shell|session)/i.test(semantics)
      && normalized.executionScope !== "user_action") {
    throw new Error("修改用户已打开 Shell 必须规划为 user_action，Agent 不得注入用户 PTY");
  }
  const expectsLoginShell = /(?:新|全新).{0,8}(?:登录|login).{0,8}(?:Shell|会话)|fresh\s+login\s+shell/i.test(semantics);
  const expectsInteractiveShell = /(?:新|全新).{0,8}(?:交互|interactive).{0,8}(?:Shell|会话)|fresh\s+interactive\s+shell/i.test(semantics);
  if (expectsLoginShell && normalized.validationScope !== "fresh_login_shell") {
    throw new Error("预期结果声明新登录 Shell 生效，validationScope 必须是 fresh_login_shell");
  }
  if (expectsInteractiveShell && normalized.validationScope !== "fresh_interactive_shell") {
    throw new Error("预期结果声明新交互 Shell 生效，validationScope 必须是 fresh_interactive_shell");
  }
  if (
    (normalized.validationScope === "fresh_login_shell" || normalized.validationScope === "fresh_interactive_shell")
    && /(?:^|[;\n]\s*)(?:source|\.)\s+[^;\n]+/m.test(normalized.validation)
  ) {
    throw new Error("新 Shell 自动加载验收不得在 validation 中显式 source 被验证文件");
  }
  const change = normalized.sessionContextChange;
  if (change && normalized.executionScope !== "agent_session") {
    throw new Error("只有 agent_session 步骤可以更新 AgentSessionContext");
  }
  if (change?.cwd !== undefined
    && (typeof change.cwd !== "string" || !change.cwd.startsWith("/") || change.cwd.includes("\0") || change.cwd.length > 4096)) {
    throw new Error("AgentSessionContext cwd 必须是有界的绝对路径");
  }
  if (change?.shell !== undefined && !["bash", "sh", "zsh"].includes(change.shell)) {
    throw new Error("AgentSessionContext shell 不合法");
  }
  const environment = change?.environment ?? {};
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("AgentSessionContext environment 必须是对象");
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!SAFE_CONTEXT_NAME.test(name) || SENSITIVE_CONTEXT_NAME.test(name)) {
      throw new Error(`AgentSessionContext 环境变量不允许持久化：${name}`);
    }
    if (typeof value !== "string" || value.length > 4096 || /\0|\$\{secret\./i.test(value)) {
      throw new Error(`AgentSessionContext 环境变量值不安全：${name}`);
    }
  }
  const sourceFiles = change?.sourceFiles ?? [];
  if (!Array.isArray(sourceFiles) || sourceFiles.length > 32
    || sourceFiles.some((file) => typeof file !== "string"
      || !file.startsWith("/") || file.includes("\0") || file.length > 4096)) {
    throw new Error("AgentSessionContext sourceFiles 必须是有界的绝对路径列表");
  }
  return normalized;
}

export function persistenceForScope(scope: ExecutionScope): ExecutionPersistence {
  if (scope === "agent_session") return "agent_task";
  if (scope === "fresh_interactive_shell" || scope === "fresh_login_shell") return "new_shells";
  if (scope === "managed_service") return "service";
  if (scope === "user_action") return "host";
  return "command";
}

export function doesNotProveForScope(scope: ExecutionScope) {
  if (scope === "agent_session") return ["user_shell_loaded", "fresh_interactive_shell_loaded", "fresh_login_shell_loaded"];
  if (scope === "isolated_exec") return ["agent_session_state", "user_shell_loaded", "new_shell_auto_load"];
  if (scope === "fresh_interactive_shell") return ["user_existing_shell_loaded", "fresh_login_shell_loaded"];
  if (scope === "fresh_login_shell") return ["user_existing_shell_loaded", "fresh_interactive_non_login_shell_loaded"];
  return [];
}

export function buildExecutionScopeEvidence(input: {
  targetId: string;
  scope: ExecutionScope;
  sessionId?: string;
  generation?: number;
  shell?: string;
  cwd?: string;
}): ExecutionScopeEvidence {
  return {
    ...input,
    persistence: persistenceForScope(input.scope),
    doesNotProve: doesNotProveForScope(input.scope),
  };
}

export function buildStepScopeEvidence(
  step: PlanStep,
  source: "main" | "validation",
  target: { targetId: string; sessionId?: string; generation?: number; shell?: string; cwd?: string },
) {
  const normalized = normalizePlanStepExecutionScope(step);
  const scope = source === "validation"
    ? normalized.validationScope ?? "isolated_exec"
    : normalized.executionScope ?? "isolated_exec";
  return buildExecutionScopeEvidence({ ...target, scope });
}
