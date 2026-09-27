import { stableProtocolValue } from "@/services/planProtocolRepair";
import type { NextStageDecision, OpsTask, PlanStep } from "@/types";
import { recoveryHistory, ExecutionPolicyError } from "./recoveryContract";
import { taskAttemptContext } from "./attemptState";
import { textFingerprint } from "./longRunningReviewOutput";
import { observationIdentity } from "./workflowProgress";
import { redactDecisionText } from "./decisionEvidence";
import { isMutatingStepCommand } from "@/services/validation";
import { gitAuthenticationRetryBlocker, gitAuthenticationFailure, repeatedAuthenticationInputBlocker } from "./authenticationRetry";
import { gitAuthenticationOperation } from "./interactiveSshCredential";

export class OperationalRecoveryError extends ExecutionPolicyError {}
const pending = (step: PlanStep) => ["pending", "awaiting_approval"].includes(step.status);
const changed = (step: PlanStep) => step.kind !== "observe" || isMutatingStepCommand(step.command);
const signature = (step: PlanStep) => stableProtocolValue(step.action?.type === "tool" ? step.action : step.command.trim().replace(/\r\n/g, "\n"));
const successful = (step: PlanStep) => step.status === "completed" && step.result?.executionStatus === "success"
  && step.result.facts.validationPassed !== false
  && (step.result.facts.semanticAcceptanceRequired !== true || step.result.facts.semanticAcceptanceStatus === "proven");

function sameTarget(task: OpsTask, step: PlanStep) {
  try {
    const identity: unknown = JSON.parse(step.attemptContext ?? "null");
    return Array.isArray(identity) && identity[0] === (task.executionTargetServerId ?? task.serverId);
  } catch { return false; }
}

export function currentPlanFingerprint(task: OpsTask) {
  return textFingerprint(JSON.stringify([taskAttemptContext(task), task.plan.map(step => [
    step.id, step.status, step.kind, step.action, step.command, step.validation, step.expected, step.risk,
    step.executionScope, step.validationScope, step.sessionContextChange, step.retryBasis, step.failureDependencies,
  ])]));
}

export function bindRetryPrerequisites(steps: PlanStep[]) {
  return steps.map((step, index) => {
    const basis = step.retryBasis;
    if (basis && (typeof basis.failedStepId !== "string" || !basis.failedStepId.trim()
      || typeof basis.reason !== "string" || !basis.reason.trim()
      || !["changed_state", "transient"].includes(basis.kind)
      || !Array.isArray(basis.evidenceIds) || basis.evidenceIds.some(id => typeof id !== "string" || !id.trim()))) {
      throw new OperationalRecoveryError("重试依据必须包含真实失败步骤 ID、重试类型、证据 ID 列表和原因，不能只填写前序索引。");
    }
    const after = step.retryBasis?.afterStepIndex;
    if (after === undefined) return { ...step, retryAfterStepId: undefined };
    if (!Number.isInteger(after) || after < 1 || after > index || step.retryBasis?.kind !== "changed_state") {
      throw new OperationalRecoveryError("重试的 afterStepIndex 必须指向本次方案中更早的修复/检查步骤，不能引用自身或未来步骤。");
    }
    return { ...step, retryAfterStepId: steps[after - 1].id };
  });
}

/** A local patch cannot remove completed work, guess IDs or reorder disjoint ranges. */
export function mergeRemainingPlan(task: OpsTask, decision: NextStageDecision): PlanStep[] {
  const update = decision.planUpdate;
  if (!update) return decision.steps;
  if (decision.decision === "complete" || !decision.steps.length || typeof update.reason !== "string" || !update.reason.trim()
    || update.basePlanFingerprint !== currentPlanFingerprint(task)
    || !Array.isArray(update.replaceStepIds) || !update.replaceStepIds.length
    || new Set(update.replaceStepIds).size !== update.replaceStepIds.length) {
    throw new OperationalRecoveryError("局部计划更新缺少有效范围或原计划已变化，请根据当前计划重新生成；旧结果未执行也未删除。");
  }
  const indices = update.replaceStepIds.map(id => task.plan.findIndex(step => step.id === id));
  if (indices.some(index => index < 0 || !["failed", "pending", "awaiting_approval"].includes(task.plan[index].status))
    || indices.some((index, position) => position > 0 && index !== indices[position - 1] + 1)
    || decision.steps.some(step => task.plan.some(old => old.id === step.id))) {
    throw new OperationalRecoveryError("局部更新只能替换按原顺序连续的失败或未执行步骤，不能改写成功记录、复用旧步骤 ID 或跨段删除。");
  }
  return [...task.plan.slice(0, indices[0]).filter(pending), ...decision.steps,
    ...task.plan.slice(indices[indices.length - 1] + 1).filter(pending)];
}

