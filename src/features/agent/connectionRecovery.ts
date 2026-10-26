import { executionDigest } from "./planPreparation";
import { hasCurrentPlanApproval, stepMatchesExecutionIntent } from "./stepApproval";
import type {
  ConnectionRecoveryDecisionCode, ExecutionApprovalGrant, OpsTask, PlanStep, TaskConnectionRecovery,
} from "@/types";

export const CONNECTION_RECOVERY_WINDOW_MS = 60_000;

export interface ConnectionRecoveryInput {
  task: OpsTask;
  step?: PlanStep;
  target: TaskConnectionRecovery["target"];
  now: number;
  /** Only a fresh, successful ledger lookup can establish false/not_dispatched. */
  operationPresent?: boolean;
  dispatchState?: TaskConnectionRecovery["dispatchState"];
  /** The store must revalidate the complete live proposal, targets, policy and approvals. */
  preparedCurrent: boolean;
}

export interface ConnectionRecoveryDecision {
  action: "wait" | "resume" | "stop";
  code: ConnectionRecoveryDecisionCode;
}

export interface CaptureConnectionRecoveryInput extends Omit<ConnectionRecoveryInput, "operationPresent" | "dispatchState"> {
  step: PlanStep;
  reasonCode?: TaskConnectionRecovery["reasonCode"];
  totalDeadlineAt?: number;
  previous?: TaskConnectionRecovery;
}

const stop = (code: ConnectionRecoveryDecisionCode): ConnectionRecoveryDecision => ({ action: "stop", code });
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
const digest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function publicTarget(target: TaskConnectionRecovery["target"]): TaskConnectionRecovery["target"] {
  return { serverId: target?.serverId, host: target?.host, port: target?.port,
    username: target?.username, generation: target?.generation };
}

function copyRecord(record: TaskConnectionRecovery): TaskConnectionRecovery {
  return {
    version: record.version, reasonCode: record.reasonCode, state: record.state,
    taskId: record.taskId, roundId: record.roundId, workflowEpoch: record.workflowEpoch,
    stepId: record.stepId, stepRevision: record.stepRevision, planRevision: record.planRevision,
    requirementRevision: record.requirementRevision, intentDigest: record.intentDigest,
    planExecutionDigest: record.planExecutionDigest, approvalFingerprint: record.approvalFingerprint,
    permission: record.permission, credentialRevision: record.credentialRevision,
    target: publicTarget(record.target), startedAt: record.startedAt, deadlineAt: record.deadlineAt,
    resumeCount: record.resumeCount, dispatchState: record.dispatchState, stopReason: record.stopReason,
  };
}

function publicGrant(grant?: ExecutionApprovalGrant) {
  return grant ? {
    version: grant.version, source: grant.source, scope: grant.scope, taskId: grant.taskId,
    planRevision: grant.planRevision, stepRevision: grant.stepRevision,
    executionDigest: grant.executionDigest, permission: grant.permission,
    policyVersion: grant.policyVersion, grantedAt: grant.grantedAt,
  } : null;
}

function approvalFingerprint(task: OpsTask, step?: PlanStep) {
  return executionDigest({
    planApproval: publicGrant(task.planApproval), stepApproval: publicGrant(step?.approvalGrant),
    planExecutionDigest: task.preparedPlan?.executionDigest ?? null,
    intentDigest: step?.executionIntent?.digest ?? null, permission: task.permission,
  });
}

/** Used for routing only. A valid blocker identity is not execution authority. */
export function hasActiveConnectionRecovery(task: OpsTask) {
  const record = task.connectionRecovery;
  return Boolean(record?.version === 1 && ["checking", "waiting", "resuming"].includes(record.state)
    && ["connection_unavailable", "connection_generation_changed"].includes(record.reasonCode)
    && record.taskId === task.id && record.roundId === task.currentRoundId
    && record.workflowEpoch === (task.workflowEpoch ?? 0)
    && !task.cancelRequested && !["completed", "cancelled", "failed"].includes(task.status));
}

