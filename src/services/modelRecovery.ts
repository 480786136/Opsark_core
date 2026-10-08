import type { ModelServiceError } from "@/types";

/** Core-owned identity shared by one model operation and all of its automatic repairs. */
export interface ModelRecoveryContext {
  operationId: string;
  startedAtMs: number;
  maxGenerations?: number;
  maxTransportAttempts?: number;
  maxElapsedMs?: number;
  maxTotalTokens?: number;
}

export function createModelRecoveryContext(): ModelRecoveryContext {
  return { operationId: `model-operation-${crypto.randomUUID()}`, startedAtMs: Date.now() };
}

/** Older Core builds reported this policy gate with the generic format code. */
export function isModelRecoveryScopeRejection(error: ModelServiceError | undefined): boolean {
  return error?.origin === "core" && error.stage === "format_repair_scope"
    && ["MODEL_RECOVERY_SCOPE_REJECTED", "MODEL_FORMAT_INVALID"].includes(error.code);
}

/** Only a user action may start a new operation after these bounded failures.
 * Unknown dispatch/results, billing and authentication keep their own gates. */
export function isExplicitModelPlanningRetryable(error: ModelServiceError | undefined): boolean {
  return error?.code === "MODEL_FORMAT_INVALID"
    || isModelRecoveryScopeRejection(error)
    || error?.code === "MODEL_OUTPUT_REPAIR_EXHAUSTED" && error.origin === "core" && error.stage === "output_recovery"
      && error.recoveryBudget?.recoveryBlocked === false
    || error?.code === "MODEL_RECOVERY_BUDGET_EXHAUSTED"
      && error.origin === "core" && error.stage === "recovery_budget"
      && error.recoveryBudget?.recoveryBlocked === false;
}

function parseContext(context: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(context || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* Keep legacy free-form context intact in a field. */ }
  return { originalContext: context };
}

export function recoveryFromContext(context: string): ModelRecoveryContext | undefined {
  return parseContext(context)._modelRecovery as ModelRecoveryContext | undefined;
}

export type ModelOutputStrategy = "initial" | "field_repair" | "regenerate";

/** Strategy selection belongs to Core; the operation's frozen budget is separate. */
export function outputStrategyFromContext(context: string): ModelOutputStrategy | undefined {
  const recovery = parseContext(context)._modelOutputRecovery as { strategy?: unknown } | undefined;
  const strategy = recovery?.strategy;
  return strategy === "initial" || strategy === "field_repair" || strategy === "regenerate" ? strategy : undefined;
}

export function withModelOutputStrategy(context: string, strategy: ModelOutputStrategy): string {
  return JSON.stringify({ ...parseContext(context), _modelOutputRecovery: { strategy } });
}

/** Only a received, invalid candidate can be regenerated. Never replay an unknown request. */
export function isRecoverableModelOutput(error: ModelServiceError | undefined): boolean {
  if (!error || error.origin !== "core" || error.recoveryBudget?.recoveryBlocked === true
    || error.dispatchCertainty === "may_have_dispatched") return false;
  return error.code === "MODEL_FORMAT_INVALID"
      && ["json_parse", "wire_validation", "business_validation", "metadata_decode"].includes(error.stage ?? "")
    || error.code === "MODEL_OUTPUT_TRUNCATED" && error.stage === "response_status"
    || error.code === "MODEL_OUTPUT_REPAIR_EXHAUSTED" && error.stage === "output_recovery"
    || isModelRecoveryScopeRejection(error);
}

/** Rebuild from the full original context, never from a compact field-repair prompt. */
export function candidateRegenerationContext(context: string, diagnostic: Record<string, unknown>): string {
  const original = parseContext(context);
  // These are temporary candidate constraints, not user authority or execution facts.
  delete original.planGenerationRepair;
  delete original.operationalRepair;
  delete original.repairPolicy;
  delete original.protocolRepairBudget;
  return JSON.stringify({ ...original, _modelOutputRecovery: { strategy: "regenerate" },
    outputRecovery: { diagnostic, rejectedCandidateExecuted: false,
      instruction: "上一候选未通过校验且未执行。依据原始目标、约束、授权、已确认输入及真实执行证据，重新生成当前操作的完整候选，仅处理剩余工作。不要沿用本轮字段补丁输出形式，不重复已完成动作；执行结果未知的动作先核对。保留必要字段与验收，缩短描述和摘要，不得通过空方案或宣称完成掩盖错误。新候选仍须通过全部校验与正常审批。" } });
}

/** Never mutate a reusable RuntimeModel or attach a permanent budget to a task. */
export function ensureModelRecoveryContext(context: string, recovery?: ModelRecoveryContext): string {
  const parsed = parseContext(context);
  // Rust validates and freezes the context. Do not replace an invalid supplied
  // identity with a fresh budget on the frontend.
  const existing = Object.prototype.hasOwnProperty.call(parsed, "_modelRecovery");
  return JSON.stringify({ ...parsed, _modelRecovery: recovery !== undefined ? recovery
    : existing ? parsed._modelRecovery : createModelRecoveryContext() });
}
