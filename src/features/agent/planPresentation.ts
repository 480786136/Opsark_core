import type { OpsTask } from "@/types";

type PlanPresentationTask = Pick<OpsTask, "status" | "plan" | "pauseReason"> & Partial<Pick<OpsTask,
  "latestGoalReview" | "managedStopReason" | "managedAdjustmentPhase" | "adjustmentIncident"
  | "modelPlanningBlocker" | "protocolRepair"
>>;

export type PlanAction = "continuation" | "replan" | "retry" | "blocked" | "transport";

/** Presentation only: execution and approval continue to use the task state machine. */
export function planAction(task: PlanPresentationTask): PlanAction {
  if (task.adjustmentIncident?.kind === "transport"
    || task.managedAdjustmentPhase === "waiting_transport"
    || task.managedStopReason === "transport_recovery") return "transport";
  if (task.modelPlanningBlocker || task.protocolRepair || task.status === "planning_failed"
    || task.managedStopReason === "model_generation_failed"
    || /(?:调整|后续)计划生成失败|计划生成未通过|阶段联合决策结构解析失败|后续方案暂未就绪/.test(task.pauseReason ?? "")) return "retry";
  if (["no_action", "user_input_required", "no_progress", "retry_exhausted", "workflow_error"].includes(task.managedStopReason ?? "")
    || (task.latestGoalReview?.decision.decision === "adjust"
      && task.latestGoalReview.nextPlan?.length === 0)) return "blocked";
  if (task.status === "needs_adjustment" || task.latestGoalReview?.decision.decision === "adjust"
    || task.plan.some(step => step.status === "failed")) return "replan";
  return "continuation";
}

export function isNormalContinuation(task: PlanPresentationTask): boolean {
  return task.status === "awaiting_continuation" && planAction(task) === "continuation";
}
