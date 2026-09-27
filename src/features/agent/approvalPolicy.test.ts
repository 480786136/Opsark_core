import { describe, expect, it } from "vitest";
import { normalizePermissionLevel, requiresStepApproval } from "@/features/agent/approvalPolicy";
import type { PlanStep } from "@/types";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";

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

  it("uses the current effective tool effect rather than the static catalog", () => {
    const pending = { ...step("low", ""), kind: "change" as const,
      action: { type: "tool" as const, toolId: "files.get_structure", arguments: { rootPath: "/tmp" } } };
    const changed = defaultToolCatalog.map(tool => tool.id === "files.get_structure" ? { ...tool, effect: "change" as const } : tool);
    expect(requiresStepApproval("safe", pending)).toBe(false);
    expect(requiresStepApproval("safe", pending, changed)).toBe(true);
  });

  it("does not automatically authorize disabled, missing, or misdeclared tools", () => {
    const pending = { ...step("low", ""), kind: "observe" as const,
      action: { type: "tool" as const, toolId: "files.get_structure", arguments: { rootPath: "/tmp" } } };
    const disabled = defaultToolCatalog.map(tool => tool.id === "files.get_structure" ? { ...tool, enabled: false } : tool);
    const changed = defaultToolCatalog.map(tool => tool.id === "files.get_structure" ? { ...tool, effect: "change" as const } : tool);
    expect(requiresStepApproval("managed", pending, disabled)).toBe(true);
    expect(requiresStepApproval("managed", pending, [])).toBe(true);
    expect(requiresStepApproval("managed", pending, changed)).toBe(true);
  });
});
