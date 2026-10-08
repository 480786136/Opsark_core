import { modelIntegrationConfig } from "@/features/agent/modelIntegration";
import { projectClassifiedRequirementContext } from "@/features/agent/requirementPlanningContext";
import { mergeRequirementExecutionConstraints } from "@/features/agent/taskRequirements";
import { parameterContext, validateRequestParameters } from "@/features/agent/modelParameters";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatCredits } from "@/features/account/credits";
import type { AgentSessionContext, AgentSessionRef, AiGenerationSettings, ExecutionScope, FileEntry, Metrics, ModelDeveloperTrace, ModelIntegration, ModelRequestPreview, ModelValidationResult, ModelServiceError, NextStageDecision, PlanStep, RequirementProcessingResult, ServerInfo, StepReview } from "@/types";
import type { GeneratedSkillDraft, ModelSkillDefinition } from "@/features/skills/types";
import {
  normalizeLongRunningCommandOutput,
  normalizePlanPreconditions,
  normalizeSecretPlaceholders,
  PlanStageConflictError,
  READ_BATCH_STAGE_CONFLICT,
} from "@/features/agent/planNormalizer";

import { buildExecutionSummary } from "@/features/agent/executionSummary";
import {
  normalizeFileStructureRequest,
} from "@/features/tools/fileStructure";
import type { FileStructureRequest, FileStructureScanResult } from "@/features/tools/types";
import {
  analyzePlanStepSafety as analyzePlanStepSafetyLocally,
} from "@/features/agent/planSafety";
import type { PlanStepSafetyAnalysis } from "@/features/agent/planSafety";
import { isTerminalTransportFailure } from "@/features/agent/adjustmentIncident";
import { readRecoveryProtocolError, RecoveryProtocolError } from "./recoveryRules";
import {
  compactProtocolRepairContext, mergeProtocolRepairSteps, planSemanticFingerprint,
  parseRepairContext, protocolFieldValue, protocolRepairAuthority, protocolRepairScopeFingerprint, protocolRepairStopMessage, stableProtocolValue,
} from "./planProtocolRepair";
import type { PlanRepairDiagnostic, ProtocolRepairProgress } from "./planProtocolRepair";
import { candidateRegenerationContext, ensureModelRecoveryContext, isModelRecoveryScopeRejection, isRecoverableModelOutput, outputStrategyFromContext, recoveryFromContext, withModelOutputStrategy } from "./modelRecovery";
import type { ModelRecoveryContext } from "./modelRecovery";
import { legacyModelOperationValue, modelOperationResult, ModelOperationBoundaryError } from "./modelOperationBoundary";
import { cancelDirectExecution, directExecutionId, fileContentIdentity, runDirectExecution } from "./directExecutionLedger";

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export interface RuntimeConnection {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface RuntimeModel extends ModelIntegration {
  /** Local lifecycle guard; never serialized into the model request. */
  assertCurrent?(): void;
  capabilities?: import("@/types").ModelCapabilities;
  requestParameters?: import("@/types").ModelRequestParameters;
  timeoutSeconds?: number;
  logContext?: Record<string, unknown>;
  apiKey: string;
  endpoint: string;
  model: string;
  context: string;
  generationSettings?: AiGenerationSettings;
}

function runtimeWithModelRecovery(runtime: RuntimeModel): RuntimeModel {
  const pending = parseRepairContext(runtime.context).planGenerationRepair as PlanNormalizationRepair | undefined;
  return { ...runtime, context: ensureModelRecoveryContext(runtime.context, pending?.modelRecovery) };
}

export interface DiskLogQuery {
  stream: "events" | "developer-events" | "model-calls";
  cursor?: string;
  limit?: number;
  taskId?: string;
  serverId?: string;
  category?: string;
  operation?: string;
  event?: string;
  level?: string;
  search?: string;
  from?: string;
  to?: string;
}

export interface DiskLogQueryResult<T = unknown> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
  malformedLines: number;
  oversizedLines: number;
}

const MODEL_TRACE_ERROR_PREFIX = "OPSARK_MODEL_TRACE_V1:";

export class ModelInvocationError extends Error {
  developerTrace?: ModelDeveloperTrace;
  modelError?: ModelServiceError;

  constructor(message: string, developerTrace?: ModelDeveloperTrace, modelError?: ModelServiceError) {
    const classified = parseModelServiceError(modelError) ?? parseLegacyModelServiceError(message);
    super(classified ? modelServiceErrorMessage(classified) : message);
    this.name = "ModelInvocationError";
    this.developerTrace = developerTrace;
    this.modelError = classified;
  }
}

const CREDIT_ERROR_CODES = new Set(["INSUFFICIENT_CREDITS", "CREDITS_RECONCILIATION_REQUIRED"]);
const MODEL_RECOVERY_ERROR_CODES = new Set(["MODEL_RESULT_UNAVAILABLE", "MODEL_DISPATCH_UNKNOWN", "MODEL_REQUEST_FAILED", "MODEL_CONNECT_FAILED", "MODEL_AUTH_UNAVAILABLE",
  "MODEL_RECOVERY_BUDGET_EXHAUSTED", "MODEL_RECOVERY_BUDGET_INVALID", "MODEL_REQUEST_CONFLICT", "IDEMPOTENCY_KEY_CONFLICT"]);
const GATEWAY_MODEL_ERROR_CODES = new Set(["MODEL_HTTP_ERROR", "UPSTREAM_SCHEMA_INVALID", "UPSTREAM_HTTP_ERROR", "UPSTREAM_CONNECT_FAILED", "UPSTREAM_CONNECT_TIMEOUT",
  "UPSTREAM_WRITE_FAILED", "UPSTREAM_TIMEOUT", "UPSTREAM_READ_FAILED", "UPSTREAM_RESPONSE_INVALID", "GATEWAY_BUSY",
  "REQUEST_ALREADY_ACCEPTED", "REQUEST_STATE_CONFLICT", "CAPABILITY_REVISION_MISMATCH", "MODEL_PROTOCOL_UNSUPPORTED",
  "INVALID_API_PROTOCOL", "PRESET_PROTOCOL_UNSUPPORTED", "PARAMETER_SEMANTICS_CONFLICT", "PROTOCOL_PARAMETER_UNSUPPORTED",
  "INVALID_RESPONSES_REQUEST", "RESPONSES_STREAM_NOT_SUPPORTED", "PROVIDER_STORAGE_NOT_SUPPORTED", "UPSTREAM_PROTOCOL_MISMATCH", "API_PROTOCOL_MISMATCH", "OUTPUT_CAPABILITY_UNKNOWN", "UNSUPPORTED_MESSAGE", "OFFICIAL_CONTEXT_TOO_LARGE"]);
const COMPATIBILITY_ERROR_CODES = new Set(["MODEL_OUTPUT_TRUNCATED", "MODEL_FORMAT_INVALID", "MODEL_FINISH_UNSUPPORTED",
  "MODEL_SCHEMA_INVALID",
  "MODEL_CAPABILITY_INVALID", "MODEL_PARAMETER_UNSUPPORTED", "MODEL_OUTPUT_BUDGET_INVALID",
  "PRESET_PARAMETER_UNSUPPORTED", "PRESET_THINKING_INCOMPATIBLE", "INVALID_MODEL_PARAMETERS", "OUTPUT_LIMIT",
  "PRESET_OUTPUT_LIMIT", "PRESET_MODEL_MISMATCH", "UNKNOWN_MODEL_PRESET", "UPSTREAM_SCHEMA_UNSUPPORTED", "INVALID_RESPONSE_FORMAT"]);
const LOCAL_MODEL_ERROR_STAGES: Record<string, readonly string[]> = {
  MODEL_RESULT_UNAVAILABLE: ["request_status", "request_recovery"],
  MODEL_DISPATCH_UNKNOWN: ["request_status", "request_recovery", "transport"],
  MODEL_REQUEST_FAILED: ["request_recovery"],
  MODEL_CONNECT_FAILED: ["transport_connect"],
  MODEL_AUTH_UNAVAILABLE: ["request_auth"],
  MODEL_RECOVERY_BUDGET_EXHAUSTED: ["recovery_budget"],
  MODEL_RECOVERY_BUDGET_INVALID: ["recovery_budget"],
  MODEL_REQUEST_CONFLICT: ["request_status", "request", "recovery_budget"],
  MODEL_SCHEMA_INVALID: ["schema_compile"],
  MODEL_SCHEMA_UNSUPPORTED: ["schema_compile"],
  MODEL_RESPONSE_INVALID: ["response_envelope", "response_status"],
  MODEL_PROVIDER_FAILED: ["response_status"],
  MODEL_OUTPUT_CANCELLED: ["response_status"],
  MODEL_OUTPUT_PENDING: ["response_status"],
  MODEL_OUTPUT_INCOMPLETE: ["response_status"],
  MODEL_OUTPUT_ITEM_UNSUPPORTED: ["response_status"],
  MODEL_CAPABILITY_UNKNOWN: ["request"],
  MODEL_ENDPOINT_INVALID: ["request"],
  MODEL_REQUEST_INVALID: ["request"],
  MODEL_PROBE_CONTRACT_INVALID: ["request"],
  MODEL_PROTOCOL_UNSUPPORTED: ["request"],
  MODEL_OUTPUT_REFUSED: ["response_status"],
  MODEL_TOOL_CALL_UNEXPECTED: ["response_status"],
  MODEL_CONTENT_FILTERED: ["response_status"],
  MODEL_FORMAT_INVALID: ["json_parse", "wire_validation", "business_validation", "metadata_decode", "format_repair_scope"],
  MODEL_RECOVERY_SCOPE_REJECTED: ["format_repair_scope"],
  MODEL_OUTPUT_REPAIR_EXHAUSTED: ["output_recovery"],
  MODEL_OUTPUT_TRUNCATED: ["response_status"],
  MODEL_FINISH_UNSUPPORTED: ["response_status"],
  MODEL_CAPABILITY_INVALID: ["request"],
  MODEL_PARAMETER_UNSUPPORTED: ["request"],
  MODEL_OUTPUT_BUDGET_INVALID: ["request"],
};
const LOCAL_MODEL_ERROR_CODES = new Set(Object.keys(LOCAL_MODEL_ERROR_STAGES));

