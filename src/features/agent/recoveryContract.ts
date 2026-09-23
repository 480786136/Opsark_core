import type { OpsTask, PlanStep } from "@/types";
import { isMutatingStepCommand } from "@/services/validation";
import { supplementalRecoveryAcceptance, validationHasAcceptanceCheck } from "./planSafety";
import { RECOVERY_RULE_VERSION, RecoveryProtocolError, recoveryMetadataIssue } from "@/services/recoveryRules";

const mutating = (step: PlanStep) => step.kind === "change" || isMutatingStepCommand(step.command);
export class ExecutionPolicyError extends Error {}

export function executionPolicyBlocker(task: OpsTask, step: PlanStep) {
  return task.executionConstraints?.changePolicy === "read_only" && mutating(step)
    ? `只读授权不允许执行变更步骤「${step.title}」；恢复关系和风险审批不扩大授权范围。` : undefined;
}

export function assertTaskPlanAuthorization(task: OpsTask, steps: PlanStep[]) {
  for (const step of steps) {
    const reason = executionPolicyBlocker(task, step);
    if (reason) throw new ExecutionPolicyError(reason);
  }
}
const carriedTargets = new WeakMap<PlanStep, NonNullable<OpsTask["recoveryCarryForwards"]>>();

function parsedRecoveryTarget(context?: string): unknown[] | undefined {
  if (!context) return;
  try {
    const value: unknown = JSON.parse(context);
    if (Array.isArray(value) && value.length === 5 && typeof value[0] === "string"
      && value[0] && typeof value[1] === "string") return value;
  } catch { /* Opaque legacy target cannot establish a cross-round handoff. */ }
}

function recoveryContractFingerprint(step: PlanStep) {
  return JSON.stringify([step.id, step.attemptContext, step.kind, step.command, step.validation,
    step.expected, step.executionScope ?? "isolated_exec", step.validationScope ?? "isolated_exec"]);
}

/** Only authoritative task history can grant a cross-round target relationship. */
export function bindRecoveryCarryForwards(task: OpsTask, step: PlanStep) {
  carriedTargets.delete(step);
  const original = parsedRecoveryTarget(step.attemptContext);
  if (!original) return step;
  const permits = (task.recoveryCarryForwards ?? []).filter(item => item.taskId === task.id
    && item.failedStepId === step.id && item.targetContext === step.attemptContext
    && item.sourceRoundId === original[1] && item.targetServerId === original[0]
    && item.contractFingerprint === recoveryContractFingerprint(step));
  if (permits.length) carriedTargets.set(step, permits);
  return step;
}

function permitsCarriedTarget(failed: PlanStep, current: string) {
  const target = parsedRecoveryTarget(current);
  return Boolean(target && carriedTargets.get(failed)?.some(item =>
    item.destinationRoundId === target[1] && item.targetServerId === target[0]));
}

export function carryForwardRecoveryBlockers(task: OpsTask, nextRoundId: string) {
  if (!nextRoundId || nextRoundId === task.currentRoundId) return;
  const currentContext = JSON.stringify([task.executionTargetServerId ?? task.serverId,
    task.currentRoundId ?? "", task.agentSessionId ?? "", task.agentSessionGeneration ?? 0,
    task.credentialRevision ?? 0]);
  for (const failed of unresolvedRecoveryBlockers(task)) {
    const original = parsedRecoveryTarget(failed.attemptContext);
    if (!original || (!sameRecoveryTarget(failed.attemptContext!, currentContext)
      && !permitsCarriedTarget(failed, currentContext))) continue;
    task.recoveryCarryForwards ??= [];
    if (task.recoveryCarryForwards.some(item => item.taskId === task.id
      && item.failedStepId === failed.id && item.targetContext === failed.attemptContext
      && item.destinationRoundId === nextRoundId)) continue;
    task.recoveryCarryForwards.push({ taskId: task.id, failedStepId: failed.id,
      targetContext: failed.attemptContext!, sourceRoundId: original[1] as string,
      destinationRoundId: nextRoundId, targetServerId: original[0] as string,
      contractFingerprint: recoveryContractFingerprint(failed) });
  }
}

