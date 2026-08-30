import { describe, expect, it } from "vitest";
import type { PlanStep } from "@/types";
import { classifyChangeOperations, semanticRiskForCommand, validateAuthorizedChangeOperations } from "./changeOperation";

const step = (command: string): PlanStep => ({
  id: "change-1", kind: "change", title: "change", description: "change", command,
  expected: "changed", validation: "true", risk: "low", status: "pending",
});

describe("semantic change operations", () => {
  it("does not treat package removal as a low-risk keyword accident", () => {
    expect(classifyChangeOperations("dnf remove nodejs npm")).toContain("package_remove");
    expect(semanticRiskForCommand("dnf remove nodejs npm")).toBe("high");
    expect(semanticRiskForCommand("systemctl disable app")).toBe("medium");
  });

  it("prevents an install goal from silently uninstalling the existing runtime", () => {
    expect(() => validateAuthorizedChangeOperations(
      [step("dnf remove nodejs npm")],
      "安装 nvm 进行 Node 版本管理",
    )).toThrow("扩大了用户授权范围");
    expect(() => validateAuthorizedChangeOperations(
      [step("dnf remove nodejs npm")],
      "卸载系统 Node 并改用 nvm",
    )).not.toThrow();
  });
});
