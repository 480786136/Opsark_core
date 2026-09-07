import type { OpsTask, TaskStatus } from "@/types";

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ["planning", "cancelled"],
  planning: ["awaiting_plan_approval", "awaiting_continuation", "planning_failed", "needs_adjustment", "completed", "failed", "cancelled"],
  planning_failed: ["planning", "cancelled"],
  awaiting_plan_approval: ["running", "cancelled", "failed"],
  running: ["planning", "awaiting_step_approval", "awaiting_input", "validating", "needs_adjustment", "completed", "failed", "cancelled"],
  awaiting_step_approval: ["running", "cancelled", "failed"],
  awaiting_input: ["running", "cancelled", "failed"],
  validating: ["running", "awaiting_continuation", "needs_adjustment", "completed", "failed", "cancelled"],
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
  task.status = nextStatus;
  task.updatedAt = timestamp;
  return task;
}