/** Session/credential refresh changes freshness, not the failed resource's identity. */
function sameRecoveryTarget(original: string, current: string) {
  if (original === current) return true;
  try {
    const previous: unknown = JSON.parse(original);
    const next: unknown = JSON.parse(current);
    return Array.isArray(previous) && Array.isArray(next) && previous.length === 5 && next.length === 5
      && typeof previous[0] === "string" && previous[0] !== "" && previous[0] === next[0]
      && typeof previous[1] === "string" && previous[1] === next[1];
  } catch { return false; }
}

export function isBlockingFailure(step: PlanStep) {
  const facts = step.result?.facts;
  // A rejected, undispatched command is a planning defect, not an environment
  // failure. Its replacement still passes the ordinary safety/approval gates.
  if (facts?.commandDispatched === false || facts?.category === "plan_safety_rejection") return false;
  return Boolean(facts?.blockingSignal || facts?.validationPassed === false
    || (mutating(step) && (step.status === "failed" || step.result?.executionStatus === "failed")));
}

function hasRecordedAttempt(step: PlanStep) {
  return Boolean(step.attemptContext || step.startedAt || step.result || step.evidence?.length || isBlockingFailure(step));
}

export function permitsBestEffortRiskReview(task: OpsTask, blocker: PlanStep) {
  const facts = blocker.result?.facts;
  return task.executionConstraints?.failurePolicy === "best_effort"
    && ["requested_changes_only", "allow_necessary_changes"].includes(task.executionConstraints.changePolicy)
    && blocker.result?.executionStatus === "success" && blocker.status !== "failed"
    && facts?.blockingSignal === true && facts.validationPassed !== false
    && !facts.validationProtocolIncomplete && !facts.platformIncompatible && !facts.networkFailure;
}

/**
 * The legacy name and fields are retained for persisted history consumers.
 * This is the failed attempt's original verification reference, not an
 * immutable acceptance policy for a replacement plan or the user's goal.
 */
export function recoveryVerificationContract(failed: PlanStep) {
  const contract = failed.kind === "observe"
    ? { kind: failed.kind, expected: failed.expected, command: failed.command.trim(), executionScope: failed.executionScope ?? "isolated_exec", validationScope: "isolated_exec" }
    : { kind: failed.kind ?? "change", expected: failed.expected, command: failed.validation.trim(), executionScope: "isolated_exec", validationScope: failed.validationScope ?? "isolated_exec" };
  const supplementalVerification = isMutatingStepCommand(contract.command) || contract.validationScope !== "isolated_exec"
    ? undefined : supplementalRecoveryAcceptance(contract.command);
  return { ...contract, usage: "historical_reference" as const, allowsRevisedVerification: true,
    supplementalVerification,
    requiresAcceptanceEvidence: !validationHasAcceptanceCheck(contract.command) || undefined,
    acceptanceInstruction: "这是历史尝试的验收参考，不是后续计划的执行门禁。可根据用户目标和新证据修正验收命令、expected 或执行方式，并说明新检查如何证明用户要求的结果；不得改写历史记录或降低用户要求。"
      + (supplementalVerification
      ? "原始查询只证明执行成功；supplementalVerification 是一种可选的、保留来源的补验方法，不是唯一允许的验收方法。"
      : !validationHasAcceptanceCheck(contract.command)
        ? "原始命令没有可证明预期状态的退出码断言；raw/exit 0 不等于目标达成。可继续只读诊断、补充真实验收证据或设计新的目标相关检查；条件不明确时向用户确认。"
        : "原检查成功可作为历史复验依据，但不自动代表整个用户目标完成。"),
  };
}

/**
 * Conservative recognition of an explicitly linked historical recheck. A
 * revised verification can still be executed and reviewed against the goal;
 * failure to match here is not dispatch denial or a business-failure verdict.
 * Shared names/paths alone must never rewrite the referenced attempt's facts.
 */
