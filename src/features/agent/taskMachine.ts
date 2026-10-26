import type { OpsTask, TaskStatus } from "@/types";
import { recordTaskTerminalTransition } from "./taskTerminalEvidence";
import { hasCurrentPlanApproval, stepMatchesExecutionIntent } from "./stepApproval";

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ["planning", "cancelled"],
  planning: ["awaiting_input", "awaiting_plan_approval", "awaiting_continuation", "planning_failed", "needs_adjustment", "completed", "failed", "cancelled"],
  planning_failed: ["planning", "needs_adjustment", "cancelled"],
  awaiting_plan_approval: ["awaiting_input", "running", "cancelled", "failed"],
  running: ["planning", "awaiting_step_approval", "awaiting_input", "validating", "needs_adjustment", "completed", "failed", "cancelled"],
  awaiting_step_approval: ["running", "needs_adjustment", "cancelled", "failed"],
  awaiting_input: ["running", "cancelled", "failed"],
  validating: ["awaiting_input", "running", "awaiting_continuation", "needs_adjustment", "completed", "failed", "cancelled"],
  awaiting_continuation: ["planning", "awaiting_plan_approval", "failed", "cancelled"],
  needs_adjustment: ["planning", "awaiting_plan_approval", "failed", "cancelled"],
  completed: ["planning"],
  failed: ["planning", "awaiting_plan_approval", "needs_adjustment", "cancelled"],
  cancelled: ["planning"],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function transitionTask(task: OpsTask, nextStatus: TaskStatus, timestamp = new Date().toISOString()) {
  if (!canTransitionTask(task.status, nextStatus)) {
    throw new Error(`非法任务状态迁移：${task.status} -> ${nextStatus}`);
  }
  recordTaskTerminalTransition(task, task.status, nextStatus, timestamp);
  task.status = nextStatus;
  task.updatedAt = timestamp;
  return task;
}

/** Resume one controller-claimed, never-dispatched step without issuing a new approval. */
export function resumeUndispatchedConnectionPlan(task: OpsTask, timestamp = Date.now()) {
  const record = task.connectionRecovery;
  const step = task.plan.find(item => !["completed", "failed", "skipped"].includes(item.status));
  if (task.status !== "needs_adjustment" || task.cancelRequested || task.goalCancellation
    || !record || record.state !== "resuming" || record.resumeCount !== 1
    || record.dispatchState !== "not_dispatched" || timestamp >= record.deadlineAt
    || record.taskId !== task.id || record.roundId !== task.currentRoundId
    || record.workflowEpoch !== (task.workflowEpoch ?? 0)
    || record.requirementRevision !== (task.requirementLifecycle?.revision ?? 0)
    || record.permission !== task.permission || record.credentialRevision !== (task.credentialRevision ?? 0)
    || task.requirementProcessing || task.pendingRequirements?.length
    || !step || step.id !== record.stepId || step.status !== "pending"
    || step.executionIntent?.digest !== record.intentDigest || !stepMatchesExecutionIntent(step)
    || step.executionLedgerAttempts?.length || task.currentExecutionId
    || !task.preparedPlan || task.preparedPlan.executionDigest !== record.planExecutionDigest
    || !hasCurrentPlanApproval(task.preparedPlan, task.planApproval)) {
    throw new Error("连接恢复的原计划或未派发条件已失效，不能继续执行");
  }
  const at = new Date(timestamp).toISOString();
  recordTaskTerminalTransition(task, task.status, "running", at);
  task.status = "running";
  task.updatedAt = at;
  return task;
}

/** Only a classified, user-submitted execution requirement can replace a waiting workflow. */
export function beginRequirementPlanning(task: OpsTask, relation: import("@/types").RequirementRelation) {
  if (!["continue", "supplement", "new_goal", "replace_goal"].includes(relation)) {
    throw new Error("旁问或取消目标不能启动执行规划");
  }
  if (task.status === "awaiting_input" && relation === "continue") {
    throw new Error("继续不能代替当前步骤必须由用户确认的输入");
  }
  if (["awaiting_input", "awaiting_step_approval", "awaiting_plan_approval"].includes(task.status)) {
    task.status = "planning";
    task.updatedAt = new Date().toISOString();
    return;
  }
  transitionTask(task, "planning");
}
