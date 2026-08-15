import { describe, expect, it } from "vitest";
import { requiresStepApproval } from "@/features/agent/approvalPolicy";
import type { PlanStep } from "@/types";

const step = (risk: PlanStep["risk"], command = "uname -a"): PlanStep => ({
  id: "step",
  title: "测试",
  description: "测试审批",
  command,
  risk,
  expected: "成功",
  validation: "true",
  status: "pending",
});

describe("approval policy", () => {
  it("applies permission levels consistently", () => {
    expect(requiresStepApproval("observe", step("low"))).toBe(true);
    expect(requiresStepApproval("safe", step("low"))).toBe(false);
    expect(requiresStepApproval("safe", step("medium"))).toBe(true);
    expect(requiresStepApproval("autonomous", step("medium"))).toBe(false);
    expect(requiresStepApproval("managed", step("medium"))).toBe(false);
  });

  it("always requires approval for high-risk or destructive commands", () => {
    expect(requiresStepApproval("autonomous", step("high"))).toBe(true);
    expect(requiresStepApproval("managed", step("low", "rm -rf /tmp/example"))).toBe(true);
  });
});