export function isRelatedRecoveryStep(failed: PlanStep, candidate: PlanStep, currentContext?: string) {
  const relation = candidate.recovery;
  if (!relation || relation.failedStepId !== failed.id || !failed.attemptContext
    || relation.targetContext !== failed.attemptContext
    || (currentContext && !sameRecoveryTarget(relation.targetContext, currentContext)
      && !permitsCarriedTarget(failed, currentContext))) return false;
  if (relation.purpose === "diagnose") return candidate.kind === "observe" && !mutating(candidate);
  if (relation.purpose === "repair") return mutating(candidate);
  if (relation.purpose !== "verify") return false;
  const contract = recoveryVerificationContract(failed);
  const validation = candidate.command.trim();
  const originalAssertion = validation === contract.command && validationHasAcceptanceCheck(contract.command);
  const supplementalAssertion = validation === contract.supplementalVerification?.command;
  if ((!originalAssertion && !supplementalAssertion)
    || isMutatingStepCommand(validation) || candidate.expected !== failed.expected || candidate.sessionContextChange) return false;
  // Automatic historical matching retains the old check's original scope.
  // New verification methods are interpreted by goal review, not guessed here.
  const scope = contract.validationScope;
  return candidate.kind === "observe"
    ? scope === "isolated_exec" && (candidate.executionScope ?? "isolated_exec") === contract.executionScope
    : candidate.kind === "change" && candidate.validation.trim() === validation
      && (candidate.validationScope ?? "isolated_exec") === scope;
}

/** Recognizes exact historical proof only; false does not mean the goal is blocked. */
export function hasVerifiedRecovery(failed: PlanStep, candidate: PlanStep, history: PlanStep[] = []) {
  const candidateIndex = history.findIndex(step => step.id === candidate.id);
  const repairs = history.filter(step => step.recovery?.purpose === "repair"
    && step.recovery.failedStepId === failed.id && step.recovery.targetContext === failed.attemptContext
    && step.result?.facts.commandDispatched !== false
    && (Boolean(step.startedAt) || Boolean(step.result) || ["running", "validating", "completed", "failed"].includes(step.status)));
  // An earlier successful observation cannot survive a later repair attempt.
  // Completed repairs are not acceptance evidence, even when their own command
  // returned zero. Compare order and available executor timestamps.
  if (repairs.some(repair => {
    const repairIndex = history.findIndex(step => step.id === repair.id);
    if (candidateIndex >= 0 && repairIndex >= candidateIndex) return true;
    const repairTimes = [repair.startedAt, ...repair.evidence?.map(item => item.collectedAt) ?? []]
      .map(value => Date.parse(value ?? "")).filter(Number.isFinite);
    const evidenceTimes = candidate.evidence?.map(item => Date.parse(item.collectedAt)).filter(Number.isFinite) ?? [];
    return repairTimes.length > 0 && (evidenceTimes.length === 0
      || Math.min(...evidenceTimes) < Math.max(...repairTimes));
  })) return false;
  const supplemental = recoveryVerificationContract(failed).supplementalVerification;
  const strengthened = supplemental?.command === candidate.command.trim();
  return candidate.recovery?.purpose === "verify"
    && isRelatedRecoveryStep(failed, candidate, candidate.attemptContext)
    && Boolean(candidate.attemptContext)
    && candidate.status === "completed" && candidate.result?.executionStatus === "success"
    && candidate.result.exitCode === 0 && !candidate.result.facts.blockingSignal
    && candidate.result.facts.validationPassed !== false && candidate.result.facts.acceptancePassed !== false && !candidate.result.failureReason
    && !candidate.result.warnings.length && !["unhealthy", "warning", "not_found"].includes(candidate.result.observationStatus)
    && !candidate.result.facts.evidenceConflict && !candidate.result.facts.validationProtocolIncomplete
    && (candidate.kind === "observe" || candidate.result.facts.validationPassed === true)
    && candidate.evidence?.some((evidence) => candidate.result!.evidenceIds.includes(evidence.id)
      && evidence.source === (candidate.kind === "observe" ? "main" : "validation")
      && !failed.evidence?.some(original => original.id === evidence.id)
      && !repairs.some(repair => repair.evidence?.some(original => original.id === evidence.id))
      && (!strengthened || JSON.stringify(evidence.facts.recoveryAcceptance) === JSON.stringify({
        ...supplemental, expected: failed.expected, failedStepId: failed.id, targetContext: failed.attemptContext,
      }))
      && failed.evidence?.filter(item => item.source === (failed.kind === "observe" ? "main" : "validation"))
        .every(original => !original.scope || (original.scope.targetId === evidence.scope?.targetId
          && original.scope.scope === evidence.scope?.scope && original.scope.cwd === evidence.scope?.cwd
          && original.scope.shell === evidence.scope?.shell)) !== false) === true;
}