/** Exact repeats require new evidence; this is not an arbitrary Shell equivalence checker. */
export function retryBlocker(task: OpsTask, candidate: PlanStep): string | undefined {
  const ledger = recoveryHistory(task).filter(step => sameTarget(task, step));
  const authenticationBlocker = repeatedAuthenticationInputBlocker(task, candidate, ledger)
    ?? gitAuthenticationRetryBlocker(task, candidate, ledger);
  if (authenticationBlocker) return authenticationBlocker;
  if (!changed(candidate)) return;
  const previous = [...ledger].reverse().find(step => step.id !== candidate.id && changed(step)
    && signature(step) === signature(candidate) && ["failed", "completed"].includes(step.status)
    && step.result?.facts.commandDispatched !== false && step.result?.executionStatus !== "blocked");
  if (!previous) return;
  // Git authentication has its own cause/channel identity, not Shell equality.
  if (gitAuthenticationOperation(candidate.command) && gitAuthenticationFailure(previous)) return;
  const newer = ledger.slice(ledger.indexOf(previous) + 1).filter(step => step.id !== candidate.id && successful(step));
  const basis = candidate.retryBasis;
  if (!basis || basis.failedStepId !== previous.id || !basis.reason?.trim() || !Array.isArray(basis.evidenceIds)) {
    return `步骤“${candidate.title}”与已执行步骤 ${previous.id} 相同，缺少重试依据；请先核对状态或提供新证据，不能重复写入。`;
  }
  if (basis.kind === "transient") {
    const category = previous.result?.facts.category;
    const transient = ["network_failure", "timeout", "rate_limit"].includes(String(category));
    const references = previous.evidence?.map(item => item.id) ?? [];
    const repeated = ledger.filter(step => signature(step) === signature(candidate) && step.retryBasis?.kind === "transient"
      && step.result?.facts.commandDispatched !== false && ["failed", "completed"].includes(step.status)).length;
    if (previous.status === "failed" && transient && repeated < 1 && basis.evidenceIds.length
      && basis.evidenceIds.every(id => references.includes(id))) return;
    return "暂时故障重试缺少对应证据或已用完一次重试预算；请先核对当前状态，不再重复原命令。";
  }
  const prerequisite = candidate.retryAfterStepId ? newer.find(step => step.id === candidate.retryAfterStepId) : undefined;
  if (candidate.retryAfterStepId && !prerequisite) return "重试所依赖的修复/检查尚未成功验收，不能启动重复构建。";
  const references = [...basis.evidenceIds, ...(prerequisite?.evidence?.map(item => item.id) ?? [])];
  if (basis.kind !== "changed_state" || !references.length) return "重试必须说明已改变的状态并引用新证据。";
  const proofs = newer.filter(step => step.evidence?.some(item => references.includes(item.id)));
  const proofIds = new Set(proofs.flatMap(step => step.evidence?.map(item => item.id) ?? []));
  const hasChange = proofs.some(step => changed(step) || !ledger.slice(0, ledger.indexOf(previous) + 1)
    .some(old => !changed(old) && signature(old) === signature(step) && observationIdentity(old) === observationIdentity(step)));
  if (hasChange && references.every(id => proofIds.has(id))) return;
  return "所引用证据不是失败后的新状态，或与此前观察相同；先落实修复并验证，再重试构建。";
}