function recordValid(record: TaskConnectionRecovery) {
  return record?.version === 1 && ["checking", "waiting", "resuming", "stopped", "completed"].includes(record.state)
    && ["connection_unavailable", "connection_generation_changed"].includes(record.reasonCode)
    && text(record.taskId) && text(record.stepId)
    && (record.roundId === undefined || text(record.roundId))
    && integer(record.workflowEpoch) && integer(record.stepRevision, 1) && integer(record.planRevision, 1)
    && integer(record.requirementRevision) && integer(record.credentialRevision)
    && digest(record.intentDigest) && digest(record.planExecutionDigest) && digest(record.approvalFingerprint)
    && ["observe", "safe", "managed"].includes(record.permission)
    && text(record.target?.serverId) && text(record.target.host)
    && integer(record.target.port, 1) && record.target.port <= 65535 && integer(record.target.generation)
    && (record.target.username === undefined || text(record.target.username))
    && integer(record.startedAt, 1) && integer(record.deadlineAt, 1)
    && record.deadlineAt >= record.startedAt && record.deadlineAt - record.startedAt <= CONNECTION_RECOVERY_WINDOW_MS
    && integer(record.resumeCount) && record.resumeCount <= 1
    && ["not_dispatched", "unknown"].includes(record.dispatchState);
}

/** Pure eligibility check. It neither reserves a budget nor submits/retries an operation. */
export function decideConnectionRecovery(
  record: TaskConnectionRecovery,
  input: ConnectionRecoveryInput & { connectionReady: boolean },
): ConnectionRecoveryDecision {
  if (!recordValid(record) || !integer(input.now, 1) || input.now < record.startedAt) return stop("invalid_recovery");
  if (record.state === "stopped") return stop(record.stopReason ?? "invalid_recovery");
  if (!["checking", "waiting"].includes(record.state) || record.resumeCount !== 0) return stop("resume_exhausted");
  const { task, step, target } = input;
  if (task.cancelRequested || task.goalCancellation || task.status === "cancelled") return stop("cancelled");
  if (!["running", "needs_adjustment"].includes(task.status)) return stop("task_inactive");
  if (record.taskId !== task.id || record.roundId !== task.currentRoundId
    || record.workflowEpoch !== (task.workflowEpoch ?? 0)) return stop("context_changed");
  if (task.requirementProcessing || task.pendingRequirements?.length
    || record.requirementRevision !== (task.requirementLifecycle?.revision ?? 0)) return stop("requirements_changed");
  if (input.now >= record.deadlineAt) return stop("deadline_expired");
  if (record.reasonCode === "connection_generation_changed") return stop("generation_changed");
  if (record.target.serverId !== (task.executionTargetServerId ?? task.serverId)
    || record.target.serverId !== target.serverId || record.target.host !== target.host
    || record.target.port !== target.port || record.target.username !== target.username) return stop("target_changed");
  if (record.target.generation !== target.generation) return stop("generation_changed");
  if (record.credentialRevision !== (task.credentialRevision ?? 0)) return stop("credential_changed");
  if (task.permission !== record.permission) return stop("approval_changed");
  if (task.executionLedgerLoading || task.executionLedgerError) return stop("ledger_unavailable");
  if (input.operationPresent === true || step?.executionLedgerAttempts?.length) return stop("operation_present");
  if ((record.state !== "checking" && (record.dispatchState !== "not_dispatched" || input.dispatchState !== "not_dispatched"
    || input.operationPresent !== false)) || task.currentExecutionId || step?.executionPolicy
    || task.executionReconciliation && !task.executionReconciliation.resolution) return stop("dispatch_unknown");
  if (!step || step.id !== record.stepId || step.status !== "pending"
    || task.plan.find(item => !["completed", "failed", "skipped"].includes(item.status)) !== step) return stop("step_not_pending");
  if (task.plan.some(item => item !== step && ["running", "validating", "awaiting_input", "awaiting_approval"].includes(item.status))) {
    return stop("preconditions_changed");
  }
  const prepared = task.preparedPlan;
  if (!prepared || prepared.taskId !== task.id || prepared.planRevision !== record.planRevision
    || prepared.executionDigest !== record.planExecutionDigest
    || (prepared.requirementRevision ?? 0) !== record.requirementRevision
    || step.planRevision !== record.planRevision || step.stepRevision !== record.stepRevision
    || step.executionIntent?.digest !== record.intentDigest
    || !prepared.steps.some(item => item.id === step.id && item.stepRevision === record.stepRevision && item.intent.digest === record.intentDigest)) {
    return stop("plan_changed");
  }
  if (!hasCurrentPlanApproval(prepared, task.planApproval) || approvalFingerprint(task, step) !== record.approvalFingerprint) {
    return stop("approval_changed");
  }
  if (!input.preparedCurrent || !stepMatchesExecutionIntent(step)
    || step.executionIntent?.semantic.taskId !== task.id || step.executionIntent.semantic.permission !== task.permission
    || !step.executionIntent.semantic.targets.some(item => item.serverId === record.target.serverId
      && item.host === record.target.host && item.port === record.target.port && item.username === record.target.username
      && item.connectionGeneration === record.target.generation)) return stop("prepared_not_current");
  if (record.state === "checking") return { action: "wait", code: "checking_dispatch" };
  return input.connectionReady
    ? { action: "resume", code: "ready_to_resume" }
    : { action: "wait", code: "waiting_for_connection" };
}