/** Persist the failed attempt's audit reference, never full outputs, for trimmed phases. */
export function persistedRecoveryContract(step: PlanStep, roundId: string) {
  if (!isBlockingFailure(step)) return undefined;
  return { roundId, step: {
    id: step.id, kind: step.kind, title: step.title, description: "",
    command: step.command, validation: step.validation, expected: step.expected, risk: step.risk,
    executionScope: step.executionScope, validationScope: step.validationScope,
    attemptContext: step.attemptContext, status: step.status, recovery: step.recovery,
    result: step.result ? { executionStatus: step.result.executionStatus,
      observationStatus: step.result.observationStatus, exitCode: step.result.exitCode,
      facts: { blockingSignal: step.result.facts.blockingSignal, validationPassed: step.result.facts.validationPassed,
        commandDispatched: step.result.facts.commandDispatched, category: step.result.facts.category },
      warnings: [], evidenceIds: [], failureReason: step.result.failureReason,
    } : undefined,
    evidence: step.evidence?.filter(evidence => evidence.scope).map(evidence => ({
      id: evidence.id, type: evidence.type, source: evidence.source, scope: evidence.scope,
      facts: {}, rawOutput: "", collectedAt: evidence.collectedAt,
    })),
  } satisfies PlanStep };
}

/** Valid verification is a new evidence request, even if this command appeared earlier. */
export function isNecessaryRecoveryVerification(history: PlanStep[], candidate: PlanStep, context?: string) {
  const failed = history.find(step => step.id === candidate.recovery?.failedStepId);
  const latestPlannedRepair = history.reduce((latest, step, index) => step.recovery?.purpose === "repair"
    && step.recovery.failedStepId === failed?.id && step.recovery.targetContext === failed?.attemptContext ? index : latest, -1);
  return candidate.recovery?.purpose === "verify" && Boolean(failed && isBlockingFailure(failed)
    && isRelatedRecoveryStep(failed, candidate, context)
    && !history.some((step, index) => index > latestPlannedRepair && hasVerifiedRecovery(failed, step, history)));
}

export function recoveryHistory(task: OpsTask) {
  // Historical failures remain visible across rounds. A cross-round handoff
  // only enables conservative historical proof matching, not execution rights.
  const persisted = (task.historyCheckpoint?.unresolvedIssues ?? []).flatMap(issue => {
    if (issue.blocksExecution === false) return [];
    if (issue.recoveryContract) return [issue.recoveryContract.step];
    // Keep missing legacy evidence visible without inventing an original check
    // or requiring it to be reconstructed before safe diagnosis can proceed.
    return [{ id: issue.stepId, title: issue.title, description: issue.reason ?? "历史验收记录缺失，可补读证据或根据用户目标重新设计检查",
      command: "", validation: "", expected: "", risk: "low", status: "failed", kind: "change",
      attemptContext: issue.attemptContext, result: { executionStatus: "blocked", observationStatus: "unknown",
        facts: { blockingSignal: true, recoveryContractMissing: true }, warnings: [], evidenceIds: [],
        failureReason: "历史失败的原始验收记录缺失；保留该事实，结合可用证据和用户目标调整后续计划。" },
    } satisfies PlanStep];
  });
  const steps = [...persisted, ...(task.planHistory ?? []).flatMap(round => round.plan), ...(task.phaseHistory ?? [])
    .flatMap(phase => phase.plan), ...task.plan];
  const byId = new Map<string, PlanStep>();
  steps.forEach(step => {
    const previous = byId.get(step.id);
    // A legacy/new pending plan with a reused id must not erase a real attempt.
    if (previous && hasRecordedAttempt(previous) && !hasRecordedAttempt(step)) return;
    byId.set(step.id, bindRecoveryCarryForwards(task, step));
  });
  return [...byId.values()];
}