function parseModelServiceError(value: unknown): ModelServiceError | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.code !== "string" || typeof item.message !== "string") return undefined;
  const trustedLocalError = item.origin === "core" && typeof item.stage === "string"
    && LOCAL_MODEL_ERROR_CODES.has(item.code) && LOCAL_MODEL_ERROR_STAGES[item.code].includes(item.stage);
  const httpStatus = typeof item.httpStatus === "number" && Number.isInteger(item.httpStatus)
    && item.httpStatus >= 100 && item.httpStatus <= 599 ? item.httpStatus : undefined;
  // Older gateway/serialized errors use the established code + HTTP-status shape.
  // New local failures have no HTTP response; require their Core code/stage pair
  // instead of inventing a transport status or classifying arbitrary prose.
  if (!CREDIT_ERROR_CODES.has(item.code)
    && !((COMPATIBILITY_ERROR_CODES.has(item.code) || MODEL_RECOVERY_ERROR_CODES.has(item.code) || GATEWAY_MODEL_ERROR_CODES.has(item.code)) && httpStatus !== undefined)
    && !trustedLocalError) return undefined;
  const details: NonNullable<ModelServiceError["details"]> = {};
  const raw = item.details && typeof item.details === "object" && !Array.isArray(item.details)
    ? item.details as Record<string, unknown> : {};
  for (const key of ["available_tokens", "required_tokens", "reserved_tokens", "estimated_input_tokens", "max_output_tokens"] as const) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0) details[key] = raw[key];
  }
  if (typeof raw.exact === "boolean") details.exact = raw.exact;
  if (raw.billing_mode === "direct" || raw.billing_mode === "reserved") details.billing_mode = raw.billing_mode;
  if (typeof raw.estimator === "string") details.estimator = raw.estimator.slice(0, 120);
  const diagnostic: Partial<ModelServiceError> = {};
  if (item.origin === "core" || item.origin === "provider" || item.origin === "upstream" || item.origin === "gateway") diagnostic.origin = item.origin;
  for (const key of ["stage", "jsonPointer", "schemaPath", "keyword", "operation", "contractVersion", "providerCode", "rawStatus", "incompleteReason"] as const) {
    if (typeof item[key] === "string") diagnostic[key] = item[key].slice(0, key === "jsonPointer" || key === "schemaPath" ? 2048 : 160);
  }
  for (const key of ["line", "column"] as const) {
    if (typeof item[key] === "number" && Number.isSafeInteger(item[key]) && item[key] >= 0) diagnostic[key] = item[key];
  }
  for (const key of ["gatewayHttpStatus", "providerHttpStatus", "statusQueryHttpStatus"] as const) {
    if (typeof item[key] === "number" && Number.isInteger(item[key]) && item[key] >= 100 && item[key] <= 599) diagnostic[key] = item[key];
  }
  for (const key of ["requestKey", "callId", "modelOperationId", "generationId"] as const) {
    if (typeof item[key] === "string") diagnostic[key] = item[key].slice(0, 200);
  }
  if (typeof item.responseAvailable === "boolean") diagnostic.responseAvailable = item.responseAvailable;
  if (typeof item.creditState === "string") diagnostic.creditState = item.creditState.slice(0, 100);
  if (item.billingMode === "direct" || item.billingMode === "reserved") diagnostic.billingMode = item.billingMode;
  for (const key of ["reserved", "actual"] as const) {
    if (typeof item[key] === "number" && Number.isFinite(item[key]) && item[key] >= 0) diagnostic[key] = item[key];
  }
  if (item.dispatchCertainty === "not_dispatched" || item.dispatchCertainty === "may_have_dispatched" || item.dispatchCertainty === "response_received") {
    diagnostic.dispatchCertainty = item.dispatchCertainty;
  }
  if (item.recoveryBudget && typeof item.recoveryBudget === "object" && !Array.isArray(item.recoveryBudget)) {
    const budget: NonNullable<ModelServiceError["recoveryBudget"]> = {};
    const rawBudget = item.recoveryBudget as Record<string, unknown>;
    for (const key of ["generations", "transportAttempts", "elapsedMs", "accountedTokens", "knownUsageTokens", "unknownUsageAttempts", "maxGenerations", "maxTransportAttempts", "maxElapsedMs", "maxTotalTokens", "fieldRepairs", "candidateRegenerations"] as const) {
      const number = rawBudget[key];
      if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0) budget[key] = number;
    }
    for (const key of ["exactTokens", "recoveryBlocked"] as const) {
      if (typeof rawBudget[key] === "boolean") budget[key] = rawBudget[key];
    }
    for (const key of ["usageEstimator", "modelOperationId"] as const) {
      if (typeof rawBudget[key] === "string") budget[key] = rawBudget[key].slice(0, 200);
    }
    if (Object.keys(budget).length) diagnostic.recoveryBudget = budget;
  }
  return { ...(httpStatus !== undefined ? { httpStatus } : {}), ...diagnostic,
    code: item.code, message: item.message.slice(0, 500), retryable: false,
    details: Object.keys(details).length ? details : undefined };
}

function parseLegacyModelServiceError(message: string): ModelServiceError | undefined {
  // Old Rust builds preserved the provider error JSON inside the human-readable message.
  // Match its explicit code, never a model's prose mentioning billing or token limits.
  const offset = message.indexOf("{");
  if (offset < 0) return undefined;
  try {
    const parsed = JSON.parse(message.slice(offset));
    return parseModelServiceError(parsed.modelError ?? parsed.error ?? parsed)
      ?? (typeof parsed.message === "string" && parsed.message !== message ? parseLegacyModelServiceError(parsed.message) : undefined);
  } catch { return undefined; }
}

export function modelServiceError(error: unknown): ModelServiceError | undefined {
  if (error instanceof ModelInvocationError && error.modelError) return error.modelError;
  return parseLegacyModelServiceError(error instanceof Error ? error.message : String(error));
}

export function modelServiceErrorMessage(error: ModelServiceError) {
  if (isModelRecoveryScopeRejection(error)) {
    const field = error.jsonPointer?.match(/^\/(?:steps|repair\/replacementSteps)\/(\d+)(?:\/(kind|executionScope|runtimeClass|validation|sessionContextChange|action(?:\/command|\/toolId)?))?$/);
    const index = field ? Number(field[1]) : undefined;
    const location = index !== undefined && Number.isSafeInteger(index) ? `第 ${index + 1} 个步骤` : "恢复方案";
    const reasons: Record<string, string> = {
      kind: "包含非观察步骤",
      executionScope: "使用了此轮恢复不允许的执行作用域",
      runtimeClass: "试图启动常驻服务",
      validation: "包含此轮只读取证不允许的后置校验",
      sessionContextChange: "试图修改执行会话",
      "action/command": "的 Shell 命令包含变更，或无法被当前规则确认只读",
      "action/toolId": "使用的工具未被当前目录声明为只读",
      action: "的动作无法被当前规则确认只读",
    };
    const detail = field?.[2] && reasons[field[2]] ? `${location}${reasons[field[2]]}。` : `${location}未满足此轮只读取证限制。`;
    return `恢复方案未通过只读安全校验。${detail}该方案未执行，已有目标、用户确认和执行证据已保留。已停止自动重试；后续方案需要使用当前规则可确认的只读检查，无需修改模型配置。`;
  }
  if (MODEL_RECOVERY_ERROR_CODES.has(error.code)) {
    const summary = error.code === "MODEL_RESULT_UNAVAILABLE" ? "模型请求已有处理记录，但原始响应无法恢复。"
      : error.code === "MODEL_DISPATCH_UNKNOWN" ? "模型请求是否已经处理尚不确定，已停止自动重新发送。"
      : error.code === "MODEL_REQUEST_FAILED" ? "模型请求处理失败，已停止本次恢复。"
      : error.code === "MODEL_CONNECT_FAILED" ? "模型接口连接失败，已停止自动调用。"
      : error.code === "MODEL_AUTH_UNAVAILABLE" ? "模型账户认证不可用，请求尚未派发。请检查登录状态和所选账户。"
      : error.code === "MODEL_REQUEST_CONFLICT" || error.code === "IDEMPOTENCY_KEY_CONFLICT" ? "模型请求身份与已记录的内容或恢复上下文冲突，已停止调用。"
      : error.code === "MODEL_RECOVERY_BUDGET_INVALID" ? "模型恢复上下文无效或已失效，已停止调用。"
      : "本次模型操作已达到恢复预算，已停止自动重试和重规划。";
    return `${summary}已有目标、用户确认和执行证据已保留；同一操作不会通过新请求重新开始预算。`;
  }
  if (error.code === "MODEL_SCHEMA_INVALID" || error.code === "MODEL_SCHEMA_UNSUPPORTED" || error.code === "UPSTREAM_SCHEMA_INVALID") {
    const summary = error.origin === "core" && error.stage === "schema_compile"
      ? "当前操作的结构契约未通过本地编译校验，请更新客户端或检查契约定义。"
      : "模型接口拒绝了当前操作的结构契约，请检查契约定义与所选接口的兼容性。";
    return `${summary}已有目标、用户确认和执行证据已保留；同一条件下不会重复请求模型。`;
  }
  if (GATEWAY_MODEL_ERROR_CODES.has(error.code)) {
    const status = error.providerHttpStatus ?? error.httpStatus;
    const summary = ["UPSTREAM_HTTP_ERROR", "MODEL_HTTP_ERROR"].includes(error.code) && [401, 403].includes(status ?? 0)
      ? "上游模型服务认证或权限校验失败。"
      : ["UPSTREAM_HTTP_ERROR", "MODEL_HTTP_ERROR"].includes(error.code) && status === 429
      ? "模型服务请求频率受限，当前操作已停止。"
      : error.code === "MODEL_HTTP_ERROR" && status !== undefined
      ? `模型接口拒绝了请求（HTTP ${status}）。`
      : error.code === "CAPABILITY_REVISION_MISMATCH" ? "模型接入配置已更新，请刷新能力目录后重新验证。"
      : error.code === "MODEL_PROTOCOL_UNSUPPORTED" ? "所选模型路由不支持当前 API 协议。"
      : error.code === "REQUEST_ALREADY_ACCEPTED" || error.code === "REQUEST_STATE_CONFLICT"
      ? "模型请求已有处理记录，当前结果尚未恢复。"
      : "模型服务请求失败，未获得可用结果。";
    return `${summary}已有目标、用户确认和执行证据已保留；本次操作已停止自动重试和重规划。`;
  }
  if (error.code === "MODEL_FORMAT_INVALID") {
    // Expose the field location, never the raw model response or provider message.
    const field = error.jsonPointer && /^\/(?:steps|repair|decision|reason|summary|requirementReview|blocking|issueResolutions)(?:\/[A-Za-z0-9_-]+)*$/.test(error.jsonPointer)
      ? error.jsonPointer.slice(0, 160) : undefined;
    const detail = error.stage === "json_parse" ? "返回内容不是完整合法的 JSON。"
      : field ? `字段 ${field}${error.keyword === "additionalProperties" ? "不允许出现在当前契约中" : "未通过契约校验"}。` : "返回字段未通过当前操作契约校验。";
    return `模型响应格式修复未成功。${detail}被拒响应未用于推进任务，已有目标、用户确认和执行证据已保留。已停止自动重试；可点击“重新生成”发起一次有界重试，无需修改模型配置。`;
  }
  if (error.code === "MODEL_OUTPUT_REPAIR_EXHAUSTED") {
    return "本轮局部修复机会已用完，当前操作未得到可用结果。已有目标、授权和执行证据已保留；可重新生成后续方案，执行结果未知的操作仍须先核对。";
  }
  if (COMPATIBILITY_ERROR_CODES.has(error.code) || LOCAL_MODEL_ERROR_CODES.has(error.code)) {
    const summary = error.code === "MODEL_OUTPUT_TRUNCATED" ? "模型输出被截断，未得到完整可用结果。"
      : error.code === "MODEL_FINISH_UNSUPPORTED" ? "模型响应未正常结束，不能作为可执行方案。"
      : error.code === "MODEL_RESPONSE_INVALID" ? "模型接口响应封装不符合所选 API 协议。"
      : error.code === "MODEL_OUTPUT_PENDING" ? "模型请求尚未完成，当前未启用后台结果续取。"
      : error.code === "MODEL_OUTPUT_CANCELLED" ? "模型响应已取消。"
      : error.code === "MODEL_OUTPUT_INCOMPLETE" ? "模型响应未完成。"
      : error.code === "MODEL_PROVIDER_FAILED" ? "模型供应商报告本次生成失败。"
      : error.code === "MODEL_OUTPUT_ITEM_UNSUPPORTED" ? "模型响应包含尚未支持的输出类型。"
      : error.code === "MODEL_OUTPUT_REFUSED" ? "模型拒绝了本次请求，未返回可用结果。"
      : error.code === "MODEL_TOOL_CALL_UNEXPECTED" ? "模型返回了当前操作未请求的原生工具调用。"
      : error.code === "MODEL_CONTENT_FILTERED" ? "模型响应被内容过滤，未返回完整可用结果。"
      : "模型接入能力或参数不兼容。";
    return `${summary}已有目标、用户确认和执行证据已保留；请调整模型能力、输出预算或阶段范围后继续。同一条件下不会重复请求模型。`;
  }
  const details = error.details;
  const direct = details?.billing_mode === "direct";
  const credits = [
    details?.available_tokens !== undefined ? `可用 ${formatCredits(details.available_tokens)} 积分` : "",
    details?.required_tokens !== undefined ? `本次需要${direct ? "扣减" : "预留"} ${formatCredits(details.required_tokens)} 积分` : "",
  ].filter(Boolean).join("，");
  const headline = error.code === "CREDITS_RECONCILIATION_REQUIRED"
    ? "模型账户额度需要完成结算核对，暂不能继续调用。"
    : direct ? "模型可用余额已用完，暂不能生成后续方案。" : "本次调用预留额度不足，暂不能生成后续方案。";
  if (direct) return `${headline}${credits ? `${credits}。` : ""}当前按实际用量直接扣余额，不预留额度。已有目标和执行证据已保留；请处理待扣用量或补充积分后到账号页刷新，也可切换模型。条件未变化时不会重复请求模型。`;
  return `${headline}${credits ? `${credits}。` : ""}${details?.exact === false ? "所需预留量为估算，不是实际扣费。" : ""}已有目标和执行证据已保留；请补充积分后到账号页刷新，或切换模型、降低输出预算/缩小上下文后再继续。条件未变化时不会重复请求模型。`;
}

