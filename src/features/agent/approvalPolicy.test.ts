import { describe, expect, it } from "vitest";
import { normalizePermissionLevel, requiresStepApproval } from "@/features/agent/approvalPolicy";
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
    expect(requiresStepApproval("managed", step("medium"))).toBe(false);
  });

  it("always requires approval for high-risk or destructive commands", () => {
    expect(requiresStepApproval("managed", step("high"))).toBe(true);
    expect(requiresStepApproval("managed", step("low", "rm -rf /tmp/example"))).toBe(true);
  });

  it.each(["observe", "safe", "managed"] as const)("requires concrete-action reapproval in %s without inflating risk", permission => {
    const pending = { ...step("low", "mkdir -p /var/backups/app"),
      protocolReplanApproval: { inputFingerprint: "confirmed-1", decisionSummary: "不授权系统变更" } };
    expect(requiresStepApproval(permission, pending)).toBe(true);
    expect(pending.risk).toBe("low");
  });

  it("migrates the removed automatic mode to safe mode", () => {
    expect(normalizePermissionLevel("autonomous")).toBe("safe");
    expect(normalizePermissionLevel("managed")).toBe("managed");
  });
});
