import type { OpsTask } from "@/types";

export class StaleWorkflowError extends Error {
  constructor() { super("任务已取消或执行轮次已变化，丢弃过期结果"); }
}

/** Capture before awaiting. A later round must never inherit an old response. */
export function workflowLifetime(task: OpsTask) {
  const epoch = task.workflowEpoch ?? 0;
  const round = task.currentRoundId;
  return {
    current: () => !task.cancelRequested && task.status !== "cancelled"
      && (task.workflowEpoch ?? 0) === epoch && task.currentRoundId === round,
    assertCurrent() { if (!this.current()) throw new StaleWorkflowError(); },
  };
}
