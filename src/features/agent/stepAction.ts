import type { PlanStep } from "@/types";

type ToolStepBoundary = Pick<PlanStep, "action"> & Partial<Pick<PlanStep,
  "command" | "validation" | "validator" | "sessionContextChange"
>>;

export class ToolStepBoundaryError extends Error {
  constructor() {
    super("工具步骤不能夹带 Shell command、validation、validator 或会话变更");
    this.name = "ToolStepBoundaryError";
  }
}

export function hasToolStepBoundaryConflict(step: ToolStepBoundary): boolean {
  return step.action?.type === "tool"
    && Boolean(step.command || step.validation || step.validator || step.sessionContextChange);
}

/** Shared by plan admission and dispatch; never repairs untrusted proposals. */
export function assertToolStepBoundary(step: ToolStepBoundary): void {
  if (hasToolStepBoundaryConflict(step)) throw new ToolStepBoundaryError();
}

/** Display and binding identity only; this string is never parsed or executed. */
export function stepOperationText(step: Pick<PlanStep, "action" | "command">): string {
  return step.action?.type === "tool" ? JSON.stringify(step.action) : step.command;
}