function normalizeModelInvocationError(error: unknown) {
  const diagnostic = readRecoveryProtocolError(error);
  if (diagnostic) return new RecoveryProtocolError(diagnostic);
  const raw = error instanceof Error ? error.message : String(error);
  const marker = raw.indexOf(MODEL_TRACE_ERROR_PREFIX);
  if (marker < 0) return modelServiceError(error)
    ? new ModelInvocationError(raw, undefined, modelServiceError(error))
    : error instanceof Error ? error : new Error(raw);
  try {
    const parsed = JSON.parse(raw.slice(marker + MODEL_TRACE_ERROR_PREFIX.length)) as {
      message?: string;
      developerTrace?: ModelDeveloperTrace;
      modelError?: ModelServiceError;
    };
    return new ModelInvocationError(parsed.message || "模型调用失败", parsed.developerTrace, parsed.modelError);
  } catch {
    return new Error(raw);
  }
}

export interface SshProbe {
  info: ServerInfo;
  environment: string[];
  hostname: string;
}

export interface TerminalOutputEvent {
  terminalId: string;
  generation: number;
  data: string;
  stream: "stdout" | "stderr" | "system" | "error";
}

export interface TerminalStatusEvent {
  terminalId: string;
  generation: number;
  status: "connecting" | "connected" | "disconnected" | "error";
  reason?: string | null;
  retryable: boolean;
}

export interface SftpTransferProgressEvent {
  transferId: string;
  direction: "upload" | "download" | "server";
  transferredBytes: number;
  totalBytes: number;
  status: "running" | "completed";
}

export interface ServerTransferResult {
  sourcePath: string;
  targetPath: string;
  transferredBytes: number;
  sha256: string;
}

export interface CommandOutputEvent {
  executionId: string;
  data: string;
  stream: "stdout" | "stderr" | "system" | "error";
}

export interface AgentTerminalOutputEvent {
  sessionId: string;
  generation: number;
  executionId?: string;
  data: string;
  stream: "stdout" | "stderr" | "system" | "begin" | "end" | "error";
}

export interface AgentPromptCredential {
  kind: "password" | "git-https";
  secret: string;
  username?: string;
  target?: string;
}

export interface AgentCommandResult {
  output: string;
  success: boolean;
  simulated: false;
  exitCode: number;
  emptyResult: boolean;
  sessionId: string;
  generation: number;
  scope: ExecutionScope;
}

export interface AgentRuntimeProgress {
  active: boolean;
  processCount: number;
  /** Null means the remote host cannot reliably measure this metric. */
  cpuPercent: number | null;
  ioBytes: number | null;
}

export type CredentialKind = "server" | "model" | "secret" | "knowledge";

export {
  buildExecutionSummary,
  normalizeLongRunningCommandOutput,
  normalizePlanPreconditions,
  normalizeSecretPlaceholders,
};

function requireDesktopRuntime(operation: string): never {
  throw new Error(`${operation} 仅支持 Opsark 桌面端真实连接`);
}

export interface PlanNormalizationRepair {
  /** Carries the original model-operation budget across saved local repairs. */
  modelRecovery?: ModelRecoveryContext;
  /** A changed business action cannot be revived by legacy field revalidation. */
  businessReplanRequired?: boolean;
  errorCode: "tool_schema_validation_failed" | "plan_normalization_failed" | "next_stage_response_invalid";
  repairStrategy?:
    | { type: "field_local" }
    | { type: "plan_protocol" }
    | { type: "read_batch_stage_split" }
    | { type: "standalone_stage_split"; standaloneStepIndex: number; toolId: string };
  fieldPath?: string;
  expected?: string;
  validationError: string;
  previousModelOutput: PlanStep[];
  /** Rejected response text, never an executable plan or completion evidence. */
  rawModelResponse?: string;
  instruction: string;
  diagnostic?: PlanRepairDiagnostic;
  progress?: ProtocolRepairProgress;
  /** Business proposals after the first rejection, separate from field repair. */
  businessReplanProgress?: { attemptCount: number; stopReason: "no_progress" | "budget_exhausted" };
  nextStageDecision?: Pick<NextStageDecision, "decision" | "reason" | "summary" | "planUpdate" | "reconciliation" | "requirementReview" | "blocking" | "issueResolutions">;
}

export class PlanProtocolError extends Error {
  processed?: RequirementProcessingResult;
  developerTrace?: ModelDeveloperTrace;
  get userMessage() {
    const progress = this.repair.businessReplanProgress;
    const recovery = progress
      ? `已尝试 ${progress.attemptCount} 次后续方案重规划，${progress.stopReason === "no_progress" ? "方案重复无进展，已停止重复请求" : "已达到本轮重规划上限"}。`
      : "";
    if (this.repair.errorCode === "next_stage_response_invalid") {
      return `${recovery}后续阶段响应格式不完整或不正确，未执行新的计划。已完成步骤及其证据保持有效，可重新生成后续方案。`;
    }
    const safetyCode = this.repair.validationError.match(/\b(?:PIPELINE_STATUS_LOST|EMPTY_SUCCESS_FALLBACK|OBSERVE_COMMAND_MUTATION|ASKPASS_CREDENTIAL_SCRIPT)\b/)?.[0];
    const unavailableTool = this.repair.validationError.match(/当前规划上下文未开放工具[：\s]+([a-zA-Z0-9_.-]+)/)?.[1];
    const invalidScope = this.repair.validationError.match(/(?:executionScope|validationScope|runtimeClass) 不合法/)?.[0];
    const reason = invalidScope ? `后续计划的 ${invalidScope}，必须使用契约规定的枚举值`
      : this.repair.validationError.includes("TOOL_IN_SHELL") ? "后续计划将工具调用嵌入了 Shell，须拆为独立步骤（TOOL_IN_SHELL）"
      : unavailableTool ? `后续计划调用了当前未开放的工具 ${unavailableTool}`
      : safetyCode ? `后续计划未通过安全检查（${safetyCode}${safetyCode === "PIPELINE_STATUS_LOST" ? "：管道可能掩盖主命令退出码" : ""}）`
      : isPlanModeConflictRepair(this.repair) ? "后续计划跨越了需要单独规划的交互或上下文边界"
      : "后续计划未通过执行前校验";
    return `${recovery}${reason}，该计划尚未执行。当前目标和已完成结果已保留，可重新生成后续方案；需要确认的操作会在执行前提示。`;
  }
  readonly developerMessage: string;
  constructor(public repair: PlanNormalizationRepair, public repairError: string) {
    const developerMessage = `计划协议校验失败：${repair.validationError}\n协议修复失败：${repairError}。未执行该计划，原始计划已保留。`;
    super(developerMessage);
    this.name = "PlanProtocolError";
    this.developerMessage = developerMessage;
  }
}

/** Decode audit proposals only. This does not admit or execute rejected steps. */
/** Only output diagnostics may switch to another candidate; service/execution failures may not. */
export function canRegenerateModelCandidate(error: unknown): boolean {
  return error instanceof PlanProtocolError || isRecoverableModelOutput(modelServiceError(error));
}

export function modelCandidateDiagnostic(error: unknown): Record<string, unknown> {
  if (error instanceof PlanProtocolError) return {
    code: error.repair.diagnostic?.code ?? error.repair.errorCode,
    fieldPath: error.repair.diagnostic?.fieldPath ?? error.repair.fieldPath,
    expected: (error.repair.diagnostic?.expected ?? error.repair.validationError).slice(0, 1200),
  };
  const diagnostic = modelServiceError(error);
  return { code: diagnostic?.code, stage: diagnostic?.stage, jsonPointer: diagnostic?.jsonPointer,
    schemaPath: diagnostic?.schemaPath, keyword: diagnostic?.keyword };
}

export function exhaustedCandidateRecovery(error: unknown, stopReason: "no_progress" | "budget_exhausted" = "budget_exhausted"): unknown {
  if (error instanceof PlanProtocolError) error.repair.businessReplanProgress = { attemptCount: 1, stopReason };
  return error;
}

function rejectedProtocolSteps(value: unknown[]): PlanStep[] | undefined {
  const steps: PlanStep[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const step = entry as Record<string, unknown>;
    if (typeof step.id !== "string") return undefined;
    const action = step.action as Record<string, unknown> | undefined;
    if (action !== undefined && action !== null) {
      if (typeof action !== "object" || Array.isArray(action)) return undefined;
      if (action.type === "shell" && typeof action.command === "string") {
        steps.push({ ...step, command: action.command } as unknown as PlanStep);
      } else if (action.type === "tool" && typeof action.toolId === "string"
        && action.arguments && typeof action.arguments === "object" && !Array.isArray(action.arguments)) {
        steps.push({ ...step, command: "" } as unknown as PlanStep);
      } else return undefined;
    } else if (typeof step.command === "string") {
      steps.push({ ...step } as unknown as PlanStep);
    } else return undefined;
  }
  return steps;
}

/** Recover only the known legacy display wrapper; leave history and execution facts intact. */
export function restoreLegacyPlanProtocolFailure(reason: string | undefined): PlanProtocolError | undefined {
  const prefix = "后续流程暂不可用：ModelInvocationError: ";
  const suffix = "。已完成步骤及其执行证据保持有效，可检查后继续。";
  if (!reason?.startsWith(prefix) || !reason.endsWith(suffix)) return undefined;
  const raw = reason.slice(prefix.length, -suffix.length);
  try {
    const envelope = JSON.parse(raw);
    if (envelope?.kind !== "plan_protocol_failure" || envelope.rejectedPlanExecuted !== false) return undefined;
    return rustProtocolFailure(envelope, "{}");
  } catch { return undefined; }
}

/** Preserve rejected Rust output and its consumed budget across the Tauri boundary. */
function rustProtocolFailure(error: unknown, context: string): PlanProtocolError | undefined {
  let value: unknown = error instanceof Error ? error.message : error;
  let trace: ModelDeveloperTrace | undefined;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof value === "string") {
      const marker = value.indexOf(MODEL_TRACE_ERROR_PREFIX);
      const json = marker >= 0 ? value.slice(marker + MODEL_TRACE_ERROR_PREFIX.length)
        : value.slice(Math.max(0, value.indexOf("{")));
      try { value = JSON.parse(json); } catch { return undefined; }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const envelope = value as Record<string, unknown>;
    if (envelope.developerTrace) trace = envelope.developerTrace as ModelDeveloperTrace;
    if (typeof envelope.message === "string") { value = envelope.message; continue; }
    if (envelope.kind === "next_stage_response_invalid" && typeof envelope.validationError === "string"
      && typeof envelope.rawResponse === "string") {
      const repair: PlanNormalizationRepair = {
        modelRecovery: recoveryFromContext(context),
        errorCode: "next_stage_response_invalid", repairStrategy: { type: "plan_protocol" },
        fieldPath: "response", validationError: envelope.validationError,
        // There are no parsed steps. This is an audit placeholder, not a valid
        // adjust/complete decision with an empty plan.
        previousModelOutput: [], rawModelResponse: envelope.rawResponse,
        instruction: "重新返回完整的阶段联合决策，必须包含 decision、reason、summary、steps；不要仅在摘要中声称已经提供步骤。",
      };
      const failure = new PlanProtocolError(repair, "阶段响应未能解析，需要重新生成完整联合决策");
      failure.developerTrace = trace;
      return failure;
    }
    if (envelope.kind === "plan_protocol_failure" && typeof envelope.validationError === "string"
      && Array.isArray(envelope.steps)) {
      const steps = rejectedProtocolSteps(envelope.steps);
      if (!steps) return undefined;
      const repair = buildPlanNormalizationRepair(envelope.validationError, steps);
      repair.modelRecovery = recoveryFromContext(context);
      repair.businessReplanRequired = envelope.businessReplanRequired === true
        || envelope.validationError.includes("将进程脱离执行器跟踪");
      const decision = envelope.nextStageDecision as Record<string, unknown> | undefined;
      if (decision && ["complete", "continue", "adjust"].includes(String(decision.decision))
        && typeof decision.reason === "string" && typeof decision.summary === "string") {
        repair.nextStageDecision = decision as PlanNormalizationRepair["nextStageDecision"];
      }
      repair.progress = {
        scopeFingerprint: protocolRepairScopeFingerprint(context), attemptCount: 0,
        attemptedFingerprints: [], seenPlans: [planSemanticFingerprint(steps)],
        stopCode: "PROTOCOL_REPAIR_SCOPE_UNKNOWN", stopReason: "需要依据当前可用工具和执行协议重新规划",
      };
      // Changing tool identity or stage layout is a new proposal. Do not force
      // it through field-local repair or bypass approval of the replacement.
      const failure = new PlanProtocolError(repair, "需要依据当前可用工具和执行协议重新规划");
      failure.developerTrace = trace;
      return failure;
    }
    const issue = readRecoveryProtocolError(envelope);
    if (!issue || !Array.isArray(envelope.steps) || !envelope.steps.length) return undefined;
    const steps = rejectedProtocolSteps(envelope.steps);
    if (!steps) return undefined;
    const repair = buildPlanNormalizationRepair(new RecoveryProtocolError(issue), steps);
    repair.modelRecovery = recoveryFromContext(context);
    const decision = envelope.nextStageDecision as Record<string, unknown> | undefined;
    if (decision && ["continue", "adjust"].includes(String(decision.decision))
      && typeof decision.reason === "string" && typeof decision.summary === "string") {
      repair.nextStageDecision = decision as PlanNormalizationRepair["nextStageDecision"];
    }
    const count = Number(envelope.focusedRepairCalls);
    const attempted = envelope.repairAttempted === true;
    const backendStopCode = typeof envelope.repairStopCode === "string"
      && envelope.repairStopCode.startsWith("PROTOCOL_REPAIR_")
      ? envelope.repairStopCode as ProtocolRepairProgress["stopCode"] : undefined;
    const stopReason = typeof envelope.reason === "string" && envelope.reason.trim()
      ? envelope.reason : undefined;
    repair.progress = {
      scopeFingerprint: protocolRepairScopeFingerprint(context, issue),
      attemptCount: Number.isFinite(count) ? count : attempted ? 1 : 0,
      attemptedFingerprints: [], seenPlans: [planSemanticFingerprint(steps)],
      stopCode: attempted ? backendStopCode ?? "PROTOCOL_REPAIR_FAILED" : undefined,
      stopReason,
    };
    const failure = new PlanProtocolError(repair, repair.progress.stopCode
      ? protocolRepairStopMessage(repair.progress)
      : [String(envelope.repairStopCode ?? issue.code), stopReason].filter(Boolean).join("："));
    failure.developerTrace = trace;
    return failure;
  }
  return undefined;
}

