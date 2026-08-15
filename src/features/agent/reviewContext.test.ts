import { describe, expect, it } from "vitest";
import {
  buildEvidenceReviewContext,
  buildExecutionFailureReviewContext,
  buildLongRunningReviewContext,
  buildPreconditionReviewContext,
} from "@/features/agent/reviewContext";
import type { OpsTask, PlanStep } from "@/types";

const step = (id: string, status: PlanStep["status"]): PlanStep => ({
  id,
  title: id,
  description: "description",
  command: "command",
  risk: "low",
  expected: "expected",
  validation: "validation",
  status,
  output: "output",
});

function task(): OpsTask {
  return {
    id: "task-1",
    serverId: "server-1",
    title: "task",
    status: "validating",
    permission: "safe",
    modelId: "model-1",
    messages: [],
    plan: [step("blocker", "completed"), step("current", "running"), step("remaining", "pending")],
    createdAt: "now",
    updatedAt: "now",
  };
}

describe("review context", () => {
  it("builds stable policy flags for every review trigger", () => {
    const currentTask = task();
    const current = currentTask.plan[1];
    const remaining = [currentTask.plan[2]];

    expect(buildPreconditionReviewContext(currentTask, current, currentTask.plan[0], "requirement").reviewPolicy.preconditionGate).toBe(true);
    expect(buildExecutionFailureReviewContext(currentTask, current, remaining, "requirement").reviewPolicy.commandExecutionFailed).toBe(true);
    expect(buildEvidenceReviewContext(currentTask, current, remaining, "requirement", true).reviewPolicy?.postconditionFailed).toBe(true);
    expect(buildLongRunningReviewContext({
      task: currentTask,
      step: current,
      requirement: "requirement",
      reviewRound: 1,
      elapsedSeconds: 30,
      streamedOutput: "running",
      observation: { passed: false, detail: "waiting", output: "not ready" },
    }).reviewPolicy.periodicLongRunningReview).toBe(true);
  });

  it("keeps pending and historical steps in separate collections", () => {
    const currentTask = task();
    const context = buildExecutionFailureReviewContext(
      currentTask,
      currentTask.plan[1],
      [currentTask.plan[2]],
      "requirement",
    );

    expect(context.executionHistory.map((item) => item.title)).toEqual(["blocker"]);
    expect(context.remainingSteps.map((item) => item.title)).toEqual(["remaining"]);
    expect(context.fullPlan).toHaveLength(3);
  });
});
