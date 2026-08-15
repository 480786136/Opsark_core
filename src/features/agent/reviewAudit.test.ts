import { describe, expect, it } from "vitest";
import {
  buildCommandFailureReviewAudit,
  buildEvidenceReviewAudits,
  buildPeriodicReviewAudit,
  buildPreconditionReviewAudit,
} from "@/features/agent/reviewAudit";
import type { StepReview } from "@/types";

const scope = { stepTitle: "部署服务", serverId: "server-1", taskId: "task-1" };
const modelContinue: StepReview = {
  decision: "continue",
  reason: "continue",
  summary: "continue",
  source: "model",
};
const ruleAdjust: StepReview = {
  decision: "adjust",
  reason: "blocked",
  summary: "blocked",
  source: "rules",
};

describe("review audit", () => {
  it("records model and final decisions for precondition review", () => {
    const event = buildPreconditionReviewAudit({
      ...scope,
      allowed: false,
      context: { policy: "precondition" },
      modelDecision: modelContinue,
      finalDecision: ruleAdjust,
    });

    expect(event).toMatchObject({ category: "model", level: "warning" });
    expect(JSON.parse(event.detail)).toMatchObject({
      modelDecision: { decision: "continue" },
      finalDecision: { decision: "adjust" },
    });
  });

  it("records whether a periodic review decision was accepted", () => {
    const event = buildPeriodicReviewAudit({
      ...scope,
      round: 2,
      context: {},
      modelDecision: modelContinue,
      acceptedDecision: true,
    });

    expect(event.title).toContain("#2");
    expect(JSON.parse(event.detail).acceptedDecision).toBe(true);
  });

  it("records failure recovery gates and the final decision", () => {
    const event = buildCommandFailureReviewAudit({
      ...scope,
      context: {},
      modelDecision: modelContinue,
      finalDecision: ruleAdjust,
      diagnosticStep: false,
      mutatingStep: true,
      recoveryStepFound: false,
    });

    expect(event.level).toBe("warning");
    expect(JSON.parse(event.detail)).toMatchObject({
      mutatingStep: true,
      recoveryStepFound: false,
      finalDecision: { source: "rules" },
    });
  });

  it("emits model, postcondition and blocking-gate events in order", () => {
    const events = buildEvidenceReviewAudits({
      ...scope,
      reviewRequired: true,
      postconditionReview: true,
      context: {},
      modelDecision: modelContinue,
      finalDecision: ruleAdjust,
      validationExitCode: 127,
      hardBlocker: "validator missing",
      mutatingStep: true,
      repairStepFound: false,
      blockingSignalResolved: false,
      blockingFacts: { blockingSignal: true },
    });

    expect(events.map((event) => event.category)).toEqual(["model", "system", "system"]);
    expect(events.map((event) => event.title)).toEqual([
      "部署服务 · 后置校验失败异常复核",
      "部署服务 · 后置校验最终决策",
      "部署服务 · 前置条件门禁",
    ]);
  });

  it("emits one deterministic event when model review is unnecessary", () => {
    const events = buildEvidenceReviewAudits({
      ...scope,
      reviewRequired: false,
      postconditionReview: false,
      finalDecision: { ...modelContinue, source: "rules" },
      result: {
        executionStatus: "success",
        observationStatus: "matched",
        facts: {},
        warnings: [],
        evidenceIds: [],
      },
      mutatingStep: false,
      repairStepFound: false,
      blockingFacts: {},
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: "system", level: "info" });
    expect(JSON.parse(events[0].detail).modelReviewSkipped).toBe(true);
  });
});

