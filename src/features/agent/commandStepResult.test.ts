import { describe, expect, it } from "vitest";
import {
  applyCommandFailure,
  applyValidatedStepResult,
  buildCommandFailure,
  buildPeriodicReviewFailure,
} from "@/features/agent/commandStepResult";
import type { PlanStep } from "@/types";

function createStep(): PlanStep {
  return {
    id: "step-1",
    title: "检查服务",
    description: "检查服务状态",
    command: "systemctl status app",
    risk: "low",
    expected: "服务运行",
    validation: "systemctl is-active app",
    status: "validating",
  };
}

describe("command step result", () => {
  it("builds consistent evidence when periodic review stops a command", () => {
    const outcome = buildPeriodicReviewFailure({
      review: { decision: "adjust", reason: "无持续进展", summary: "需要调整", source: "model" },
      output: "still waiting",
      exitCode: 130,
      reviewRound: 2,
      elapsedSeconds: 65,
      validationPassed: false,
      evidenceId: "evidence-review",
      collectedAt: "2026-08-14T01:00:00.000Z",
    });

    expect(outcome.result).toMatchObject({
      executionStatus: "failed",
      facts: { stoppedByPeriodicReview: true, reviewRound: 2 },
      evidenceIds: ["evidence-review"],
      failureReason: "无持续进展",
    });
    expect(outcome.evidence[0].facts).toMatchObject({ elapsedSeconds: 65, validationPassed: false });
  });

  it("classifies main command failure and shares facts with evidence", () => {
    const outcome = buildCommandFailure({
      output: "bash: deploy: command not found",
      exitCode: 127,
      evidenceId: "evidence-main",
      collectedAt: "2026-08-14T01:00:00.000Z",
    });

    expect(outcome.failure.facts.category).toBe("command_not_found");
    expect(outcome.result).toMatchObject({
      exitCode: 127,
      facts: { commandCompleted: false, category: "command_not_found" },
      evidenceIds: ["evidence-main"],
    });
    expect(outcome.evidence[0].facts).toMatchObject({ success: false, category: "command_not_found" });
  });

  it("applies a main command failure through the step state machine", () => {
    const step = createStep();
    step.status = "running";
    const outcome = applyCommandFailure(step, {
      output: "permission denied",
      exitCode: 1,
      evidenceId: "evidence-main",
      collectedAt: "2026-08-14T01:00:00.000Z",
    });

    expect(step.status).toBe("failed");
    expect(step.result).toBe(outcome.result);
    expect(step.evidence).toBe(outcome.evidence);
  });

  it("applies classified validation data and a normalized validator", () => {
    const step = createStep();
    applyValidatedStepResult(step, {
      accepted: true,
      needsModelReview: false,
      result: {
        executionStatus: "success",
        observationStatus: "healthy",
        facts: { active: true },
        warnings: [],
        evidenceIds: ["evidence-validation"],
      },
      evidence: [{
        id: "evidence-validation",
        type: "service",
        source: "validation",
        facts: { active: true },
        rawOutput: "active",
        collectedAt: "2026-08-14T01:00:00.000Z",
      }],
    });

    expect(step.validator).toMatchObject({ type: "service", command: "systemctl is-active app" });
    expect(step.result?.observationStatus).toBe("healthy");
    expect(step.evidence?.[0].id).toBe("evidence-validation");
  });
});
