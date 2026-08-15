import { describe, expect, it } from "vitest";
import {
  cancelStep,
  failToolCommandParsing,
  failUnexpectedStep,
  resumeStepAfterSecret,
  waitForStepSecret,
} from "@/features/agent/stepInterruption";
import type { PlanStep } from "@/types";

function createStep(status: PlanStep["status"]): PlanStep {
  return {
    id: "step-1",
    title: "部署应用",
    description: "执行部署",
    command: "deploy",
    risk: "high",
    expected: "部署完成",
    validation: "true",
    status,
  };
}

describe("step interruption", () => {
  it("keeps collected evidence references when cancelling", () => {
    const step = createStep("running");
    step.evidence = [{
      id: "evidence-1",
      type: "command-output",
      source: "main",
      facts: {},
      rawOutput: "partial",
      collectedAt: "2026-08-14T01:00:00.000Z",
    }];

    cancelStep(step, "用户终止");

    expect(step.status).toBe("skipped");
    expect(step.result).toMatchObject({
      executionStatus: "cancelled",
      evidenceIds: ["evidence-1"],
      failureReason: "用户终止",
    });
  });

  it("records tool parse failures with a stable category", () => {
    const step = createStep("pending");
    const outcome = failToolCommandParsing(step, new Error("参数必须是 JSON 对象"));

    expect(step.status).toBe("failed");
    expect(step.result).toMatchObject({
      executionStatus: "failed",
      facts: { commandCompleted: false, category: "tool_command_parse" },
    });
    expect(outcome.pauseReason).toContain("参数必须是 JSON 对象");
  });

  it("preserves evidence references for unexpected execution failures", () => {
    const step = createStep("validating");
    step.evidence = [{
      id: "evidence-2",
      type: "command-output",
      source: "main",
      facts: {},
      rawOutput: "partial",
      collectedAt: "2026-08-14T01:00:00.000Z",
    }];

    failUnexpectedStep(step, "validation unavailable");

    expect(step.status).toBe("failed");
    expect(step.result?.evidenceIds).toEqual(["evidence-2"]);
    expect(step.result?.facts.category).toBe("execution_exception");
  });

  it("supports approval followed by sensitive input and resume", () => {
    const step = createStep("awaiting_approval");

    waitForStepSecret(step, "DEPLOY_TOKEN");
    expect(step.status).toBe("awaiting_input");
    expect(step.progressMessage).toContain("DEPLOY_TOKEN");

    resumeStepAfterSecret(step);
    expect(step.status).toBe("pending");
  });
});

