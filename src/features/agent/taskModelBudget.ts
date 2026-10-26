import type { OpsTask } from "@/types";

export interface TaskModelBudgetPolicy {
  version: 1;
  maxTaskTokens: number;
  maxRoundTokens: number;
  /** Imported tasks start a new accounting interval, never a fabricated historical total. */
  coverage: "complete" | "from_registration";
  lockedAt?: string;
}
export interface ModelBudgetAccount {
  maxTotalTokens: number;
  accountedTokens: number;
  knownUsageTokens: number;
  estimatedReservedTokens: number;
  unknownUsageAttempts: number;
  exactTokens: boolean;
}
export interface TaskModelBudgetSnapshot {
  version: 1;
  taskId: string;
  roundId: string;
  persistent: true;
  task: ModelBudgetAccount;
  round: ModelBudgetAccount;
}
const admissionNumbers = ["requestBytes", "outputTokenLimit", "estimationOverheadTokens", "requiredReservedTokens"] as const;
const scopeNumbers = ["maxTotalTokens", "accountedTokens", "knownUsageTokens", "unknownReservedTokens", "unknownUsageAttempts",
  "usageEvidenceConflicts", "conservativeConflictTokens", "laneTokenLimit", "laneAccountedTokens", "availableTotalTokens",
  "availableLaneTokens", "availableTokens", "reservationShortfallTokens", "transportAttempts", "maxTransportAttempts",
  "safetyAttempts", "maxSafetyAttempts"] as const;
type AdmissionScope = Partial<Record<typeof scopeNumbers[number], number>> & { blockedReasons?: string[] };
export interface TaskBudgetAdmissionDiagnostic extends Partial<Record<typeof admissionNumbers[number], number>> {
  version: 1; inputEstimateIsExact: false; usageEstimator?: "complete-wire-utf8-bytes-plus-output-cap-plus-1024";
  lane?: "business" | "safety"; scopes: { task?: AdmissionScope; round?: AdmissionScope };
}
/** Metadata whitelist; never expose prompt text or accept provider diagnostics as task authority. */
export function parseTaskBudgetAdmission(value: unknown): TaskBudgetAdmissionDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || source.inputEstimateIsExact !== false) return undefined;
  const result: TaskBudgetAdmissionDiagnostic = { version: 1, inputEstimateIsExact: false, scopes: {} };
  const copyNumbers = (from: Record<string, unknown>, to: object, keys: readonly string[]) => {
    for (const key of keys) if (typeof from[key] === "number" && Number.isSafeInteger(from[key]) && (from[key] as number) >= 0) {
      Object.assign(to, { [key]: from[key] });
    }
  };
  copyNumbers(source, result, admissionNumbers);
  if (source.usageEstimator === "complete-wire-utf8-bytes-plus-output-cap-plus-1024") result.usageEstimator = source.usageEstimator;
  if (source.lane === "business" || source.lane === "safety") result.lane = source.lane;
  if (source.scopes && typeof source.scopes === "object" && !Array.isArray(source.scopes)) {
    for (const key of ["task", "round"] as const) {
      const raw = (source.scopes as Record<string, unknown>)[key];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const fields = raw as Record<string, unknown>, scope: AdmissionScope = {};
      copyNumbers(fields, scope, scopeNumbers);
      if (Array.isArray(fields.blockedReasons)) scope.blockedReasons = fields.blockedReasons.filter((reason): reason is string =>
        typeof reason === "string" && ["total_tokens", "lane_tokens", "transport_attempts", "safety_attempts"].includes(reason)).slice(0, 4);
      result.scopes[key] = scope;
    }
  }
  return result;
}
const outputAdjustmentNumbers = ["originalOutputTokenLimit", "effectiveOutputTokenLimit", "minimumOutputTokenLimit",
  "originalRequiredReservedTokens", "effectiveRequiredReservedTokens", "requestBytes", "estimationOverheadTokens", "availableTokens"] as const;
