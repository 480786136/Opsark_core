import { describe, expect, it } from "vitest";
import {
  isReadOnlyDiagnosticStep,
  postconditionHasHardBlocker,
  remainingPlanCanRepairPostcondition,
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
  it("uses the typed step effect before legacy text inference", () => {
    expect(isReadOnlyDiagnosticStep(step({ kind: "observe", title: "collect snapshot", description: "read current facts" }))).toBe(true);
    expect(isReadOnlyDiagnosticStep(step({ kind: "change", command: "systemctl restart app" }))).toBe(false);
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
        observationStatus: "unknown",
        facts: { validationProtocolIncomplete: true },
        warnings: [],
        evidenceIds: [],
      },
    }), [])).toContain("不能将该步骤判定为成功");
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