/** Legacy audit index: unmatched failures are context, not a gate on a new plan. */
export function unresolvedRecoveryBlockers(task: OpsTask, beforeStep?: PlanStep) {
  const history = recoveryHistory(task);
  const end = beforeStep ? history.findIndex(step => step.id === beforeStep.id) : history.length;
  const previous = history.slice(0, end < 0 ? history.length : end);
  return previous.filter((step, index) => isBlockingFailure(step)
    && !previous.slice(index + 1).some(candidate => hasVerifiedRecovery(step, candidate, previous)));
}

export function recoveryPlanningContext(task: OpsTask) {
  // Expose recorded execution facts without asking Core to decide whether the
  // business goal is still blocked or a later observation was sufficient.
  // That interpretation belongs to the model's next-stage decision.
  const failedAttempts = recoveryHistory(task).filter(isBlockingFailure);
  return {
    currentTargetContext: JSON.stringify([task.executionTargetServerId ?? task.serverId,
      task.currentRoundId ?? "", task.agentSessionId ?? "", task.agentSessionGeneration ?? 0,
      task.credentialRevision ?? 0]),
    failedAttempts: failedAttempts.map(step => ({
      failedStepId: step.id, targetContext: step.attemptContext, title: step.title,
      carryForward: carriedTargets.get(step)?.filter(item => item.destinationRoundId === task.currentRoundId)
        .map(({ taskId, sourceRoundId, destinationRoundId, targetServerId }) =>
          ({ taskId, sourceRoundId, destinationRoundId, targetServerId })),
      validation: step.validation, validationScope: step.validationScope ?? "isolated_exec",
      verification: recoveryVerificationContract(step),
      verificationContractMissing: step.result?.facts.recoveryContractMissing === true || undefined,
      recovery: step.recovery,
    })),
    instruction: "failedAttempts 是 Core 如实保留的历史执行事实，不是 Core 对当前业务是否仍受阻的裁决。请结合用户目标、失败后的全部新证据和实际验收结果自行判断 complete、continue 或 adjust；不得改写历史失败事实。可替换失败步骤、插入前置步骤或重新规划剩余任务；被新方案替代的旧路径无需逐条执行成功。verification 仅为历史验收参考，可修正原验收命令和 expected，并说明新方法如何证明用户要求，不能降低用户要求或把命令退出 0 当作目标完成。recovery 是可选的审计关联，不是执行通行证；普通只读诊断或新方案不必附加。明确关联特定失败时可提供 recovery={failedStepId,targetContext,purpose:diagnose|repair|verify}，使用真实 ID 和 targetContext，diagnose 保持只读，repair 仍需变更授权。repair 成功本身不等于验收通过，recovery 关系不扩大授权。",
  };
}

/**
 * Validates executor-owned protocol invariants only. Historical failures remain
 * available to the model as evidence, but Core does not reject an otherwise
 * executable proposal because it disagrees with the model's recovery relation.
 */
export function validateRecoveryReferences(history: PlanStep[], candidates: PlanStep[], _context: string) {
  candidates.forEach((candidate, stepIndex) => {
    const priorAttempt = history.find(step => step.id === candidate.id && step !== candidate && hasRecordedAttempt(step));
    if (priorAttempt) {
      throw new RecoveryProtocolError({ code: "PLAN_ATTEMPT_ID_REUSED", stepIndex, stepId: candidate.id,
        fieldPath: `steps[${stepIndex}].id`, expected: "新计划步骤不得复用已执行尝试的 ID；原始失败与证据必须保留独立身份。",
        allowedRepairPaths: [], ruleVersion: RECOVERY_RULE_VERSION });
    }
    if (!candidate.recovery) return;
    validateRecoveryMetadata(candidate, stepIndex);
  });
}

export function validateRecoveryMetadata(step: PlanStep, stepIndex = 0) {
  const issue = recoveryMetadataIssue(step, stepIndex);
  if (issue) throw new RecoveryProtocolError(issue);
}
