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
const authorizedAttempts = new WeakMap<PlanStep, string>();
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

export function attemptAuthorizationFingerprint(task: OpsTask, step: PlanStep, blocker: PlanStep) {
  return JSON.stringify([task.executionTargetServerId ?? task.serverId, task.currentRoundId,
    task.agentSessionId, task.agentSessionGeneration, task.credentialRevision, task.rootGoal,
    task.currentInstruction, task.permission, task.executionConstraints,
    step.id, step.command, step.validation, step.kind, step.executionScope, step.validationScope,
    step.sessionContextChange, step.startedAt, blocker.id, blocker.attemptContext, blocker.result,
    unresolvedRecoveryBlockers(task, step).map(item => [item.id, item.attemptContext, item.result])]);
}

/** Executor-owned ephemeral permit; persisted/model-authored reviews never grant dispatch. */
export function authorizeRiskAttempt(task: OpsTask, step: PlanStep, blocker: PlanStep) {
  authorizedAttempts.set(step, attemptAuthorizationFingerprint(task, step, blocker));
}

export function hasRiskAttemptAuthorization(task: OpsTask, step: PlanStep, blocker: PlanStep) {
  return authorizedAttempts.get(step) === attemptAuthorizationFingerprint(task, step, blocker);
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

export function recoveryVerificationContract(failed: PlanStep) {
  const contract = failed.kind === "observe"
    ? { kind: failed.kind, expected: failed.expected, command: failed.command.trim(), executionScope: failed.executionScope ?? "isolated_exec", validationScope: "isolated_exec" }
    : { kind: failed.kind ?? "change", expected: failed.expected, command: failed.validation.trim(), executionScope: "isolated_exec", validationScope: failed.validationScope ?? "isolated_exec" };
  const supplementalVerification = isMutatingStepCommand(contract.command) || contract.validationScope !== "isolated_exec"
    ? undefined : supplementalRecoveryAcceptance(contract.command);
  return { ...contract, supplementalVerification,
    requiresAcceptanceEvidence: !validationHasAcceptanceCheck(contract.command) || undefined,
    acceptanceInstruction: supplementalVerification
      ? "原始查询只证明执行成功。使用 supplementalVerification.command 原文补验；原查询、expected 和目标不变，程序将记录追加断言的来源。"
      : !validationHasAcceptanceCheck(contract.command)
        ? "原始命令没有可证明预期状态的退出码断言；不得把 raw/exit 0 当作恢复。先补读原始验收证据或取得明确验收条件，再恢复；不得降级原 executionScope/validationScope。"
        : undefined,
  };
}

/** Only the exact referenced attempt may be recovered; shared names/paths prove nothing. */
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
  // The original postcondition is the acceptance contract. Fresh-shell checks
  // retain their independent validation scope via a change-kind verify step.
  const scope = contract.validationScope;
  return candidate.kind === "observe"
    ? scope === "isolated_exec" && (candidate.executionScope ?? "isolated_exec") === contract.executionScope
    : candidate.kind === "change" && candidate.validation.trim() === validation
      && (candidate.validationScope ?? "isolated_exec") === scope;
}

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

