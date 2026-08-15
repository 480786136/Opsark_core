import { describe, expect, it, vi } from "vitest";
import {
  runCommandFailureReviewPipeline,
  runEvidenceReviewPipeline,
  runPreconditionReviewPipeline,
} from "@/features/agent/stepReviewPipeline";
import type { OpsTask, PlanStep, StepReview } from "@/types";

function step(id: string, status: PlanStep["status"]): PlanStep {
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

function task(plan: PlanStep[]): OpsTask {
  return {
    id: "task-1",
    serverId: "server-1",
    title: "task",
    status: "validating",
    permission: "safe",
    modelId: "model-1",
    messages: [],
    plan,
    createdAt: "now",
    updatedAt: "now",
  };
}

const adjust: StepReview = {
  decision: "adjust",
  reason: "blocked",
  summary: "adjust plan",
  source: "rules",
};

const continueReview: StepReview = {
  decision: "continue",
  reason: "risk accepted",
  summary: "continue execution",
  source: "model",
};

describe("step review pipeline", () => {
  it("combines an allowed precondition review, audit and execution coordination", async () => {
    const blocker = step("blocker", "failed");
    const pending = step("pending", "pending");
    const currentTask = task([blocker, pending]);
    const result = await runPreconditionReviewPipeline({
      task: currentTask,
      step: pending,
      blockerStep: blocker,
      serverId: currentTask.serverId,
      taskId: currentTask.id,
      isCancelled: () => false,
    }, vi.fn().mockResolvedValue({
      requirement: "continue safely",
      context: { blocker: blocker.id },
      modelDecision: continueReview,
      finalDecision: continueReview,
      allowed: true,
    }));

    expect(result.audits).toHaveLength(1);
    if (result.cancelled) throw new Error("review unexpectedly cancelled");
    expect(result.coordination).toMatchObject({ taskStatus: "running", shouldExecute: true });
    expect(pending.review).toEqual(continueReview);
  });

  it("pauses after a blocked precondition review", async () => {
    const blocker = step("blocker", "failed");
    const pending = step("pending", "pending");
    const currentTask = task([blocker, pending]);
    const result = await runPreconditionReviewPipeline({
      task: currentTask,
      step: pending,
      blockerStep: blocker,
      serverId: currentTask.serverId,
      taskId: currentTask.id,
      isCancelled: () => false,
    }, vi.fn().mockResolvedValue({
      requirement: "stop safely",
      context: { blocker: blocker.id },
      modelDecision: adjust,
      finalDecision: adjust,
      allowed: false,
    }));

    if (result.cancelled) throw new Error("review unexpectedly cancelled");
    expect(result.coordination).toMatchObject({
      taskStatus: "needs_adjustment",
      shouldExecute: false,
      pauseReason: "前置条件复核建议调整：blocked",
    });
    expect(result.audits[0].level).toBe("warning");
  });

  it("does not apply a precondition review completed after cancellation", async () => {
    const blocker = step("blocker", "failed");
    const pending = step("pending", "pending");
    const currentTask = task([blocker, pending]);
    const result = await runPreconditionReviewPipeline({
      task: currentTask,
      step: pending,
      blockerStep: blocker,
      serverId: currentTask.serverId,
      taskId: currentTask.id,
      isCancelled: () => true,
    }, vi.fn().mockResolvedValue({
      requirement: "cancelled",
      context: {},
      modelDecision: continueReview,
      finalDecision: continueReview,
      allowed: true,
    }));

    expect(result.cancelled).toBe(true);
    expect(result.audits).toEqual([]);
    expect(pending.review).toBeUndefined();
    expect(pending.status).toBe("pending");
  });

  it("combines failed-command review, audit and coordination", async () => {
    const failed = step("failed", "failed");
    const remaining = step("repair", "pending");
    const currentTask = task([failed, remaining]);
    const result = await runCommandFailureReviewPipeline({
      task: currentTask,
      step: failed,
      failureReason: "failed",
      failureCategory: "command_failed",
      serverId: currentTask.serverId,
      taskId: currentTask.id,
      isCancelled: () => false,
    }, vi.fn().mockResolvedValue({
      context: {},
      modelDecision: adjust,
      finalDecision: adjust,
      remainingSteps: [remaining],
      diagnosticStep: false,
      mutatingStep: true,
      recoveryStepFound: false,
      requirement: "repair",
    }));

    expect(result.audits).toHaveLength(1);
    if (result.cancelled) throw new Error("review unexpectedly cancelled");
    expect(result.coordination.taskStatus).toBe("needs_adjustment");
    expect(failed.review).toEqual(adjust);
  });

  it("combines evidence review, ordered audits and remaining-step completion", async () => {
    const validating = step("validate", "validating");
    const remaining = step("remaining", "pending");
    const currentTask = task([validating, remaining]);
    const complete: StepReview = {
      decision: "complete",
      reason: "goal reached",
      summary: "done",
      source: "model",
    };
    const result = await runEvidenceReviewPipeline({
      task: currentTask,
      step: validating,
      reviewRequired: true,
      postconditionReview: false,
      blockingFacts: {},
      serverId: currentTask.serverId,
      taskId: currentTask.id,
      isCancelled: () => false,
    }, vi.fn().mockResolvedValue({
      context: {},
      modelDecision: complete,
      finalDecision: complete,
      remainingSteps: [remaining],
      mutatingStep: false,
      repairStepFound: false,
      requirement: "validate",
    }));

    expect(result.audits).toHaveLength(1);
    if (result.cancelled) throw new Error("review unexpectedly cancelled");
    expect(result.coordination.shouldAdvance).toBe(true);
    expect(validating.status).toBe("completed");
    expect(remaining.status).toBe("skipped");
  });

  it("does not apply an asynchronous review after cancellation", async () => {
    const validating = step("validate", "validating");
    const currentTask = task([validating]);
    const result = await runEvidenceReviewPipeline({
      task: currentTask,
      step: validating,
      reviewRequired: true,
      postconditionReview: false,
      blockingFacts: {},
      serverId: currentTask.serverId,
      taskId: currentTask.id,
      isCancelled: () => true,
    }, vi.fn().mockResolvedValue({
      context: {},
      modelDecision: adjust,
      finalDecision: adjust,
      remainingSteps: [],
      mutatingStep: false,
      repairStepFound: false,
      requirement: "validate",
    }));

    expect(result.cancelled).toBe(true);
    expect(result.audits).toEqual([]);
    expect(validating.status).toBe("validating");
    expect(validating.review).toBeUndefined();
  });
});
