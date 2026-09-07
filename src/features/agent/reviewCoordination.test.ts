import { describe, expect, it } from "vitest";
import {
  applyCommandFailureReview,
  applyExecutionEvidenceReview,
  applyPeriodicReviewAdjustment,
} from "@/features/agent/reviewCoordination";
import type { PlanStep, StepReview } from "@/types";

function createStep(id: string, status: PlanStep["status"]): PlanStep {
  return {
    id,
    title: id,
    description: id,
    command: "command",
    risk: "low",
    expected: "success",
    validation: "true",
    status,
  };
}

function review(decision: StepReview["decision"]): StepReview {
  return {
    decision,
    reason: `${decision} reason`,
    summary: `${decision} summary`,
    source: "model",
  };
}

describe("review coordination", () => {
  it("writes periodic-review failure data and pauses the task", () => {
    const step = createStep("long-running", "running");
    const outcome = applyPeriodicReviewAdjustment(step, {
      review: review("adjust"),
      output: "still waiting",
      exitCode: 130,
      reviewRound: 2,
      elapsedSeconds: 65,
      validationPassed: false,
      evidenceId: "evidence-periodic-review",
      collectedAt: "2026-08-14T01:00:00.000Z",
    });

    expect(step.status).toBe("failed");
    expect(step.review?.decision).toBe("adjust");
    expect(step.result).toMatchObject({
      executionStatus: "failed",
      facts: { stoppedByPeriodicReview: true, reviewRound: 2 },
    });
    expect(step.evidence?.[0].id).toBe("evidence-periodic-review");
    expect(outcome).toMatchObject({
      taskStatus: "needs_adjustment",
      shouldAdvance: false,
      pauseReason: "长任务定期复核建议调整：adjust reason",
    });
    expect(outcome.eventMessage).toContain("adjust summary");
  });

  it("pauses after a failed command adjustment decision", () => {
    const step = createStep("failed", "failed");
    const outcome = applyCommandFailureReview(step, [], review("adjust"));

    expect(outcome).toMatchObject({ taskStatus: "needs_adjustment", shouldAdvance: false });
    expect(outcome.pauseReason).toContain("adjust reason");
    expect(step.review?.decision).toBe("adjust");
  });

  it("skips remaining work when failed-command review completes the goal", () => {
    const step = createStep("failed", "failed");
    const remaining = [createStep("remaining-1", "pending"), createStep("remaining-2", "pending")];
    const outcome = applyCommandFailureReview(step, remaining, review("complete"));

    expect(outcome.taskStatus).toBe("running");
    expect(outcome.shouldAdvance).toBe(true);
    expect(remaining.every((item) => item.status === "skipped")).toBe(true);
  });

  it("keeps remaining work pending after a continue decision", () => {
    const step = createStep("failed", "failed");
    const remaining = [createStep("remaining", "pending")];
    const outcome = applyCommandFailureReview(step, remaining, review("continue"));

    expect(outcome.shouldAdvance).toBe(true);
    expect(remaining[0].status).toBe("pending");
  });

  it("fails a validating step after evidence review requests adjustment", () => {
    const step = createStep("validate", "validating");
    const outcome = applyExecutionEvidenceReview({
      step,
      remainingSteps: [],
      review: review("adjust"),
      reviewWasRequired: true,
    });

    expect(step.status).toBe("failed");
    expect(outcome).toMatchObject({ taskStatus: "needs_adjustment", shouldAdvance: false });
  });

  it("completes evidence and skips remaining work when the reviewed goal is complete", () => {
    const step = createStep("validate", "validating");
    const remaining = [createStep("remaining", "pending")];
    const outcome = applyExecutionEvidenceReview({
      step,
      remainingSteps: remaining,
      review: review("complete"),
      reviewWasRequired: true,
    });

    expect(step.status).toBe("completed");
    expect(remaining[0].status).toBe("skipped");
    expect(outcome.eventMessage).toContain("已跳过 1 个");
  });

  it("does not skip remaining work for a deterministic completion without model review", () => {
    const step = createStep("validate", "validating");
    const remaining = [createStep("remaining", "pending")];
    applyExecutionEvidenceReview({
      step,
      remainingSteps: remaining,
      review: { ...review("complete"), source: "rules" },
      reviewWasRequired: false,
    });

    expect(step.status).toBe("completed");
    expect(remaining[0].status).toBe("pending");
  });
});
