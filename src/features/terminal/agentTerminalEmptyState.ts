import type { OpsTask, TaskStatus } from "@/types";

type TerminalTask = Pick<OpsTask, "status" | "plan" | "pauseReason" | "adjustmentInProgress">;

const statusKeys = {
  draft: "draft",
  planning: "planning",
  planning_failed: "planningFailed",
  awaiting_plan_approval: "awaitingPlanApproval",
  running: "running",
  awaiting_step_approval: "awaitingStepApproval",
  awaiting_input: "awaitingInput",
  validating: "validating",
  awaiting_continuation: "awaitingContinuation",
  needs_adjustment: "needsAdjustment",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} satisfies Record<TaskStatus, string>;

/** Empty terminal output describes the task phase; it is not evidence of dispatch. */
export function agentTerminalEmptyState(task?: TerminalTask): {
  messageKey: string;
  toolId?: string;
  reason?: string;
} {
  if (!task) return { messageKey: "terminal.agentEmpty.unavailable" };
  if (task.status === "needs_adjustment" && task.adjustmentInProgress) {
    return { messageKey: "terminal.agentEmpty.adjusting" };
  }
  if (task.status === "running") {
    const active = task.plan.find(step => step.status === "running");
    if (active?.action?.type === "tool") {
      return { messageKey: "terminal.agentEmpty.toolRunning", toolId: active.action.toolId };
    }
  }
  const showReason = ["planning_failed", "needs_adjustment", "failed", "awaiting_continuation"].includes(task.status);
  const failedStep = showReason ? [...task.plan].reverse().find(step => step.status === "failed") : undefined;
  return {
    messageKey: `terminal.agentEmpty.${statusKeys[task.status]}`,
    reason: showReason ? task.pauseReason?.trim() || failedStep?.result?.failureReason?.trim() : undefined,
  };
}