const PLAN_MODE_CONFLICT_EXPECTED = "read_batch 只读工具可以与 Shell 或变更按顺序组成计划；standalone 交互或上下文变更工具必须是唯一待执行步骤";
const PLAN_MODE_CONFLICT_INSTRUCTION = "这是执行器硬协议冲突。Core 会原子拒绝整份计划，不会截取前缀、删除已完成命令对应步骤或静默接受部分步骤；需要由上层重新生成一份完整且满足工具 planMode 的计划。";
const PLAN_MODE_CONFLICT_REJECTION = "PLAN_STAGE_CONFLICT：工具 planMode 冲突，整份计划已原子拒绝；Core 未截取、删除或执行其中任何步骤";

function isReadBatchStageConflict(error: unknown) {
  return error instanceof PlanStageConflictError || String(error).includes(READ_BATCH_STAGE_CONFLICT);
}

function isStandaloneStageConflict(error: unknown) {
  return String(error).includes("standalone 工具必须是唯一待执行步骤");
}

function hasLegacyStageSplitStrategy(repair: PlanNormalizationRepair) {
  const type = (repair.repairStrategy as { type?: string } | undefined)?.type;
  return type === "read_batch_stage_split" || type === "standalone_stage_split";
}

function isPlanModeConflictRepair(repair: PlanNormalizationRepair) {
  return hasLegacyStageSplitStrategy(repair)
    || isReadBatchStageConflict(repair.validationError)
    || isStandaloneStageConflict(repair.validationError)
    || repair.expected === PLAN_MODE_CONFLICT_EXPECTED;
}

/** Upgrades a persisted pre-strategy repair without changing its preserved model output. */
function normalizePlanRepairStrategy(repair: PlanNormalizationRepair): PlanNormalizationRepair {
  if (!isPlanModeConflictRepair(repair)) return repair;
  return { ...repair, repairStrategy: { type: "plan_protocol" }, fieldPath: "steps",
    expected: PLAN_MODE_CONFLICT_EXPECTED, instruction: PLAN_MODE_CONFLICT_INSTRUCTION };
}

function atomicPlanModeConflict(repair: PlanNormalizationRepair) {
  return new PlanProtocolError(normalizePlanRepairStrategy(repair), PLAN_MODE_CONFLICT_REJECTION);
}

/** Builds the bounded, non-secret feedback used for one model protocol-repair attempt. */
export function buildPlanNormalizationRepair(error: unknown, steps: PlanStep[]): PlanNormalizationRepair {
  const diagnostic = readRecoveryProtocolError(error);
  if (diagnostic) {
    const toolArgument = diagnostic.code === "TOOL_ARGUMENT_INVALID";
    return {
      errorCode: toolArgument ? "tool_schema_validation_failed" : "plan_normalization_failed",
      repairStrategy: { type: toolArgument ? "field_local" : "plan_protocol" },
      diagnostic, fieldPath: diagnostic.fieldPath, expected: diagnostic.expected,
      validationError: `${diagnostic.code} / ${diagnostic.fieldPath}${diagnostic.matchedToken ? ` / matchedToken=${diagnostic.matchedToken}` : ""}：${diagnostic.expected}`,
      previousModelOutput: steps,
      instruction: `只修复 ${diagnostic.allowedRepairPaths.join("、") || "无可自动修复字段（需要权威上下文）"}。${diagnostic.expected}。保持其余字段与原计划业务含义不变。${toolArgument ? "保持工具身份和其他参数不变，不得改写同一工具内未报错的字段。" : "只读诊断如有临时文件创建、写入和清理，须整体改成无落盘诊断并保留真实退出码；不得改 kind/purpose 绕过规则。"}`,
    };
  }
  const validationError = String(error);
  const stepNumber = validationError.match(/第\s*(\d+)\s*个计划步骤/)?.[1];
  const credentialType = validationError.match(/凭据参数\s+([A-Za-z][A-Za-z0-9_]*)\s+必须使用 password 类型/);
  const credentialTarget = validationError.match(/参数\s+([A-Za-z][A-Za-z0-9_]*)\s+的 credential\.target/);
  const planModeConflict = isReadBatchStageConflict(error) || isStandaloneStageConflict(error);
  const repairStrategy: NonNullable<PlanNormalizationRepair["repairStrategy"]> = planModeConflict
    ? { type: "plan_protocol" }
    : validationError.includes("工具参数无效")
      ? { type: "field_local" }
      : { type: "plan_protocol" };
  return {
    errorCode: validationError.includes("工具参数无效")
      ? "tool_schema_validation_failed"
      : "plan_normalization_failed",
    repairStrategy,
    fieldPath: planModeConflict
      ? "steps"
      : credentialType
        ? `steps[${Math.max(0, Number(stepNumber ?? 1) - 1)}].action.arguments.fields[key=${credentialType[1]}].type`
        : credentialTarget
          ? `steps[${Math.max(0, Number(stepNumber ?? 1) - 1)}].action.arguments.fields[key=${credentialTarget[1]}].credential.target`
          : stepNumber
            ? `steps[${Math.max(0, Number(stepNumber) - 1)}]`
            : undefined,
    expected: planModeConflict
      ? PLAN_MODE_CONFLICT_EXPECTED
      : credentialType ? "password" : credentialTarget ? "已确认的主机:端口或明确的 socket 绝对路径；遵守 credential.kind 对应目标规则" : undefined,
    validationError,
    previousModelOutput: steps,
    instruction: planModeConflict
      ? PLAN_MODE_CONFLICT_INSTRUCTION
      : "只修复上述结构或工具参数错误；保持业务目的、步骤范围、风险和用户授权不变，不增加无关步骤。工具参数修复必须逐字保留每个步骤的 kind、title、description、risk、expected、validation 及步骤数量；只修改报错步骤 command 内的错误参数，不要润色描述或重写计划。",
  };
}

function contextWithPlanRepair(context: string, repair: PlanNormalizationRepair) {
  try {
    const parsed = JSON.parse(context) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, planGenerationRepair: repair });
    }
  } catch {
    // Preserve an opaque legacy context without attempting to reinterpret it.
  }
  return JSON.stringify({ originalContext: context, planGenerationRepair: repair });
}

/** Match the authority Rust used after classification, before creating repair feedback. */
function classifiedPlanContext(context: string, result: RequirementProcessingResult, definitions: ModelSkillDefinition[], requirement: string) {
  const projected = projectClassifiedRequirementContext(parseRepairContext(context), result, requirement);
  const source = projected.context;
  const previous = protocolRepairAuthority(context).executionConstraints
    ?? parseRepairContext(context).previousExecution?.executionConstraints;
  const executionConstraints = mergeRequirementExecutionConstraints({ previous, classified: result.constraints,
    relation: result.relation, previousLifecycle: projected.previousLifecycle, nextLifecycle: projected.nextLifecycle });
  const selected = result.selectedSkillIds;
  const activeSkills = selected ? selected.flatMap(id => {
    const skill = definitions.find(item => item.id === id)
      ?? (Array.isArray(source.activeSkills) ? source.activeSkills.find((item: ModelSkillDefinition) => item.id === id) : undefined);
    return skill ? [skill] : [];
  }) : source.activeSkills;
  return JSON.stringify({ ...source, executionConstraints, activeSkills,
    skillSelection: { mode: "model", selectedSkillIds: selected ?? [] } });
}

