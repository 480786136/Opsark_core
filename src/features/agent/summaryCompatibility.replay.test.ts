import { describe, expect, it } from "vitest";
import candidates from "../../../tests/fixtures/windows-summary-continue-20261028.json";
import type { PlanStep } from "@/types";
import { normalizePlanPreconditions } from "./planNormalizer";
import { analyzePlanStepSafety } from "./planSafety";

// Real rejected proposals only; no connection, model call or command execution.
function steps(value: { steps: unknown[] }): PlanStep[] {
  return value.steps.map((step, index) => {
    const row = step as Omit<PlanStep, "id" | "status" | "command">;
    return { ...row, id: `offline-proposal-${index}`, status: "pending",
      command: row.action?.type === "shell" ? row.action.command : "" };
  });
}

describe("Windows 双需求日志候选离线回放", () => {
  it("原候选摘要合法仍因管道丢失退出码被拒绝，不执行或重写验收命令", () => {
    const source = steps(candidates.initial);
    const before = structuredClone(source);
    expect(candidates.initial.summary.trim()).not.toBe("");
    expect(analyzePlanStepSafety(source[0].command, source[0].validation)).toMatchObject({
      safe: false, issue: { ruleId: "PIPELINE_STATUS_LOST", field: "validation" },
    });
    const normalized = normalizePlanPreconditions(source);
    expect(normalized[0].validation).toBe(source[0].validation);
    expect(analyzePlanStepSafety(normalized[0].command, normalized[0].validation).safe).toBe(false);
    expect(source).toEqual(before);
  });

  it("重生成候选没有摘要但已修正管道问题，继续保持全部计划安全校验", () => {
    expect(candidates.regenerated).not.toHaveProperty("summary");
    const source = steps(candidates.regenerated);
    const before = structuredClone(source);
    const normalized = normalizePlanPreconditions(source);
    expect(normalized).toHaveLength(2);
    expect(normalized[0].action).toEqual(source[0].action);
    expect(normalized[1].action).toMatchObject(source[1].action!);
    expect(normalized.map(step => step.validation)).toEqual(source.map(step => step.validation));
    expect(source).toEqual(before);
    expect(normalized.every(step => step.status === "pending")).toBe(true);
    expect(normalized.every(step => !step.approvalGrant)).toBe(true);
    expect(analyzePlanStepSafety(normalized[0].command, normalized[0].validation).safe).toBe(true);
  });
});
