import type { OpsTask, PlanStep } from "@/types";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { prepareFinalToolArguments } from "@/features/tools/toolPreparation";
import { stableProtocolValue } from "@/services/planProtocolRepair";
import { redactDecisionText } from "./decisionEvidence";
import { observationIdentity } from "./workflowProgress";
import { taskDecisionEvidenceIds } from "./taskDecisionResolution";

const TRANSIENT_FAILURES = ["network", "timeout", "rate_limit"];

/** A failed read may be replaced; this never grants a retry or changes its result. */
export function toolFailureFallback(step: PlanStep) {
  if (step.status !== "failed" || step.action?.type !== "tool" || !step.result) return;
  const action = step.action;
  const tool = defaultToolCatalog.find(item => item.id === action.toolId);
  if (tool?.effect !== "read" || tool.modelExposure === "internal"
    || tool.id === "server.resolve_connection" || tool.id === "evidence.read"
    || step.executionIntent && step.executionIntent.semantic.effect !== "read") return;
  const facts = step.result.facts;
  const category = facts.evidenceKind === "operations_inspection" && facts.inspectionStatus === "unsupported"
    ? "unsupported" : String(facts.category ?? "");
  const attempts = Array.isArray(facts.attempts) ? facts.attempts.length : 0;
  if (step.result.executionStatus !== "failed"
    && !(category === "unsupported" && step.result.executionStatus === "success")) return;
  if (TRANSIENT_FAILURES.includes(category) ? attempts < 3
    : !["unsupported", "unavailable", "output"].includes(category)) return;
  return { toolId: tool.id, category, attempts,
    reason: step.result.failureReason ?? step.review?.summary ?? step.output ?? "工具未取得所需结果" };
}

function sameTarget(task: OpsTask, step: PlanStep) {
  try {
    const identity: unknown = JSON.parse(step.attemptContext ?? "null");
    return Array.isArray(identity) && identity.length === 5
      && identity[0] === (task.executionTargetServerId ?? task.serverId);
  } catch { return false; }
}

function signature(step: PlanStep) {
  if (step.action?.type !== "tool") return;
  const action = step.action;
  const tool = defaultToolCatalog.find(item => item.id === action.toolId);
  try {
    return stableProtocolValue({ ...step.action,
      arguments: tool ? prepareFinalToolArguments(tool, step.action.arguments) : step.action.arguments });
  } catch { return stableProtocolValue(step.action); }
}

/** The step's finite retry budget cannot be reset by proposing a new step ID. */
export function failedToolRetryBlocker(task: OpsTask, candidate: PlanStep, history: PlanStep[]): string | undefined {
  if (candidate.action?.type !== "tool") return;
  const ledger = history.filter(step => sameTarget(task, step));
  const previous = [...ledger].reverse().find(step => step.id !== candidate.id
    && toolFailureFallback(step) && signature(step) === signature(candidate));
  if (!previous) return;
  const basis = candidate.retryBasis;
  const usableEvidence = new Set(taskDecisionEvidenceIds(task));
  const failureTimes = [previous.startedAt, ...(previous.evidence ?? []).map(item => item.collectedAt)]
    .map(value => Date.parse(value ?? "")).filter(Number.isFinite);
  const failureAt = failureTimes.length ? Math.max(...failureTimes) : undefined;
  const newer = ledger.slice(ledger.indexOf(previous) + 1).filter(step => step.id !== candidate.id
    && step.status === "completed" && step.result?.executionStatus === "success"
    && step.result.facts.commandDispatched !== false && step.result.facts.validationPassed !== false
    && !ledger.slice(0, ledger.indexOf(previous) + 1).some(old => observationIdentity(old) === observationIdentity(step)));
  const proofs = new Set(newer.flatMap(step => (step.evidence ?? [])
    .filter(item => usableEvidence.has(item.id) && step.result!.evidenceIds.includes(item.id)
      && failureAt !== undefined && Date.parse(item.collectedAt) > failureAt).map(item => item.id)));
  if (basis?.kind === "changed_state" && basis.failedStepId === previous.id && basis.reason?.trim()
    && basis.evidenceIds.length && basis.evidenceIds.every(id => proofs.has(id))) return;
  return `工具 ${candidate.action.toolId} 的同参数调用已失败或耗尽重试；请选择同目标、同授权的替代工具或 Shell。没有失败后的新证据，不能重新调用原工具。`;
}

export function toolFallbackContext(task: OpsTask, history: PlanStep[]) {
  const failures = history.filter(step => sameTarget(task, step)).flatMap(step => {
    const failure = toolFailureFallback(step);
    return failure ? [{ stepId: step.id, ...failure, reason: redactDecisionText(failure.reason).slice(0, 600),
      action: step.action, targetContext: step.attemptContext }] : [];
  }).slice(-6);
  if (!failures.length) return;
  return { failures, instruction: "这些只读工具已确认不可用、输出无效或已用完有限重试。失败记录继续保留，不能当作已完成，也不必先修好原工具。请选择同目标、同授权范围内能验证相同结果的其他工具或简单 Shell；保留原验收要求和审批，不绕过凭据、权限或未决变更。不要为了运行探针而安装依赖、升级 Python 或修改系统；有已授权的替代方法时继续该方法，没有可行方法时说明具体阻断。同参数原工具仅在取得失败后的新证据并提供 changed_state 重试依据后才可再调用。" };
}