export function assertPlanRepairScope(repair: PlanNormalizationRepair, repaired: PlanStep[]) {
  if (isPlanModeConflictRepair(repair)) {
    throw new Error(PLAN_MODE_CONFLICT_REJECTION);
  }
  repair = normalizePlanRepairStrategy(repair);
  if (repair.errorCode !== "tool_schema_validation_failed") {
    const allowed = repair.diagnostic?.allowedRepairPaths ?? [];
    if (!allowed.length) throw new Error("PROTOCOL_REPAIR_SCOPE_UNKNOWN：没有可验证的局部修复字段，需补充权威上下文或进入业务调整");
    if (repair.previousModelOutput.length !== repaired.length) throw new Error("协议修复不得改变计划步骤数量");
    const fields = ["kind", "title", "description", "action", "command", "risk", "expected", "validation", "executionScope",
      "validationScope", "runtimeClass", "sessionContextChange", "recovery", "status"] as const;
    repair.previousModelOutput.forEach((previous, index) => {
      fields.forEach(field => {
        if (stableProtocolValue(protocolFieldValue(previous, field)) === stableProtocolValue(protocolFieldValue(repaired[index], field))) return;
        const shellRepair = allowed.includes(`steps[${index}].action.command`) && previous.action?.type === "shell" && repaired[index].action?.type === "shell";
        if (shellRepair && (field === "command" || field === "action")) return;
        if (!allowed.includes(`steps[${index}].${field}`)) throw new Error(`协议修复不得改写 steps[${index}].${field}`);
        if (field === "command") {
          const beforeTool = previous.action?.type === "tool" ? previous.action.toolId : undefined;
          const afterTool = repaired[index].action?.type === "tool" ? repaired[index].action.toolId : undefined;
          if (beforeTool !== afterTool) throw new Error("协议修复不得替换工具或在工具和 Shell 之间转换");
        }
      });
    });
    return;
  }
  if (repair.previousModelOutput.length !== repaired.length) {
    throw new Error("工具参数格式修复不得改变计划步骤数量");
  }
  const precisePaths = repair.diagnostic?.allowedRepairPaths;
  const legacyField = repair.fieldPath?.match(/fields\[key=([^\]]+)\]\.(type|credential\.target)$/);
  if (precisePaths ? !precisePaths.length : !legacyField) {
    throw new Error("PROTOCOL_REPAIR_SCOPE_UNKNOWN：工具参数缺少可验证的局部修复字段");
  }
  const immutable = ["kind", "title", "description", "risk", "expected", "validation", "executionScope",
    "validationScope", "runtimeClass", "sessionContextChange", "recovery", "status"] as const;
  const errorStep = repair.fieldPath?.match(/^steps\[(\d+)\]/)?.[1];
  repair.previousModelOutput.forEach((previous, index) => {
    const changed = immutable.find((field) => stableProtocolValue(protocolFieldValue(previous, field))
      !== stableProtocolValue(protocolFieldValue(repaired[index], field)));
    if (changed) throw new Error(`工具参数格式修复不得改写 steps[${index}].${changed}`);
    const originalTool = previous.action?.type === "tool" ? previous.action.toolId : undefined;
    if (originalTool !== (repaired[index]?.action?.type === "tool" ? repaired[index].action.toolId : undefined)) {
      throw new Error("工具参数修复不得替换工具或转成 Shell 命令");
    }
    if (previous.command !== repaired[index].command) throw new Error("工具参数修复不得夹带 Shell 命令");
    if ((!originalTool || (errorStep !== undefined && index !== Number(errorStep))) && previous.command !== repaired[index].command) {
      throw new Error(`工具参数格式修复不得改写无关命令 steps[${index}].command`);
    }
    if (index !== Number(errorStep) && stableProtocolValue(previous.action) !== stableProtocolValue(repaired[index].action)) throw new Error("工具参数修复不得改写其他步骤 action");
    if (originalTool && precisePaths && index === Number(errorStep)) {
      const prefix = `steps[${index}].action.arguments.`;
      if (!precisePaths.every(path => path.startsWith(prefix))) throw new Error("协议修复字段不属于报错工具参数");
      const remainder = (step: PlanStep) => {
        const args = step.action?.type === "tool" ? JSON.parse(JSON.stringify(step.action.arguments)) as Record<string, any> : undefined;
        if (!args) throw new Error("协议修复必须保留有效的原子工具调用");
        for (const path of precisePaths) {
          const local = path.slice(prefix.length);
          if (!/^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[\d+\]))*$/.test(local)) {
            throw new Error("协议修复字段路径无效");
          }
          const keys = local.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g)!;
          let parent = args;
          for (const key of keys.slice(0, -1)) {
            if (!parent || typeof parent !== "object" || !Object.prototype.hasOwnProperty.call(parent, key)) {
              throw new Error("协议修复不得删除或替换报错字段的父结构");
            }
            parent = parent[key];
          }
          if (!parent || typeof parent !== "object") throw new Error("协议修复不得替换报错字段的父结构");
          const leaf = keys[keys.length - 1];
          if (Array.isArray(parent)) {
            const position = Number(leaf);
            if (!Number.isInteger(position) || position < 0 || position >= parent.length
              || !Object.prototype.hasOwnProperty.call(parent, position)) {
              throw new Error("协议修复不得删除报错数组元素或改变其位置");
            }
            parent[position] = null; // Mask only an existing slot; never restore a deleted tail.
          } else delete parent[leaf];
        }
        return stableProtocolValue(args);
      };
      if (remainder(previous) !== remainder(repaired[index])) {
        throw new Error("协议修复只能修改报错字段，不能改写其他工具参数");
      }
    }
    const localField = repair.fieldPath?.match(/fields\[key=([^\]]+)\]\.(type|credential\.target)$/);
    if (originalTool && localField && index === Number(errorStep)) {
      const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
      const remainder = (step: PlanStep) => {
        const args = step.action?.type === "tool" ? JSON.parse(JSON.stringify(step.action.arguments)) as Record<string, any> : undefined;
        if (!args) throw new Error("协议修复必须保留有效的原子工具调用");
        const field = args.fields?.find((item: { key?: string }) => item.key === localField[1]);
        if (!field) throw new Error("协议修复不得删除报错字段");
        if (localField[2] === "type") delete field.type;
        else if (field.credential) delete field.credential.target;
        return stable(args);
      };
      if (remainder(previous) !== remainder(repaired[index])) {
        throw new Error("协议修复只能修改报错字段，不能改写其他工具参数");
      }
    }
  });
}

/** A local field repair must still leave the complete model plan protocol-valid. */
function normalizeRepairedPlan(steps: PlanStep[], requirement: string) {
  return normalizePlanPreconditions(steps, requirement);
}

function planProtocolRepairRequirement(repair: PlanNormalizationRepair) {
  return `只修复 context.planGenerationRepair 中的被拒步骤，按 previousModelOutput 顺序返回 steps；其余原计划由 Core 本地合并。不得改变业务、工具、步骤范围或授权。${repair.instruction}`;
}

function beginProtocolRepair(repair: PlanNormalizationRepair, context: string) {
  const scopeFingerprint = protocolRepairScopeFingerprint(context, repair.diagnostic);
  if (!repair.progress || repair.progress.scopeFingerprint !== scopeFingerprint) {
    repair.progress = { scopeFingerprint, attemptedFingerprints: [], seenPlans: [], attemptCount: 0 };
  }
  const progress = repair.progress;
  const fingerprint = planSemanticFingerprint(repair.previousModelOutput);
  const attempt = `${repair.diagnostic?.code ?? repair.errorCode}:${repair.fieldPath}:${fingerprint}`;
  if (progress.stopCode || progress.attemptedFingerprints.includes(attempt)) {
    progress.stopCode ??= "PROTOCOL_REPAIR_NO_PROGRESS";
    throw new PlanProtocolError(repair, protocolRepairStopMessage(progress));
  }
  if (progress.attemptCount >= 3) {
    progress.stopCode = "PROTOCOL_REPAIR_BUDGET_EXHAUSTED";
    throw new PlanProtocolError(repair, "PROTOCOL_REPAIR_BUDGET_EXHAUSTED：同一事故达到协议修复上限");
  }
  let knownScope = repair.diagnostic
    ? Boolean(repair.diagnostic.allowedRepairPaths.length)
    : repair.errorCode === "tool_schema_validation_failed"
      && /^steps\[\d+\]\.action\.arguments\.fields\[key=[^\]]+\]\.(type|credential\.target)$/.test(repair.fieldPath ?? "");
  if (repair.diagnostic?.allowedRepairPaths.some(path => /\.recovery(?:\.|$)/.test(path))) {
    const recovery = protocolRepairAuthority(context).recovery;
    const failedAttempts = recovery?.failedAttempts ?? recovery?.blockers;
    knownScope = knownScope && Array.isArray(failedAttempts) && failedAttempts.length > 0;
  }
  if (!knownScope) {
    progress.stopCode = "PROTOCOL_REPAIR_SCOPE_UNKNOWN";
    throw new PlanProtocolError(repair, "PROTOCOL_REPAIR_SCOPE_UNKNOWN：缺少明确修复字段，需要补充权威上下文或业务调整");
  }
  progress.attemptedFingerprints.push(attempt);
  if (!progress.seenPlans.includes(fingerprint)) progress.seenPlans.push(fingerprint);
  progress.attemptCount += 1;
}

function mergeScopedProtocolRepairSteps(repair: PlanNormalizationRepair, response: PlanStep[]) {
  try {
    const merged = mergeProtocolRepairSteps(repair.previousModelOutput, response, repair.fieldPath);
    assertPlanRepairScope(repair, merged);
    return merged;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (repair.progress) {
      repair.progress.stopCode = reason.startsWith("PROTOCOL_REPAIR_SCOPE_UNKNOWN")
        ? "PROTOCOL_REPAIR_SCOPE_UNKNOWN" : "PROTOCOL_REPAIR_SCOPE_VIOLATION";
      repair.progress.stopReason = reason;
      throw new PlanProtocolError(repair, protocolRepairStopMessage(repair.progress));
    }
    throw error;
  }
}

/** One model attempt, one local merge, full validation; progress survives persistence. */
async function executeProtocolRepair(repair: PlanNormalizationRepair, requirement: string, runtimeModel: RuntimeModel) {
  runtimeModel = { ...runtimeModel, context: ensureModelRecoveryContext(runtimeModel.context, repair.modelRecovery) };
  runtimeModel.assertCurrent?.();
  const modelRecovery = recoveryFromContext(runtimeModel.context);
  repair = normalizePlanRepairStrategy(repair);
  repair.modelRecovery = modelRecovery;
  if (repair.businessReplanRequired || repair.validationError.includes("将进程脱离执行器跟踪")) {
    throw new PlanProtocolError(repair, "业务动作已超出局部修复范围，需要重新规划剩余工作及其依赖验收");
  }
  if (isPlanModeConflictRepair(repair)) throw atomicPlanModeConflict(repair);
  // Persisted acceptance-copy errors belong to the retired business gate.
  // Revalidate the proposal under current protocol/safety rules; this only
  // returns a candidate plan and never grants approval or rewrites evidence.
  if (repair.diagnostic?.code === "RECOVERY_ACCEPTANCE_MISMATCH") {
    try {
      return normalizeRepairedPlan(repair.previousModelOutput, requirement);
    } catch (error) {
      repair = { ...buildPlanNormalizationRepair(error, repair.previousModelOutput),
        nextStageDecision: repair.nextStageDecision };
    }
  }
  // Legacy tool feedback named only a step. Re-run the actual validator on
  // that preserved step; never infer argument authority from its error text.
  if (!repair.diagnostic && repair.errorCode === "tool_schema_validation_failed") {
    const index = Number(repair.fieldPath?.match(/^steps\[(\d+)\]/)?.[1] ?? -1);
    const step = repair.previousModelOutput[index];
    if (step) {
      let accepted = false;
      try { normalizePlanPreconditions([step], requirement); accepted = true; } catch (error) {
        const issue = readRecoveryProtocolError(error);
        if (issue) {
          const remap = (path: string) => path.replace(/^steps\[0\]/, `steps[${index}]`);
          repair = { ...buildPlanNormalizationRepair(new RecoveryProtocolError({ ...issue, stepIndex: index,
            fieldPath: remap(issue.fieldPath), allowedRepairPaths: issue.allowedRepairPaths.map(remap) }), repair.previousModelOutput),
            progress: repair.progress, nextStageDecision: repair.nextStageDecision };
        }
      }
      if (accepted) {
        try { return normalizeRepairedPlan(repair.previousModelOutput, requirement); } catch (error) {
          repair = { ...buildPlanNormalizationRepair(error, repair.previousModelOutput),
            progress: repair.progress, nextStageDecision: repair.nextStageDecision };
        }
      }
    }
  }
  // Old saved recovery errors used misleading text. Derive current structured
  // feedback from preserved source, never from guessed step IDs in that text.
  if (!repair.diagnostic && repair.errorCode === "plan_normalization_failed"
    && repair.repairStrategy?.type === "plan_protocol") {
    try {
      return normalizePlanPreconditions(repair.previousModelOutput, requirement);
    } catch (error) {
      if (readRecoveryProtocolError(error)) {
        repair = { ...buildPlanNormalizationRepair(error, repair.previousModelOutput), progress: repair.progress };
      }
    }
  }
  try {
    repair.modelRecovery = modelRecovery;
    if (isPlanModeConflictRepair(repair)) throw atomicPlanModeConflict(repair);
    beginProtocolRepair(repair, runtimeModel.context);
    if (outputStrategyFromContext(runtimeModel.context) === "regenerate") throw new PlanProtocolError(repair, "完整候选重生成仍未通过校验，本轮输出恢复已结束");
    const response = await invoke<PlanStep[]>("generate_ai_plan", {
      apiKey: runtimeModel.apiKey, endpoint: runtimeModel.endpoint, model: runtimeModel.model,
      requirement: planProtocolRepairRequirement(repair),
      context: parameterContext(withModelOutputStrategy(compactProtocolRepairContext(runtimeModel.context, repair), "field_repair"), runtimeModel.requestParameters, runtimeModel.capabilities, modelIntegrationConfig(runtimeModel)),
      generationSettings: runtimeModel.generationSettings, timeoutSeconds: runtimeModel.timeoutSeconds,
    });
    runtimeModel.assertCurrent?.();
    const merged = mergeScopedProtocolRepairSteps(repair, response);
    const fingerprint = planSemanticFingerprint(merged);
    if (repair.progress!.seenPlans.includes(fingerprint)) {
      repair.progress!.stopCode = "PROTOCOL_REPAIR_NO_PROGRESS";
      throw new PlanProtocolError(repair, "PROTOCOL_REPAIR_NO_PROGRESS：修复未改变执行内容或返回此前被拒的计划，已停止重复请求");
    }
    try {
      return normalizeRepairedPlan(merged, requirement);
    } catch (error) {
      if (error instanceof PlanProtocolError) {
        error.repair.progress = repair.progress;
        error.repair.nextStageDecision = repair.nextStageDecision;
        throw error;
      }
      const nextRepair = { ...buildPlanNormalizationRepair(error, merged), progress: repair.progress,
        nextStageDecision: repair.nextStageDecision };
      if (isPlanModeConflictRepair(nextRepair)) throw atomicPlanModeConflict(nextRepair);
      throw new PlanProtocolError(nextRepair, String(error));
    }
  } catch (error) {
    if (error instanceof PlanProtocolError) {
      error.repair.modelRecovery = modelRecovery;
      throw error;
    }
    const rustFailure = rustProtocolFailure(error, runtimeModel.context);
    if (rustFailure) {
      // A compact repair response is relative to its one-step request. Keep the
      // full original plan authoritative and reject all out-of-scope changes.
      try {
        const merged = mergeScopedProtocolRepairSteps(repair, rustFailure.repair.previousModelOutput);
        const issue = rustFailure.repair.diagnostic!;
        const index = Number(repair.fieldPath?.match(/^steps\[(\d+)\]/)?.[1] ?? issue.stepIndex);
        const remap = (path: string) => path.replace(/^steps\[\d+\]/, `steps[${index}]`);
        const current = buildPlanNormalizationRepair(new RecoveryProtocolError({ ...issue, stepIndex: index,
          fieldPath: remap(issue.fieldPath), allowedRepairPaths: issue.allowedRepairPaths.map(remap),
        }), merged);
        current.progress = repair.progress;
        current.modelRecovery = modelRecovery;
        current.nextStageDecision = repair.nextStageDecision;
        if (current.progress && rustFailure.repair.progress?.stopCode) {
          current.progress.stopCode = rustFailure.repair.progress.stopCode;
          current.progress.stopReason = rustFailure.repair.progress.stopReason;
        } else if (current.progress?.seenPlans.includes(planSemanticFingerprint(merged))) {
          current.progress.stopCode = "PROTOCOL_REPAIR_NO_PROGRESS";
        }
        const failure = new PlanProtocolError(current, current.progress?.stopCode
          ? protocolRepairStopMessage(current.progress) : rustFailure.repairError);
        failure.developerTrace = rustFailure.developerTrace;
        throw failure;
      } catch (mergedError) {
        if (mergedError instanceof PlanProtocolError) throw mergedError;
        throw new PlanProtocolError(repair, String(mergedError));
      }
    }
    const invocationError = normalizeModelInvocationError(error);
    if (modelServiceError(invocationError)) throw invocationError;
    throw new PlanProtocolError(repair, String(invocationError));
  }
}

