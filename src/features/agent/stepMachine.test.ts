import { describe, expect, it } from "vitest";
import { canTransitionStep, transitionStep } from "@/features/agent/stepMachine";
import type { PlanStep } from "@/types";

function createStep(status: PlanStep["status"]): PlanStep {
  return {
    id: "step-1",
    title: "检查目录",
    description: "获取部署目录信息",
    command: "ls -la",
    risk: "low",
    expected: "返回目录内容",
    validation: "test -d .",
    status,
  };
}

describe("step machine", () => {
  it("allows execution lifecycle transitions", () => {
    expect(canTransitionStep("pending", "awaiting_approval")).toBe(true);
    expect(canTransitionStep("awaiting_approval", "running")).toBe(true);
    expect(canTransitionStep("awaiting_approval", "awaiting_input")).toBe(true);
    expect(canTransitionStep("running", "validating")).toBe(true);
    expect(canTransitionStep("validating", "completed")).toBe(true);
    expect(canTransitionStep("awaiting_input", "pending")).toBe(true);
  });

  it("allows active steps to be stopped or failed", () => {
    expect(canTransitionStep("pending", "skipped")).toBe(true);
    expect(canTransitionStep("running", "failed")).toBe(true);
    expect(canTransitionStep("validating", "skipped")).toBe(true);
  });

  it("rejects transitions out of terminal states", () => {
    expect(canTransitionStep("completed", "running")).toBe(false);
    expect(() => transitionStep(createStep("failed"), "pending"))
      .toThrow("非法步骤状态迁移");
  });

  it("updates the step status", () => {
    const step = createStep("pending");
    transitionStep(step, "running");
    expect(step.status).toBe("running");
  });
});