/** Persist only gate/acceptance data, never full outputs, for trimmed phases. */
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
  // Unresolved failures belong to the task. Visibility survives round changes;
  // permission to reference them still requires an explicit executor handoff.
  const persisted = (task.historyCheckpoint?.unresolvedIssues ?? []).flatMap(issue => {
    if (issue.blocksExecution === false) return [];
    if (issue.recoveryContract) return [issue.recoveryContract.step];
    // Missing legacy acceptance evidence is a visible blocker, never an empty
    // issue list. Its real contract must be recovered before execution resumes.
    return [{ id: issue.stepId, title: issue.title, description: issue.reason ?? "原始验收契约缺失，需要补读证据",
      command: "", validation: "", expected: "", risk: "low", status: "failed", kind: "change",
      attemptContext: issue.attemptContext, result: { executionStatus: "blocked", observationStatus: "unknown",
        facts: { blockingSignal: true, recoveryContractMissing: true }, warnings: [], evidenceIds: [],
        failureReason: "历史失败的原始验收契约缺失，需要补读原始证据后恢复规划。" },
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

export function unresolvedRecoveryBlockers(task: OpsTask, beforeStep?: PlanStep) {
  const history = recoveryHistory(task);
  const end = beforeStep ? history.findIndex(step => step.id === beforeStep.id) : history.length;
  const previous = history.slice(0, end < 0 ? history.length : end);
  return previous.filter((step, index) => isBlockingFailure(step)
    && !previous.slice(index + 1).some(candidate => hasVerifiedRecovery(step, candidate, previous)));
}

export function recoveryPlanningContext(task: OpsTask) {
  return {
    currentTargetContext: JSON.stringify([task.executionTargetServerId ?? task.serverId,
      task.currentRoundId ?? "", task.agentSessionId ?? "", task.agentSessionGeneration ?? 0,
      task.credentialRevision ?? 0]),
    blockers: unresolvedRecoveryBlockers(task).map(step => ({
      failedStepId: step.id, targetContext: step.attemptContext, title: step.title,
      carryForward: carriedTargets.get(step)?.filter(item => item.destinationRoundId === task.currentRoundId)
        .map(({ taskId, sourceRoundId, destinationRoundId, targetServerId }) =>
          ({ taskId, sourceRoundId, destinationRoundId, targetServerId })),
      validation: step.validation, validationScope: step.validationScope ?? "isolated_exec",
      verification: recoveryVerificationContract(step),
      verificationContractMissing: step.result?.facts.recoveryContractMissing === true || undefined,
      recovery: step.recovery,
    })),
    instruction: "有未解决阻断时，下一步必须显式关联 recovery={failedStepId,targetContext,purpose:diagnose|repair|verify}。先诊断/修复，再以 blocker.verification.command 原文执行 verify（change 的原 validation，observe 的原观察命令）；如果提供 supplementalVerification，则必须使用其 command 原文执行显式补验，保留全部原查询和 expected，不得自行改写追加断言。expected 保留 verification.expected；repair 成功不解除阻断，验收证据必须晚于最后一次 repair。raw 输出和 exit 0 只证明命令执行，缺少可靠验收时先补读原始契约。verify 默认 observe（validation 空）并保留 verification.executionScope；verification.validationScope 非 isolated_exec 时使用 change 并保留该 command 作为 validation 及原 validationScope，此形式仍需变更授权。未通过真实复验前不得执行后续业务或宣称完成；不要推测不存在的步骤 ID 或 targetContext；恢复关系不扩大授权。",
  };
}

export function validateRecoveryReferences(history: PlanStep[], candidates: PlanStep[], context: string) {
  candidates.forEach((candidate, stepIndex) => {
    const priorAttempt = history.find(step => step.id === candidate.id && step !== candidate && hasRecordedAttempt(step));
    if (priorAttempt) {
      throw new RecoveryProtocolError({ code: "PLAN_ATTEMPT_ID_REUSED", stepIndex, stepId: candidate.id,
        fieldPath: `steps[${stepIndex}].id`, expected: "新计划步骤不得复用已执行尝试的 ID；原始失败与证据必须保留独立身份。",
        allowedRepairPaths: [], ruleVersion: RECOVERY_RULE_VERSION });
    }
    if (!candidate.recovery) return;
    validateRecoveryMetadata(candidate, stepIndex);
    const failed = history.find(step => step.id === candidate.recovery!.failedStepId);
    const missing = !failed || !isBlockingFailure(failed);
    const wrongTarget = failed && (candidate.recovery.targetContext !== failed.attemptContext
      || (!sameRecoveryTarget(candidate.recovery.targetContext, context) && !permitsCarriedTarget(failed, context)));
    if (!missing && !wrongTarget && isRelatedRecoveryStep(failed!, candidate, context)) return;
    throw new RecoveryProtocolError({
      code: missing ? "RECOVERY_REFERENCE_MISSING" : wrongTarget ? "RECOVERY_TARGET_MISMATCH" : "RECOVERY_ACCEPTANCE_MISMATCH",
      stepIndex, stepId: candidate.id,
      fieldPath: `steps[${stepIndex}].recovery${missing ? ".failedStepId" : wrongTarget ? ".targetContext" : ""}`,
      expected: missing ? "recovery 必须引用本 Task 权威历史中的既有失败，不能引用其他 Task 或模型上下文中的步骤。"
        : wrongTarget ? "recovery 必须保留原 targetContext；跨 Round 需要同 Task、同资源的程序承接记录。"
          : "recovery 必须保留既有失败的原始验收契约；缺失或需要修订时先补取权威证据。",
      allowedRepairPaths: [], ruleVersion: RECOVERY_RULE_VERSION,
    });
  });
}

export function validateRecoveryMetadata(step: PlanStep, stepIndex = 0) {
  const issue = recoveryMetadataIssue(step, stepIndex);
  if (issue) throw new RecoveryProtocolError(issue);
}
