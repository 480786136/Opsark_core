import type { OpsTask } from "@/types";

export function hasPendingRequirement(task: OpsTask): boolean {
  return Boolean(task.pendingRequirements?.length);
}

/** Runs synchronously before credentials, model or terminal work can yield. */
export function beginRequirementAdmission(task: OpsTask, id: string, content: string, receivedAt: string) {
  const prior = task.pendingRequirements?.map(item => ({ ...item }));
  // An explicit retry replaces only the same original requirement, never another one.
  const existingIndex = task.pendingRequirements?.findIndex(item => item.content === content) ?? -1;
  const pending = { id, content, baseRevision: task.requirementLifecycle?.revision ?? 0,
    state: "pending" as const, receivedAt };
  task.pendingRequirements = [...(task.pendingRequirements ?? [])];
  if (existingIndex >= 0) task.pendingRequirements[existingIndex] = pending;
  else task.pendingRequirements.push(pending);
  task.workflowEpoch = (task.workflowEpoch ?? 0) + 1;
  return prior;
}

export function settleRequirementAdmission(task: OpsTask, id: string) {
  const remaining = task.pendingRequirements?.filter(item => item.id !== id);
  task.pendingRequirements = remaining?.length ? remaining : undefined;
}

export function failRequirementAdmission(task: OpsTask, id: string, error: string) {
  const pending = task.pendingRequirements?.find(item => item.id === id);
  if (!pending) return false;
  pending.state = "failed";
  pending.error = error;
  if (!task.cancelRequested) task.status = "planning_failed";
  return true;
}

export function restoreRequirementAdmissionAfterRestart(task: OpsTask) {
  if (!hasPendingRequirement(task)) return;
  for (const item of task.pendingRequirements!) {
    if (item.state === "pending") {
      item.state = "failed";
      item.error = "需求理解被重启中断，请重新处理该需求后再执行。";
    }
  }
  if (!task.cancelRequested && task.status !== "cancelled") {
    task.status = "planning_failed";
    task.managedAdjustmentPhase = "manual_required";
    task.managedStopReason = "model_generation_failed";
    task.autoAdjustmentSeconds = undefined;
    task.pauseReason = "仍有需求未完成理解，旧计划已暂停；请先重试处理未完成的需求。";
  }
}

export function assertRequirementAdmission(task: OpsTask) {
  if (hasPendingRequirement(task)) throw new Error("仍有用户需求未完成理解，禁止批准或派发旧计划；请先重试处理未完成的需求。");
}

export function assertPlanRequirementRevision(task: OpsTask) {
  assertRequirementAdmission(task);
  if (task.preparedPlan && (task.preparedPlan.requirementRevision ?? 0) !== (task.requirementLifecycle?.revision ?? 0)) {
    throw new Error("计划对应的需求版本已失效，请按当前需求重新生成并批准计划。");
  }
}
