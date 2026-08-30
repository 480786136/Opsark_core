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
      reviewRound: 1,
      elapsedSeconds: 30,
      observation: { passed: false, detail: "waiting" },
      progress: {
        workload: "bounded",
        outputFingerprint: "7:12345678",
        outputChangedSinceLastReview: false,
        lastOutputChangeAt: "2026-08-14T00:00:00.000Z",
        noProgressSeconds: 30,
        noProgressReviewRounds: 1,
        consecutiveContinueRounds: 0,
        maxConsecutiveContinueRounds: 2,
        hardLimitSeconds: 90,
      },
      outputWindow: {
        mode: "initial",
        newCharacters: 7,
        omittedCharacters: 0,
        contentFingerprint: "7:12345678",
        content: "running",
      },
    }).reviewPolicy.periodicLongRunningReview).toBe(true);
  });

  it("keeps periodic long-running context bounded to goal-adjacent state", () => {
    const currentTask = task();
    currentTask.plan[1].command = `run ${"x".repeat(10_000)}`;
    const context = buildLongRunningReviewContext({
      task: currentTask,
      step: currentTask.plan[1],
      reviewRound: 3,
      elapsedSeconds: 90,
      observation: { passed: false, detail: "waiting" },
      progress: {
        workload: "progressive",
        outputFingerprint: "100:12345678",
        outputChangedSinceLastReview: true,
        lastOutputChangeAt: "2026-08-14T00:01:30.000Z",
        noProgressSeconds: 0,
        noProgressReviewRounds: 0,
        consecutiveContinueRounds: 0,
        maxConsecutiveContinueRounds: 4,
      },
      outputWindow: {
        mode: "delta",
        newCharacters: 100,
        omittedCharacters: 0,
        contentFingerprint: "100:12345678",
        content: "latest output",
      },
      salientEvidence: ["npm ERR! heap out of memory"],
    });

    expect(context.trigger).toBe("periodic_long_running");
    expect(context.currentStep.command.length).toBeLessThanOrEqual(800);
    expect(context.nextStep?.title).toBe("remaining");
    expect(context.terminalOutput.content).toBe("latest output");
    expect(context.salientEvidence).toEqual(["npm ERR! heap out of memory"]);
    expect(context).not.toHaveProperty("fullPlan");
    expect(context).not.toHaveProperty("executionHistory");
    expect(context).not.toHaveProperty("userRequirement");
    expect(JSON.stringify(context)).not.toContain("gggggggggg");
    expect(JSON.stringify(context).length).toBeLessThan(5_000);
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