export function recordExecutionUncertainty(task: OpsTask, step: PlanStep, reason: string) {
  if (task.executionReconciliation && !task.executionReconciliation.resolution) return;
  if (!changed(step) || step.result?.facts.commandDispatched === false) return;
  task.executionReconciliation = {
    id: `reconcile-${step.id}-${Date.now()}`, stepId: step.id,
    serverId: task.executionTargetServerId ?? task.serverId,
    recordedAt: new Date().toISOString(), command: JSON.stringify(step.action ?? step.command), expected: step.expected,
    knownStepIds: recoveryHistory(task).map(item => item.id), reason,
  };
  task.latestGoalReview = undefined;
}

export function reconciliationBlocker(task: OpsTask, step: PlanStep) {
  if (!changed(step) && !step.sessionContextChange) return;
  if ((step.action?.type === "tool" && step.action.toolId === "user.request_input")) return;
  if (task.executionLedgerRecovery?.items.some(item => ["uncertain", "incompatible", "storage_failed"].includes(item.kind))) {
    return "持久执行记录存在未核对结果或待恢复的存储问题。请先保存原结果或只读核对，不能重放变更。";
  }
  const incident = task.executionReconciliation;
  if (!incident || incident.resolution) return;
  return "原变更的执行结果尚未核对。请先只读检查原进程及实际产物/副作用，再决定是否重试；连接恢复不等于命令未执行。";
}

export function validateReconciliation(task: OpsTask, proposed?: NextStageDecision["reconciliation"]) {
  const incident = task.executionReconciliation;
  if (!proposed) return undefined;
  if (!incident || incident.resolution || proposed.incidentId !== incident.id || typeof proposed.reason !== "string" || !proposed.reason.trim()
    || incident.serverId !== (task.executionTargetServerId ?? task.serverId)
    || !["safe_to_retry", "completed", "still_running", "unknown"].includes(proposed.status)
    || !Array.isArray(proposed.evidenceIds)) throw new OperationalRecoveryError("核对结论不属于当前执行事故或目标，原变更仍禁止重放。");
  const freshReads = recoveryHistory(task).filter(step => !incident.knownStepIds.includes(step.id)
    && sameTarget(task, step) && !changed(step) && successful(step));
  const ids = new Set(freshReads.flatMap(step => step.evidence?.map(item => item.id) ?? []));
  if (!proposed.evidenceIds.length || !proposed.evidenceIds.every(id => ids.has(id))) {
    throw new OperationalRecoveryError("执行核对必须引用事故发生后、同一服务器的真实只读证据，不能引用旧输出或猜测完成。");
  }
  return ["safe_to_retry", "completed"].includes(proposed.status) ? proposed : undefined;
}

export function prepareOperationalDecision(task: OpsTask, decision: NextStageDecision) {
  if (decision.decision === "complete" && task.executionLedgerRecovery?.items.some(item => ["uncertain", "incompatible", "storage_failed"].includes(item.kind))) {
    throw new OperationalRecoveryError("持久执行记录仍有未决事实，不能宣告整体完成；请先恢复记录或取得真实只读核对证据。");
  }
  const resolution = validateReconciliation(task, decision.reconciliation);
  const projected = resolution && task.executionReconciliation
    ? { ...task, executionReconciliation: { ...task.executionReconciliation, resolution } } : task;
  if (decision.decision === "complete" && projected.executionReconciliation && !projected.executionReconciliation.resolution) {
    throw new OperationalRecoveryError("原变更结果尚未核对，不能宣告整体完成；先获取进程与实际结果的只读证据。");
  }
  const steps = mergeRemainingPlan(task, { ...decision, steps: bindRetryPrerequisites(decision.steps) });
  for (const [index, step] of steps.entries()) {
    const authBlocker = repeatedAuthenticationInputBlocker(projected, step, recoveryHistory(projected))
      ?? gitAuthenticationRetryBlocker(projected, step, recoveryHistory(projected));
    if (authBlocker) throw new OperationalRecoveryError(authBlocker);
    const uncertainty = reconciliationBlocker(projected, step);
    if (uncertainty) throw new OperationalRecoveryError(uncertainty);
    // Planned repairs are not evidence. The executor rechecks once they actually finish.
    const prerequisite = step.retryAfterStepId && steps.slice(0, index).some(item => item.id === step.retryAfterStepId);
    const retry = prerequisite ? undefined : retryBlocker(projected, step);
    if (retry) throw new OperationalRecoveryError(retry);
  }
  return { steps, resolution };
}

