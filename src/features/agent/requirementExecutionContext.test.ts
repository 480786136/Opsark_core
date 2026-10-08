import { describe, expect, it } from "vitest";
import type { OpsTask } from "@/types";
import { requirementExecutionContext } from "./requirementExecutionContext";

const task = (): OpsTask => ({ id: "task", serverId: "server", modelId: "model", title: "部署应用", permission: "safe",
  status: "completed", messages: [], createdAt: "", updatedAt: "", plan: [] });

describe("previous execution reference for requirement classification", () => {
  it("bounds old commands, facts and output while retaining failure identities and local originals", () => {
    const current = task();
    current.plan = Array.from({ length: 40 }, (_, index) => {
      const output = `step-${index}\n${"detail".repeat(4000)}`;
      return { id: `s${index}`, title: "检查", description: "检查", command: "echo report", expected: "取得结果", validation: "",
        status: index === 0 ? "failed" as const : "completed" as const, risk: "low" as const, output,
        result: { executionStatus: "success" as const, observationStatus: "matched" as const, facts: { output }, warnings: [], evidenceIds: [`e${index}`] },
        evidence: [{ id: `e${index}`, type: "command-output" as const, source: "main" as const, facts: { output }, rawOutput: output, collectedAt: "2026-09-29T00:00:00Z" }] };
    });
    const original = structuredClone(current);
    const context = requirementExecutionContext(current, "原始需求".repeat(3000));
    expect(context.totalSteps).toBe(40);
    expect(context.omittedSteps).toBeGreaterThan(0);
    expect(context.steps.some(step => step.stepId === "s0")).toBe(true);
    expect(context.steps[context.steps.length - 1]?.stepId).toBe("s39");
    expect(JSON.stringify(context).length).toBeLessThan(50_000);
    expect(context.instruction).toContain("不表示尚未检查");
    expect(current).toEqual(original);
  });

  it("keeps small real results and does not reveal historical form values", () => {
    const current = task();
    current.plan = [{ id: "form", title: "目标", description: "选择目标", command: "", expected: "回答", validation: "",
      action: { type: "tool", toolId: "user.request_input", arguments: {} }, status: "completed", risk: "low",
      output: "SECRET_OLD_VALUE", result: { executionStatus: "success", observationStatus: "matched", warnings: [],
        evidenceIds: ["input"], facts: { toolId: "user.request_input", value: "SECRET_OLD_VALUE" } } }];
    const context = requirementExecutionContext(current, "原始要求");
    expect(JSON.stringify(context)).not.toContain("SECRET_OLD_VALUE");
    expect(context.steps[0].result).toMatchObject({ executionStatus: "success", evidenceIds: ["input"] });
    expect(context.steps[0].output).toMatchObject({ contentState: "omitted" });
  });
});
