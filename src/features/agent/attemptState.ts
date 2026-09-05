import type { OpsTask, PlanStep } from "@/types";
import { activeRoundSteps } from "@/features/agent/taskGoal";

/** Runtime identity only; never credentials or model-generated claims. */
export function taskAttemptContext(task: OpsTask) {
  return JSON.stringify([
    task.executionTargetServerId ?? task.serverId, task.currentRoundId ?? "",
    task.agentSessionId ?? "", task.agentSessionGeneration ?? 0, task.credentialRevision ?? 0,
  ]);
}

export function mayHaveChangedState(step: PlanStep) {
  return step.kind === "change" && ["completed", "failed"].includes(step.status)
    && step.result?.executionStatus !== "blocked"
    && step.result?.facts.category !== "plan_safety_rejection"
    && step.result?.facts.commandCompleted !== false;
}

/** Conservatively invalidate target-wide observations after a possible mutation. */
export function currentEvidenceSteps(task: OpsTask, includePartial = false) {
  const steps = activeRoundSteps(task);
  let boundary = -1;
  steps.forEach((step, index) => { if (mayHaveChangedState(step)) boundary = index; });
  return steps.slice(boundary + 1).filter((step) =>
    step.attemptContext === taskAttemptContext(task) && step.status === "completed"
    && step.result?.executionStatus === "success" && (includePartial || step.result?.facts.truncated !== true),
  );
}
