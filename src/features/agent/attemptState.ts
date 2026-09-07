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
<<<<<<< HEAD
  return step.kind === "change" && ["completed", "failed"].includes(step.status)
    && step.result?.executionStatus !== "blocked"
    && step.result?.facts.category !== "plan_safety_rejection"
    && step.result?.facts.commandCompleted !== false;
=======
  // commandCompleted describes success, not whether the shell ran. Failed
  // compound commands may already have installed packages or changed files.
  const dispatched = step.result?.facts.commandDispatched === true
    || step.result?.exitCode !== undefined
    || step.evidence?.some((item) => item.source === "main"
      && (typeof item.facts.exitCode === "number" || item.facts.stoppedByPeriodicReview === true));
  return step.kind === "change" && ["completed", "failed"].includes(step.status)
    && step.result?.executionStatus !== "blocked"
    && step.result?.facts.category !== "plan_safety_rejection"
    && (dispatched || step.result?.facts.commandCompleted !== false);
>>>>>>> origin/master
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