/** Freshness is deliberately conservative: a later mutation invalidates old observations. */
export function operationalRecoveryContext(task: OpsTask) {
  const ledger = recoveryHistory(task);
  let boundary = -1;
  ledger.forEach((step, index) => {
    if (changed(step) && ["completed", "failed"].includes(step.status)
      && step.result?.facts.commandDispatched !== false && step.result?.executionStatus !== "blocked") boundary = index;
  });
  return {
    planFingerprint: currentPlanFingerprint(task),
    durableExecutionRecovery: task.executionLedgerRecovery?.items.map(item => ({
      operationId: item.operationId, attemptId: item.attemptId, stepId: item.stepId, kind: item.kind,
      summary: redactDecisionText(item.summary).slice(0, 800),
      knownFacts: item.knownFacts.map(fact => redactDecisionText(fact).slice(0, 800)),
      instruction: item.kind === "recorded_result"
        ? "执行事实已持久记录，先复核或只读验收；复核失败不代表原操作未执行，禁止重新部署。"
        : "先恢复存储或只读核对；本地取消不证明远端停止，禁止盲目重放。",
    })),
    authenticationFailures: ledger.filter(step => sameTarget(task, step) && gitAuthenticationFailure(step)).slice(-6)
      .map(step => ({ stepId: step.id, ...gitAuthenticationOperation(step.command),
        cause: gitAuthenticationFailure(step), channel: step.authenticationAttempt?.channel ?? "legacy",
        instruction: "认证通道失败不等于凭据错误；复用有效授权，不重复索取凭据。必须有真实通道修复，改日志文案或通用检查不算新进展。" })),
    pendingStepIds: task.plan.filter(pending).map(step => step.id),
    uncertainExecution: task.executionReconciliation ? {
      ...task.executionReconciliation, knownStepIds: undefined,
      command: redactDecisionText(task.executionReconciliation.command).slice(0, 1200),
    } : undefined,
    retryPrerequisiteInstruction: "若本次计划先修复/检查再重试，可在 retryBasis 添加 afterStepIndex（本次 steps 内从 1 开始的前序步骤索引），evidenceIds 可空。执行器会绑定真实步骤 ID，并在该步骤实际成功验收后读取新证据；不是仅凭计划描述放行。",
    recentAttempts: ledger.filter(step => step.result).slice(-8).map(step => ({
      stepId: step.id, command: redactDecisionText(step.command).slice(0, 1200), status: step.status, targetMatches: sameTarget(task, step),
      currentStateEvidence: sameTarget(task, step) && ledger.indexOf(step) > boundary && successful(step),
      evidenceIds: step.evidence?.map(item => item.id), retryBasis: step.retryBasis,
    })),
    instruction: "历史成功保留为已完成工作，不等于当前状态。变更、目标切换会使旧观察失效，需要时只读复验，不从头重复安装/构建。优先用 planUpdate={basePlanFingerprint,replaceStepIds,reason} 局部替换连续失败/待执行范围，steps 只放替代步骤；其他待执行步骤原样保留。省略 planUpdate 表示重新规划全部剩余工作，不得重复已完成变更。重试同一变更需在该步骤提供 retryBasis={failedStepId,kind:changed_state|transient,evidenceIds,reason}；changed_state 必须引用真实修复或新观察，transient 仅一次。无新证据先规划诊断，不虚构引用。未核对事故时只规划只读核对或真实提问，核对原进程是否仍运行和实际副作用；新证据齐备后返回 reconciliation={incidentId,status:safe_to_retry|completed|still_running|unknown,evidenceIds,reason}。safe_to_retry 必须同时解释进程已停止、重复写入不会破坏现状的证据；unknown/still_running 不解锁写入，可暂停等待后重新只读核对。工具不可用时仅选择当前目录内已授权的等价工具/Shell，仍须验证同一结果。",
  };
}
