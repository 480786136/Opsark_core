import { describe, expect, it } from "vitest";
import {
  isReadOnlyDiagnosticStep,
  postconditionHasHardBlocker,
  remainingPlanCanRepairPostcondition,
  requiresReadOnlyDiagnosis,
} from "@/features/agent/evidenceReview";
import type { PlanStep } from "@/types";

const step = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  id: "step-1",
  title: "检查服务状态",
  description: "只读查询",
  command: "systemctl status app",
  risk: "low",
  expected: "返回状态",
  validation: "true",
  status: "completed",
  ...overrides,
});

describe("evidence review policy", () => {
  it("separates diagnostic requests from requested changes", () => {
    expect(requiresReadOnlyDiagnosis("检查页面为什么空白")).toBe(true);
    expect(requiresReadOnlyDiagnosis("修复页面空白")).toBe(false);
    expect(isReadOnlyDiagnosticStep(step())).toBe(true);
  });

  it("detects whether remaining steps can repair a failed postcondition", () => {
    expect(remainingPlanCanRepairPostcondition([step({ title: "修复配置" })])).toBe(true);
    expect(remainingPlanCanRepairPostcondition([step({ title: "查看日志" })])).toBe(false);
  });

  it("keeps deterministic blockers above model review", () => {
    expect(postconditionHasHardBlocker(step(), [], 127)).toContain("不可执行");
    expect(postconditionHasHardBlocker(step({
      result: {
        executionStatus: "success",
        observationStatus: "unhealthy",
        facts: { platformIncompatible: true },
        warnings: [],
        evidenceIds: [],
      },
    }), [])).toContain("ABI");
  });
});