export interface OutputBudgetAdjustmentDiagnostic extends Partial<Record<typeof outputAdjustmentNumbers[number], number>> {
  version: 1; inputEstimateIsExact: false; actualBillingLimitGuaranteed: false; providerMinimumDeclared: false;
}
export function parseOutputBudgetAdjustment(value: unknown): OutputBudgetAdjustmentDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || source.inputEstimateIsExact !== false || source.actualBillingLimitGuaranteed !== false
    || source.providerMinimumDeclared !== false) return undefined;
  const result: OutputBudgetAdjustmentDiagnostic = { version: 1, inputEstimateIsExact: false,
    actualBillingLimitGuaranteed: false, providerMinimumDeclared: false };
  for (const field of outputAdjustmentNumbers) {
    const item = source[field];
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) result[field] = item;
  }
  return result;
}
export function parseTaskModelBudgetSnapshot(value: unknown): TaskModelBudgetSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const account = (raw: unknown): ModelBudgetAccount | undefined => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const data = raw as Record<string, unknown>;
    const keys = ["maxTotalTokens", "accountedTokens", "knownUsageTokens", "estimatedReservedTokens", "unknownUsageAttempts"] as const;
    if (keys.some(key => typeof data[key] !== "number" || !Number.isSafeInteger(data[key]) || (data[key] as number) < 0)
      || typeof data.exactTokens !== "boolean") return undefined;
    return Object.fromEntries([...keys.map(key => [key, data[key]]), ["exactTokens", data.exactTokens]]) as unknown as ModelBudgetAccount;
  };
  const task = account(item.task), round = account(item.round);
  if (item.version !== 1 || item.persistent !== true || typeof item.taskId !== "string" || typeof item.roundId !== "string"
    || !task || !round) return undefined;
  return { version: 1, taskId: item.taskId.slice(0, 256), roundId: item.roundId.slice(0, 256), persistent: true, task, round };
}
export const DEFAULT_TASK_MODEL_TOKENS = 1_000_000;
export const MAX_TASK_MODEL_TOKENS = 32_000_000;
export function createTaskModelBudget(maxTaskTokens = DEFAULT_TASK_MODEL_TOKENS,
  maxRoundTokens = maxTaskTokens, coverage: TaskModelBudgetPolicy["coverage"] = "complete"): TaskModelBudgetPolicy {
  if (!Number.isSafeInteger(maxTaskTokens) || !Number.isSafeInteger(maxRoundTokens)
    || maxRoundTokens < 1 || maxTaskTokens < maxRoundTokens || maxTaskTokens > MAX_TASK_MODEL_TOKENS) {
    throw new Error("Token 额度须为正整数，轮次额度不能大于任务额度，任务额度最高为 32,000,000。");
  }
  return { version: 1, maxTaskTokens, maxRoundTokens, coverage };
}

export function configureTaskModelBudget(task: OpsTask, maxTaskTokens: number, maxRoundTokens: number) {
  if (task.modelTokenBudget?.lockedAt) throw new Error("已开始登记的任务额度不能修改；原消耗与预留继续保留。");
  task.modelTokenBudget = createTaskModelBudget(maxTaskTokens, maxRoundTokens,
    task.modelTokenBudget?.coverage ?? (task.messages.length || task.rootGoal ? "from_registration" : "complete"));
  // An imported task can resume directly through repair/retry, bypassing the
  // initial-submit path. Saving its forward-only allowance freezes it here.
  if (task.modelTokenBudget.coverage === "from_registration") task.modelTokenBudget.lockedAt = new Date().toISOString();
}

/** Read only application-owned metadata locations; never scan user messages or tool output. */
export function taskBudgetRegistration(raw: string) {
  let context: Record<string, any>;
  try { context = JSON.parse(raw); } catch { return undefined; }
  if (!context || typeof context !== "object" || Array.isArray(context)) return undefined;
  const locations = [context._log, context.baseSnapshot?._log, context.task?._log]
    .filter(meta => meta && typeof meta === "object" && typeof meta.taskId === "string");
  if (!locations.length) return undefined;
  const first = locations[0];
  if (locations.some(meta => meta.taskId !== first.taskId || meta.roundId !== first.roundId)) {
    throw new Error("模型上下文包含冲突的任务或轮次身份，已停止登记预算。");
  }
  const bound = context._taskModelBudget;
  if (bound && (bound.version !== 1 || bound.taskId !== first.taskId || bound.roundId !== first.roundId)) {
    throw new Error("原模型请求的预算身份不能改绑到其他任务或轮次。");
  }
  const policy = first._modelTokenBudget as TaskModelBudgetPolicy | undefined;
  if (!policy) return undefined; // Rust rejects missing scope for an actual task.
  if (policy.version !== 1 || typeof first.roundId !== "string" || !first.roundId) {
    throw new Error("任务预算或轮次身份不完整，已停止模型调用。");
  }
  createTaskModelBudget(policy.maxTaskTokens, policy.maxRoundTokens, policy.coverage);
  return { taskId: first.taskId as string, roundId: first.roundId as string,
    maxTaskTokens: policy.maxTaskTokens, maxRoundTokens: policy.maxRoundTokens, safetyReserveTokens: 0 };
}
