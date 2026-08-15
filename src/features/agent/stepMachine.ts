import type { PlanStep, StepStatus } from "@/types";

const TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  pending: ["awaiting_approval", "awaiting_input", "running", "failed", "skipped"],
  awaiting_approval: ["awaiting_input", "running", "failed", "skipped"],
  awaiting_input: ["pending", "failed", "skipped"],
  running: ["validating", "completed", "failed", "skipped"],
  validating: ["completed", "failed", "skipped"],
  completed: [],
  failed: [],
  skipped: [],
};

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/**
 * Applies a validated step transition so execution paths cannot silently enter
 * an impossible state. Related result fields remain owned by their domain use case.
 */
export function transitionStep(step: PlanStep, nextStatus: StepStatus): PlanStep {
  if (!canTransitionStep(step.status, nextStatus)) {
    throw new Error(`非法步骤状态迁移：${step.status} -> ${nextStatus}`);
  }
  step.status = nextStatus;
  return step;
}