/** Repeated entry keeps the original window, including across restoration. */
export function createConnectionRecovery(input: ConnectionRecoveryInput & {
  step: PlanStep;
  reasonCode?: TaskConnectionRecovery["reasonCode"];
  totalDeadlineAt?: number;
  previous?: TaskConnectionRecovery;
}): TaskConnectionRecovery {
  if (input.previous) {
    const previous = copyRecord(input.previous);
    if (input.reasonCode === "connection_generation_changed") return { ...previous, state: "stopped", stopReason: "generation_changed" };
    if (input.totalDeadlineAt !== undefined) previous.deadlineAt = Math.min(previous.deadlineAt, input.totalDeadlineAt);
    const decision = decideConnectionRecovery(previous, { ...input, connectionReady: false });
    return decision.action === "stop" ? { ...previous, state: "stopped", stopReason: decision.code } : previous;
  }
  const record = initialRecord(input, "waiting", input.dispatchState ?? "unknown");
  const decision = decideConnectionRecovery(record, { ...input, connectionReady: false });
  return decision.action === "stop" ? { ...record, state: "stopped", stopReason: decision.code } : record;
}

function initialRecord(input: CaptureConnectionRecoveryInput, state: "checking" | "waiting", dispatchState: TaskConnectionRecovery["dispatchState"]): TaskConnectionRecovery {
  const { task, step } = input;
  const deadlineAt = input.totalDeadlineAt === undefined ? input.now + CONNECTION_RECOVERY_WINDOW_MS
    : Math.min(input.now + CONNECTION_RECOVERY_WINDOW_MS, input.totalDeadlineAt);
  return {
    version: 1, reasonCode: input.reasonCode ?? "connection_unavailable", state,
    taskId: task.id, roundId: task.currentRoundId, workflowEpoch: task.workflowEpoch ?? 0,
    stepId: step.id, stepRevision: step.stepRevision ?? 0, planRevision: step.planRevision ?? 0,
    requirementRevision: task.requirementLifecycle?.revision ?? 0,
    intentDigest: step.executionIntent?.digest ?? "", planExecutionDigest: task.preparedPlan?.executionDigest ?? "",
    approvalFingerprint: approvalFingerprint(task, step), permission: task.permission,
    credentialRevision: task.credentialRevision ?? 0, target: publicTarget(input.target),
    startedAt: input.now, deadlineAt, resumeCount: 0, dispatchState,
  };
}

/** Captures scope before an asynchronous ledger read. Checking never grants continuation. */
export function captureConnectionRecovery(input: CaptureConnectionRecoveryInput): TaskConnectionRecovery {
  let record: TaskConnectionRecovery;
  if (input.previous) {
    record = copyRecord(input.previous);
    if (record.state === "stopped") return record;
    if (!["checking", "waiting"].includes(record.state) || record.resumeCount !== 0) {
      return { ...record, state: "stopped", stopReason: "resume_exhausted" };
    }
    if (input.reasonCode === "connection_generation_changed") return { ...record, state: "stopped", stopReason: "generation_changed" };
    if (input.totalDeadlineAt !== undefined) record.deadlineAt = Math.min(record.deadlineAt, input.totalDeadlineAt);
    record.state = "checking";
    record.dispatchState = "unknown";
  } else record = initialRecord(input, "checking", "unknown");
  const decision = decideConnectionRecovery(record, { ...input, connectionReady: false });
  return decision.action === "stop" ? { ...record, state: "stopped", stopReason: decision.code } : record;
}