export const backend = {
  async configureTaskCapabilities(taskId: string, allowShell: boolean) {
    if (isTauri()) await invoke("configure_task_execution", { taskId, allowShell });
  },
  async appendTaskLog(stream: "events" | "developer-events", event: unknown, context: unknown) {
    if (isTauri()) await invoke("append_task_log", { stream, event, context });
  },
  async queryTaskLogs<T = unknown>(query: DiskLogQuery): Promise<DiskLogQueryResult<T> | null> {
    if (!isTauri()) return null;
    return invoke<DiskLogQueryResult<T>>("query_task_logs", { query });
  },
  async saveTaskEvidence(taskId: string, record: Record<string, unknown>) {
    if (!isTauri()) throw new Error("证据持久化需要桌面存储");
    return invoke<string>("save_task_evidence", { taskId, record });
  },
  async readTaskEvidence(taskId: string, evidenceId: string, offset: number, limit: number) {
    return invoke<Record<string, unknown>>("read_task_evidence", { taskId, evidenceId, offset, limit });
  },
  async saveCredential(kind: CredentialKind, id: string, value: string) {
    if (!isTauri()) return;
    await invoke("save_credential", { kind, id, value });
  },

  async loadCredential(kind: CredentialKind, id: string): Promise<string | null> {
    if (!isTauri()) return null;
    return invoke<string | null>("load_credential", { kind, id });
  },

  async deleteCredential(kind: CredentialKind, id: string) {
    if (!isTauri()) return;
    await invoke("delete_credential", { kind, id });
  },

  async checkSshConnection(connection: RuntimeConnection, timeoutMs = 5000): Promise<void> {
    if (!isTauri()) return requireDesktopRuntime("SSH 连接确认");
    return invoke<void>("check_ssh_connection", { ...connection, timeoutMs });
  },

  async probeSsh(connection: RuntimeConnection): Promise<SshProbe> {
    if (!isTauri()) {
      return requireDesktopRuntime("SSH 连接");
    }
    return invoke("probe_ssh_server", {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
    });
  },

  async createAgentTerminal(
    serverId: string,
    taskId: string,
    connection: Omit<RuntimeConnection, "password">,
  ): Promise<AgentSessionRef> {
    if (!isTauri()) return requireDesktopRuntime("Agent 沙箱终端");
    return invoke<AgentSessionRef>("create_agent_terminal", { serverId, taskId, ...connection });
  },

  async updateAgentSessionContext(session: AgentSessionRef, context: AgentSessionContext) {
    if (!isTauri()) return requireDesktopRuntime("Agent 会话上下文");
    return invoke<AgentSessionRef>("update_agent_session_context", {
      sessionId: session.id,
      generation: session.generation,
      context,
    });
  },

  async executeAgentCommand(input: {
    connection: RuntimeConnection;
    session: Pick<AgentSessionRef, "id" | "generation">;
    executionId: string;
    command: string;
    scope: ExecutionScope;
    approvedHighRisk: boolean;
    promptCredential?: AgentPromptCredential;
    onProgress?(event: AgentTerminalOutputEvent): void;
    onSessionInvalidated?(generation?: number): void;
  }): Promise<AgentCommandResult> {
    if (!isTauri()) return requireDesktopRuntime("Agent 沙箱命令执行");
    let unlisten: (() => void) | undefined;
    if (input.onProgress || input.onSessionInvalidated) {
      unlisten = await listen<AgentTerminalOutputEvent>("agent-terminal-output", (event) => {
        if (event.payload.sessionId === input.session.id
          && event.payload.executionId === input.executionId
          && event.payload.stream === "error"
          && event.payload.generation > input.session.generation) {
          input.onSessionInvalidated?.(event.payload.generation);
          return;
        }
        if (
          event.payload.sessionId === input.session.id
          && event.payload.generation === input.session.generation
          && event.payload.executionId === input.executionId
        ) input.onProgress?.(event.payload);
      });
    }
    try {
      return await runDirectExecution({ executionId: input.executionId, connections: [input.connection],
        additionalSecrets: input.promptCredential?.secret ? [input.promptCredential.secret] : undefined,
        phase: "command", action: { type: "shell", command: input.command },
        targets: [{ role: "execution", host: input.connection.host, port: input.connection.port, username: input.connection.username,
          agentSession: { id: input.session.id, generation: input.session.generation, contextRevision: 0 } }],
        classifyResult: result => result.exitCode === undefined ? "unknown" : result.exitCode === 0 ? "succeeded" : "failed",
        execute: () => invoke<AgentCommandResult>("execute_agent_terminal_command", {
        ...input.connection,
        sessionId: input.session.id,
        generation: input.session.generation,
        executionId: input.executionId,
        command: input.command,
        scope: input.scope,
        approvedHighRisk: input.approvedHighRisk,
        promptCredential: input.promptCredential,
      }) });
    } catch (error) {
      const transportError = error && typeof error === "object" && "originalError" in error ? error.originalError : error;
      if (isTerminalTransportFailure(transportError)) input.onSessionInvalidated?.();
      throw error;
    } finally {
      unlisten?.();
    }
  },

  async interruptAgentCommand(
    connection: RuntimeConnection,
    session: Pick<AgentSessionRef, "id" | "generation">,
    executionId: string,
  ) {
    if (!isTauri()) return false;
    return cancelDirectExecution(executionId, () => invoke<boolean>("interrupt_agent_terminal_command", {
      ...connection,
      sessionId: session.id,
      generation: session.generation,
      executionId,
    }));
  },

  async sampleAgentExecutionProgress(
    connection: RuntimeConnection,
    session: Pick<AgentSessionRef, "id" | "generation">,
    executionId: string,
  ): Promise<AgentRuntimeProgress> {
    if (!isTauri()) return requireDesktopRuntime("Agent 运行态采样");
    return invoke<AgentRuntimeProgress>("sample_agent_terminal_progress", {
      ...connection,
      sessionId: session.id,
      generation: session.generation,
      executionId,
    });
  },

  async closeAgentTerminal(sessionId: string) {
    if (!isTauri()) return;
    await invoke("close_agent_terminal", { sessionId });
  },

  async startTerminal(terminalId: string, connection: RuntimeConnection, cols = 120, rows = 32) {
    if (!isTauri()) return requireDesktopRuntime("SSH 终端");
    return invoke<number>("start_ssh_terminal", { terminalId, ...connection, cols, rows });
  },

  async writeTerminal(terminalId: string, data: string) {
    if (!isTauri()) return;
    await invoke("write_ssh_terminal", { terminalId, data });
  },

  async resizeTerminal(terminalId: string, cols: number, rows: number) {
    if (!isTauri()) return;
    await invoke("resize_ssh_terminal", { terminalId, cols, rows });
  },

  async closeTerminal(terminalId: string) {
    if (!isTauri()) return;
    await invoke("close_ssh_terminal", { terminalId });
  },

  async onTerminalOutput(callback: (event: TerminalOutputEvent) => void) {
    if (!isTauri()) return () => {};
    return listen<TerminalOutputEvent>("terminal-output", (event) => callback(event.payload));
  },

  async onTerminalStatus(callback: (event: TerminalStatusEvent) => void) {
    if (!isTauri()) return () => {};
    return listen<TerminalStatusEvent>("terminal-status", (event) => callback(event.payload));
  },

  async getMetrics(): Promise<Metrics> {
    if (isTauri()) {
      const metrics = await invoke<Metrics>("get_realtime_metrics");
      return { ...metrics, sampledAt: new Date().toISOString() };
    }
    return requireDesktopRuntime("实时指标采集");
  },

  async getSshMetrics(connection: RuntimeConnection): Promise<Metrics> {
    if (!isTauri()) return requireDesktopRuntime("SSH 实时指标采集");
    const metrics = await invoke<Metrics>("get_ssh_metrics", {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
    });
    return { ...metrics, sampledAt: new Date().toISOString() };
  },

  async listSftp(connection: RuntimeConnection, path: string): Promise<FileEntry[]> {
    if (!isTauri()) {
      return requireDesktopRuntime("SFTP 目录读取");
    }
    const entries = await invoke<FileEntry[]>("list_sftp_directory", {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
      path,
    });
    return entries.map((entry) => ({
      ...entry,
      modified: /^\d+$/.test(entry.modified)
        ? new Date(Number(entry.modified) * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric" })
        : entry.modified,
    }));
  },

  async getRemoteFileStructure(
    connection: RuntimeConnection,
    request: FileStructureRequest,
  ): Promise<FileStructureScanResult> {
    const normalized = normalizeFileStructureRequest(request);
    if (!isTauri()) {
      return requireDesktopRuntime("远程文件结构读取");
    }
    return invoke<FileStructureScanResult>("get_remote_file_structure", {
      ...connection,
      ...normalized,
    });
  },

  async createSftpDirectory(connection: RuntimeConnection, path: string) {
    if (!isTauri()) return requireDesktopRuntime("SFTP 创建目录");
    await runDirectExecution({ executionId: directExecutionId(), connections: [connection], phase: "tool",
      action: { type: "tool", toolId: "core.sftp.create_directory", arguments: { path } },
      execute: () => invoke("create_sftp_directory", { ...connection, path }) });
  },

  async renameSftpEntry(connection: RuntimeConnection, fromPath: string, toPath: string) {
    if (!isTauri()) return requireDesktopRuntime("SFTP 重命名");
    await runDirectExecution({ executionId: directExecutionId(), connections: [connection], phase: "tool",
      action: { type: "tool", toolId: "core.sftp.rename", arguments: { fromPath, toPath } },
      execute: () => invoke("rename_sftp_entry", { ...connection, fromPath, toPath }) });
  },

  async deleteSftpEntry(connection: RuntimeConnection, path: string, kind: FileEntry["kind"]) {
    if (!isTauri()) return requireDesktopRuntime("SFTP 删除");
    await runDirectExecution({ executionId: directExecutionId(), connections: [connection], phase: "tool",
      action: { type: "tool", toolId: "core.sftp.delete", arguments: { path, kind } },
      execute: () => invoke("delete_sftp_entry", { ...connection, path, kind }) });
  },

  async readSftpFile(connection: RuntimeConnection, path: string) {
    if (!isTauri()) return requireDesktopRuntime("SFTP 文件读取");
    const bytes = await invoke<number[]>("read_sftp_file", { ...connection, path });
    return new Uint8Array(bytes);
  },

  async readSftpFilePrefix(connection: RuntimeConnection, path: string, maxBytes: number) {
    if (!isTauri()) return requireDesktopRuntime("SFTP 有界文件读取");
    const result = await invoke<{ data: number[]; totalBytes: number }>("read_sftp_file_prefix", {
      ...connection,
      path,
      maxBytes,
    });
    return { data: new Uint8Array(result.data), totalBytes: result.totalBytes };
  },

  async writeSftpFile(connection: RuntimeConnection, path: string, data: Uint8Array) {
    if (!isTauri()) return requireDesktopRuntime("SFTP 文件写入");
    const content = await fileContentIdentity(data);
    await runDirectExecution({ executionId: directExecutionId(), connections: [connection], phase: "tool",
      action: { type: "tool", toolId: "core.sftp.write_file", arguments: { path, content } },
      execute: () => invoke("write_sftp_file", { ...connection, path, data: Array.from(data) }) });
  },

  async readLocalFileForUpload(path: string) {
    if (!isTauri()) return requireDesktopRuntime("读取拖放文件");
    const bytes = await invoke<number[]>("read_local_file_for_upload", { path });
    return new Uint8Array(bytes);
  },

  async uploadSftpTransfer(
    connection: RuntimeConnection,
    transferId: string,
    path: string,
    data: Uint8Array,
    onProgress: (event: SftpTransferProgressEvent) => void,
  ) {
    if (!isTauri()) {
      return requireDesktopRuntime("SFTP 上传");
    }
    const unlisten = await listen<SftpTransferProgressEvent>("sftp-transfer-progress", (event) => {
      if (event.payload.transferId === transferId) onProgress(event.payload);
    });
    try {
      const content = await fileContentIdentity(data);
      await runDirectExecution({ executionId: transferId, connections: [connection], phase: "tool",
        action: { type: "tool", toolId: "core.sftp.upload", arguments: { path, content } },
        execute: () => invoke("upload_sftp_transfer", {
        ...connection,
        transferId,
        path,
        data: Array.from(data),
      }) });
    } finally {
      unlisten();
    }
  },

  async downloadSftpTransfer(
    connection: RuntimeConnection,
    transferId: string,
    path: string,
    onProgress: (event: SftpTransferProgressEvent) => void,
  ) {
    if (!isTauri()) {
      return requireDesktopRuntime("SFTP 下载");
    }
    const unlisten = await listen<SftpTransferProgressEvent>("sftp-transfer-progress", (event) => {
      if (event.payload.transferId === transferId) onProgress(event.payload);
    });
    try {
      const bytes = await invoke<number[]>("download_sftp_transfer", { ...connection, transferId, path });
      return new Uint8Array(bytes);
    } finally {
      unlisten();
    }
  },

  async transferSftpBetweenServers(
    source: RuntimeConnection,
    target: RuntimeConnection,
    transferId: string,
    sourcePath: string,
    targetPath: string,
    overwrite: boolean,
    onProgress?: (event: SftpTransferProgressEvent) => void,
  ) {
    if (!isTauri()) return requireDesktopRuntime("跨服务器文件传输");
    const unlisten = onProgress
      ? await listen<SftpTransferProgressEvent>("sftp-transfer-progress", (event) => {
          if (event.payload.transferId === transferId) onProgress(event.payload);
        })
      : undefined;
    try {
      return await runDirectExecution({ executionId: transferId, connections: [source, target], phase: "tool",
        action: { type: "tool", toolId: "files.transfer_between_servers", arguments: { sourcePath, targetPath, overwrite } },
        targets: [{ role: "source", host: source.host, port: source.port, username: source.username, path: sourcePath },
          { role: "target", host: target.host, port: target.port, username: target.username, path: targetPath, overwrite }],
        execute: () => invoke<ServerTransferResult>("transfer_sftp_between_servers", {
        transferId,
        sourceHost: source.host,
        sourcePort: source.port,
        sourceUsername: source.username,
        sourcePassword: source.password,
        sourcePath,
        targetHost: target.host,
        targetPort: target.port,
        targetUsername: target.username,
        targetPassword: target.password,
        targetPath,
        overwrite,
      }) });
    } finally {
      unlisten?.();
    }
  },

  async cancelSftpTransfer(transferId: string) {
    if (!isTauri()) {
      return requireDesktopRuntime("SFTP 传输取消");
    }
    return cancelDirectExecution(transferId, () => invoke<boolean>("cancel_sftp_transfer", { transferId }));
  },

  async generatePlan(requirement: string, runtimeModel?: RuntimeModel): Promise<PlanStep[]> {
    if (isTauri() && runtimeModel?.apiKey) {
      runtimeModel = runtimeWithModelRecovery(runtimeModel);
      let pendingRepair: PlanNormalizationRepair | undefined;
      try { pendingRepair = JSON.parse(runtimeModel.context || "{}").planGenerationRepair; } catch { /* legacy context */ }
      if (pendingRepair) {
        return legacyModelOperationValue("plan.repair", await executeProtocolRepair(pendingRepair, requirement, runtimeModel));
      }
      const original = { ...runtimeModel, context: withModelOutputStrategy(runtimeModel.context,
        outputStrategyFromContext(runtimeModel.context) ?? "initial") };
      const generate = async (runtime: RuntimeModel) => {
        runtime.assertCurrent?.();
        let steps: PlanStep[];
        try {
          steps = await invoke<PlanStep[]>("generate_ai_plan", {
          apiKey: runtime.apiKey,
          endpoint: runtime.endpoint,
          model: runtime.model,
          requirement,
          context: parameterContext(runtime.context, runtime.requestParameters, runtime.capabilities, modelIntegrationConfig(runtime)),
          generationSettings: runtime.generationSettings,
          timeoutSeconds: runtime.timeoutSeconds,
          });
        } catch (error) {
          runtime.assertCurrent?.();
          const failure = rustProtocolFailure(error, runtime.context);
          if (failure && !failure.repair.progress?.stopCode && outputStrategyFromContext(runtime.context) === "initial") {
            return executeProtocolRepair(failure.repair, requirement, runtime);
          }
          throw failure ?? normalizeModelInvocationError(error);
        }
        runtime.assertCurrent?.();
        modelOperationResult("plan.generate", steps);
        try {
          return legacyModelOperationValue("plan.generate", normalizePlanPreconditions(steps, requirement));
        } catch (firstError) {
          const repair = buildPlanNormalizationRepair(firstError, steps);
          repair.modelRecovery = recoveryFromContext(runtime.context);
          if (isPlanModeConflictRepair(repair)) throw atomicPlanModeConflict(repair);
          if (outputStrategyFromContext(runtime.context) !== "initial") throw new PlanProtocolError(repair, String(firstError));
          return legacyModelOperationValue("plan.repair", await executeProtocolRepair(repair, requirement, runtime));
        }
      };
      try {
        return await generate(original);
      } catch (error) {
        original.assertCurrent?.();
        const context = parseRepairContext(original.context);
        if (outputStrategyFromContext(original.context) !== "initial" || context.workflowPhase === "protocol_repair"
          || context.operationalRepair?.rejectedProposal?.responseMode === "metadata_fields" || !canRegenerateModelCandidate(error)) throw error;
        try {
          return await generate({ ...original, context: candidateRegenerationContext(original.context, modelCandidateDiagnostic(error)) });
        } catch (failure) {
          throw exhaustedCandidateRecovery(failure);
        }
      }
    }
    if (isTauri()) return Promise.reject(new Error("未配置真实大模型连接，拒绝生成预制计划"));
    return requireDesktopRuntime("智能计划生成");
  },

  async generateSkill(
    requirement: string,
    mode: "generate" | "optimize",
    runtimeModel: RuntimeModel,
    currentSkill?: GeneratedSkillDraft,
  ): Promise<GeneratedSkillDraft> {
    if (!isTauri()) return requireDesktopRuntime("AI Skill 生成");
    try {
      return legacyModelOperationValue("skill.draft", await invoke<GeneratedSkillDraft>("generate_ai_skill", {
        apiKey: runtimeModel.apiKey,
        endpoint: runtimeModel.endpoint,
        model: runtimeModel.model,
        requirement,
        mode,
        currentSkill: currentSkill ?? null,
        requestParameters: runtimeModel.requestParameters,
        capabilities: runtimeModel.capabilities,
        integration: modelIntegrationConfig(runtimeModel),
        timeoutSeconds: runtimeModel.timeoutSeconds,
      }));
    } catch (error) {
      throw normalizeModelInvocationError(error);
    }
  },

  async analyzePlanStepSafety(
    command: string,
    validation: string,
    repair = false,
  ): Promise<PlanStepSafetyAnalysis> {
    if (!isTauri()) return analyzePlanStepSafetyLocally(command, validation, repair);
    return invoke<PlanStepSafetyAnalysis>("analyze_plan_step_safety", {
      command,
      validation,
      repair,
    });
  },

  async processRequirement(
    requirement: string,
    runtimeModel: RuntimeModel,
    skillDefinitions: ModelSkillDefinition[] = [],
  ): Promise<RequirementProcessingResult> {
    if (isTauri()) {
      runtimeModel = runtimeWithModelRecovery(runtimeModel);
      runtimeModel = { ...runtimeModel, context: withModelOutputStrategy(runtimeModel.context, "initial") };
      runtimeModel.assertCurrent?.();
      let result: RequirementProcessingResult;
      try {
        result = await invoke<RequirementProcessingResult>("process_ai_requirement", {
          apiKey: runtimeModel.apiKey,
          endpoint: runtimeModel.endpoint,
          model: runtimeModel.model,
          requirement,
          context: parameterContext(runtimeModel.context, runtimeModel.requestParameters, runtimeModel.capabilities, modelIntegrationConfig(runtimeModel)),
          skillDefinitions,
          generationSettings: runtimeModel.generationSettings,
          timeoutSeconds: runtimeModel.timeoutSeconds,
        });
      } catch (error) {
        runtimeModel.assertCurrent?.();
        throw normalizeModelInvocationError(error);
      }
      runtimeModel.assertCurrent?.();
      const classified = modelOperationResult("requirement.classify", result);
      // Answers and context requests have no candidate action domain to normalize/repair.
      if (classified.classification.intent !== "execute") return legacyModelOperationValue("requirement.classify", result);
      const planContext = classifiedPlanContext(runtimeModel.context, result, skillDefinitions, requirement);
      let failure: unknown;
      if (result.planError) failure = rustProtocolFailure(result.planError, planContext) ?? normalizeModelInvocationError(result.planError);
      else {
        try {
          return legacyModelOperationValue("requirement.classify", { ...result, plan: normalizePlanPreconditions(result.plan, requirement) });
        } catch (error) {
          failure = new PlanProtocolError(buildPlanNormalizationRepair(error, result.plan), String(error));
        }
      }
      if (result.planError && modelServiceError(failure) && !canRegenerateModelCandidate(failure)) {
        return legacyModelOperationValue("requirement.classify", { ...result, plan: [] });
      }
      // Classification is already authoritative. Repair only its unexecuted plan,
      // with the classified constraints/Skills and the original operation budget.
      if (failure instanceof PlanProtocolError && !failure.repair.progress?.stopCode) {
        try {
          const repaired = await executeProtocolRepair(failure.repair, requirement, { ...runtimeModel, context: planContext });
          return legacyModelOperationValue("requirement.classify", { ...result, plan: repaired, planError: undefined });
        } catch (error) { failure = error; }
      }
      runtimeModel.assertCurrent?.();
      if (canRegenerateModelCandidate(failure)) {
        try {
          const plan = await backend.generatePlan(requirement, { ...runtimeModel,
            context: candidateRegenerationContext(planContext, modelCandidateDiagnostic(failure)) });
          return legacyModelOperationValue("requirement.classify", { ...result, plan, planError: undefined });
        } catch (error) { failure = exhaustedCandidateRecovery(error); }
      }
      runtimeModel.assertCurrent?.();
      if (failure instanceof PlanProtocolError) {
        failure.processed = result;
        failure.developerTrace ??= result.developerTrace;
        throw failure;
      }
      const serviceError = modelServiceError(failure);
      if (serviceError) {
        return legacyModelOperationValue("requirement.classify", { ...result, plan: [],
          planError: `${MODEL_TRACE_ERROR_PREFIX}${JSON.stringify({ message: failure instanceof Error ? failure.message : "计划生成失败", modelError: serviceError })}` });
      }
      throw failure;
    }
    return requireDesktopRuntime("Opsark Agent");
  },

  async checkModel(runtimeModel: Omit<RuntimeModel, "context">, mode?: "parameters" | "structured" | "business"): Promise<ModelValidationResult> {
    if (!runtimeModel.apiKey) return { available: false, reason: "未配置 API Key" };
    if (!runtimeModel.endpoint.trim()) return { available: false, reason: "未配置接口地址" };
    if (!runtimeModel.model.trim()) return { available: false, reason: "未配置模型名称" };
    if (!isTauri()) return { available: false, reason: "需要在 Opsark 桌面端验证真实模型连接" };
    return legacyModelOperationValue("model.probe", await invoke("check_ai_model", {
      requestParameters: validateRequestParameters(runtimeModel.requestParameters),
      capabilities: runtimeModel.capabilities,
      integration: modelIntegrationConfig(runtimeModel),
      mode,
      apiKey: runtimeModel.apiKey,
      endpoint: runtimeModel.endpoint,
      model: runtimeModel.model,
      timeoutSeconds: runtimeModel.timeoutSeconds,
    }));
  },

  /** Offline preview uses the same native request builder without reading or forwarding a credential. */
  async previewModelRequest(runtimeModel: Pick<RuntimeModel, "endpoint" | "model" | "requestParameters" | "capabilities" | keyof ModelIntegration>, mode: "structured" | "parameters" | "business" = "structured"): Promise<ModelRequestPreview> {
    if (!isTauri()) return requireDesktopRuntime("模型请求预览");
    return invoke<ModelRequestPreview>("preview_ai_model_request", {
      endpoint: runtimeModel.endpoint,
      model: runtimeModel.model,
      requestParameters: validateRequestParameters(runtimeModel.requestParameters),
      capabilities: runtimeModel.capabilities,
      integration: modelIntegrationConfig(runtimeModel),
      mode,
    });
  },

  async generateSummary(requirement: string, steps: PlanStep[], runtimeModel?: RuntimeModel) {
    const fallback = buildExecutionSummary(requirement, steps);
    if (isTauri() && runtimeModel?.apiKey) {
      try {
        return legacyModelOperationValue("summary.generate", await invoke<string>("generate_ai_summary", {
          apiKey: runtimeModel.apiKey,
          endpoint: runtimeModel.endpoint,
          model: runtimeModel.model,
          requirement,
          executionContext: JSON.stringify({
            _log: runtimeModel.logContext,
            _requestParameters: validateRequestParameters(runtimeModel.requestParameters),
            _modelCapabilities: runtimeModel.capabilities,
            _modelIntegration: modelIntegrationConfig(runtimeModel),
            steps: steps.map(({ title, command, expected, status, output, result, evidence }) => ({
              title,
              command,
              expected,
              status,
              output,
              result,
              evidence: evidence?.map(({ type, source, facts, scope }) => ({ type, source, facts, scope })),
            })),
          }),
          timeoutSeconds: runtimeModel.timeoutSeconds,
        }));
      } catch {
        return fallback;
      }
    }
    return fallback;
  },

  async reviewStep(
    requirement: string,
    reviewContext: string,
    hasRemainingSteps: boolean,
    runtimeModel?: RuntimeModel,
  ): Promise<StepReview> {
    const fallback: StepReview = {
      decision: hasRemainingSteps ? "continue" : "complete",
      reason: runtimeModel?.apiKey
        ? "模型复核暂不可用，已按程序校验结果继续"
        : "未配置远程模型，已按程序校验结果处理",
      summary: hasRemainingSteps ? "程序校验通过，继续执行后续步骤。" : "程序校验通过，已完成全部步骤。",
      source: "rules",
    };
    if (!isTauri() || !runtimeModel?.apiKey) return fallback;
    try {
      const review = await invoke<Omit<StepReview, "source">>("review_ai_step", {
        apiKey: runtimeModel.apiKey,
        endpoint: runtimeModel.endpoint,
        model: runtimeModel.model,
        requirement,
        reviewContext: parameterContext(reviewContext, runtimeModel.requestParameters, runtimeModel.capabilities, modelIntegrationConfig(runtimeModel)),
        timeoutSeconds: runtimeModel.timeoutSeconds,
      });
      return legacyModelOperationValue("result.review", { ...review, source: "model" });
    } catch (error) {
      const invocationError = normalizeModelInvocationError(error);
      if (modelServiceError(invocationError) || invocationError instanceof ModelOperationBoundaryError) throw invocationError;
      return fallback;
    }
  },

  async reviewGoal(
    requirement: string,
    reviewContext: string,
    runtimeModel?: RuntimeModel,
  ): Promise<StepReview> {
    const fallback: StepReview = {
      decision: "adjust",
      reason: runtimeModel?.apiKey
        ? "整体目标复核暂不可用，不能仅因当前计划结束就判定整体任务完成"
        : "未配置可用模型，Core 不代替模型判定整体目标",
      summary: runtimeModel?.apiKey
        ? "当前阶段已经结束，但整体目标完成状态尚未得到可靠复核。"
        : "执行证据已保留，当前进入 blocked/no_action。",
      source: "rules",
    };
    if (!isTauri() || !runtimeModel?.apiKey) return fallback;
    try {
      const review = await invoke<Omit<StepReview, "source">>("review_ai_step", {
        apiKey: runtimeModel.apiKey,
        endpoint: runtimeModel.endpoint,
        model: runtimeModel.model,
        requirement,
        reviewContext: parameterContext(reviewContext, runtimeModel.requestParameters, runtimeModel.capabilities, modelIntegrationConfig(runtimeModel)),
        timeoutSeconds: runtimeModel.timeoutSeconds,
      });
      return legacyModelOperationValue("result.review", { ...review, source: "model" });
    } catch (error) {
      const invocationError = normalizeModelInvocationError(error);
      if (modelServiceError(invocationError) || invocationError instanceof ModelOperationBoundaryError) throw invocationError;
      return fallback;
    }
  },

  async decideNextStage(
    requirement: string,
    runtimeModel?: RuntimeModel,
  ): Promise<NextStageDecision> {
    const fallback: NextStageDecision = {
      decision: "adjust",
      reason: runtimeModel?.apiKey
        ? "下一阶段模型决策暂不可用，Core 不代替模型判定完成或继续"
        : "未配置可用模型，Core 不代替模型判定整体目标",
      summary: "当前阶段已结束，执行证据已保留，进入 blocked/no_action。",
      source: "rules",
      steps: [],
    };
    if (!isTauri() || !runtimeModel?.apiKey) return fallback;
    runtimeModel = runtimeWithModelRecovery(runtimeModel);
    runtimeModel = { ...runtimeModel, context: withModelOutputStrategy(runtimeModel.context,
      outputStrategyFromContext(runtimeModel.context) ?? "initial") };
    runtimeModel.assertCurrent?.();
    try {
      const decision = await invoke<Omit<NextStageDecision, "source">>("decide_ai_next_stage", {
        apiKey: runtimeModel.apiKey,
        endpoint: runtimeModel.endpoint,
        model: runtimeModel.model,
        requirement,
        context: parameterContext(runtimeModel.context, runtimeModel.requestParameters, runtimeModel.capabilities, modelIntegrationConfig(runtimeModel)),
        generationSettings: runtimeModel.generationSettings,
        timeoutSeconds: runtimeModel.timeoutSeconds,
      });
      runtimeModel.assertCurrent?.();
      const operation = modelOperationResult("stage.decide", { ...decision, source: "model" });
      if (!operation.proposal) return operation.decision;
      try {
        return legacyModelOperationValue("stage.decide", { ...decision, steps: normalizePlanPreconditions(decision.steps, requirement), source: "model" });
      } catch (error) {
        const repair = buildPlanNormalizationRepair(error, decision.steps);
        repair.nextStageDecision = { decision: decision.decision, reason: decision.reason, summary: decision.summary,
          ...(decision.planUpdate ? { planUpdate: decision.planUpdate } : {}),
          ...(decision.reconciliation ? { reconciliation: decision.reconciliation } : {}),
          ...(decision.requirementReview ? { requirementReview: decision.requirementReview } : {}),
          ...(decision.blocking ? { blocking: decision.blocking } : {}),
          ...(decision.issueResolutions ? { issueResolutions: decision.issueResolutions } : {}) };
        repair.modelRecovery = recoveryFromContext(runtimeModel.context);
        if (outputStrategyFromContext(runtimeModel.context) !== "initial") throw new PlanProtocolError(repair, String(error));
        // Preserve the joint decision. Only the invalid plan protocol is retried.
        const steps = await backend.generatePlan(requirement, { ...runtimeModel,
          context: contextWithPlanRepair(runtimeModel.context, repair) });
        return legacyModelOperationValue("stage.decide", { ...decision, steps, source: "model" });
      }
    } catch (error) {
      runtimeModel.assertCurrent?.();
      if (error instanceof PlanProtocolError) throw error;
      const preserved = rustProtocolFailure(error, runtimeModel.context);
      if (preserved?.repair.nextStageDecision && !preserved.repair.progress?.stopCode
        && outputStrategyFromContext(runtimeModel.context) === "initial") {
        const steps = await executeProtocolRepair(preserved.repair, requirement, runtimeModel);
        return legacyModelOperationValue("stage.decide", { ...preserved.repair.nextStageDecision, steps, source: "model" });
      }
      throw preserved ?? normalizeModelInvocationError(error);
    }
  },

  async executeCommand(
    command: string,
    connection?: RuntimeConnection,
    approvedHighRisk = false,
    options?: { executionId: string; captureStreams?: boolean; onProgress?: (event: CommandOutputEvent) => void },
  ): Promise<{
    output: string;
    stdout?: string;
    stderr?: string;
    stdoutTruncated?: boolean;
    success: boolean;
    simulated: boolean;
    exitCode?: number;
    emptyResult?: boolean;
  }> {
    if (isTauri() && connection?.password) {
      let unlisten: (() => void) | undefined;
      if (options?.onProgress) {
        unlisten = await listen<CommandOutputEvent>("command-output", (event) => {
          if (event.payload.executionId === options.executionId) options.onProgress?.(event.payload);
        });
      }
      try {
        const executionId = options?.executionId ?? directExecutionId();
        return await runDirectExecution({ executionId, connections: [connection], phase: "command",
          action: { type: "shell", command },
          classifyResult: (result: { success: boolean; exitCode?: number }) => result.exitCode === undefined
            ? (result.success ? "succeeded" : "unknown") : result.exitCode === 0 ? "succeeded" : "failed",
          execute: () => invoke<{ stdout?: string; stderr?: string; stdoutTruncated?: boolean; output: string; success: boolean; simulated: boolean; exitCode?: number; emptyResult?: boolean }>("execute_ssh_command", {
          ...connection,
          command,
          approvedHighRisk,
          executionId,
          ...(options?.captureStreams ? { separateOutput: true } : {}),
        }) });
      } finally {
        unlisten?.();
      }
    }
    if (isTauri()) return Promise.reject(new Error("未提供真实 SSH 连接，拒绝执行命令"));
    return requireDesktopRuntime("SSH 命令执行");
  },

  async cancelCommand(connection: RuntimeConnection, executionId: string) {
    if (!isTauri()) return;
    await cancelDirectExecution(executionId, () => invoke("cancel_ssh_execution", { ...connection, executionId }));
  },

  async validateStep(
    step: PlanStep,
    connection?: RuntimeConnection,
    options?: { executionId: string; onProgress?: (event: CommandOutputEvent) => void },
  ): Promise<{
    passed: boolean;
    detail: string;
    output?: string;
    exitCode?: number;
    emptyResult?: boolean;
  }> {
    if (isTauri() && connection) {
      const result = await this.executeCommand(step.validation, connection, false, options);
      const passed = result.exitCode === undefined ? result.success : result.exitCode === 0;
      return {
        passed,
        detail: passed ? `独立校验通过：${step.expected}` : "独立校验命令未达到预期",
        output: result.output,
        exitCode: result.exitCode,
        emptyResult: result.emptyResult,
      };
    }
    if (isTauri()) return Promise.reject(new Error("未提供真实 SSH 连接，拒绝执行校验"));
    return requireDesktopRuntime("SSH 独立校验");
  },
};
