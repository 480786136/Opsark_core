import { describe, expect, it } from "vitest";
import { executionContextEvidence, modelContextStep, modelToolOutput } from "./executionContextEvidence";
import type { PlanStep } from "@/types";

describe("execution evidence in model context", () => {
  it("does not bypass scoped decisions through historical form output", () => {
    const step = { id: "form-1", output: '{"values":{"TARGET":"old-server-value"}}',
      result: { facts: { toolId: "user.request_input", values: { TARGET: "legacy-fact-value" } } },
      evidence: [{ id: "form-evidence", rawOutput: '{"values":{"TARGET":"old-server-value"}}', facts: { TARGET: "legacy-fact-value" } }],
    } as unknown as PlanStep;
    const projected = executionContextEvidence(step, value => value);
    expect(projected.output).toMatchObject({ contentRef: "confirmedUserInputs", sourceStepId: "form-1" });
    expect(JSON.stringify(projected)).not.toContain("old-server-value");
    expect(JSON.stringify(projected)).not.toContain("legacy-fact-value");
    expect(JSON.stringify(modelContextStep(step))).not.toContain("legacy-fact-value");
    expect(step.output).toContain("old-server-value");
  });

  it("reconstructs every shared fact and output without modifying the original ledger", () => {
    const output = "完整结果\n".repeat(1000);
    const step = {
      output,
      result: { facts: { count: 2, rows: [{ value: "raw" }], validationPassed: true } },
      evidence: [{ id: "main", source: "main", type: "command-output", collectedAt: "now",
        facts: { count: 2, rows: [{ value: "raw" }], unique: false }, rawOutput: output },
      { id: "validation", source: "validation", type: "command-output", collectedAt: "later",
        facts: { count: 3 }, rawOutput: "DIFFERENT VALIDATION OUTPUT" }],
    } as unknown as PlanStep;
    const original = JSON.stringify(step);
    const projected = executionContextEvidence(step, value => value);
    const restored = projected.evidence!.map(item => ({
      ...item,
      facts: { ...Object.fromEntries((item.factsFromResult ?? []).map(key => [key, step.result!.facts[key]])), ...item.facts },
      rawOutput: item.rawOutputRef ? projected.output : item.rawOutput,
    }));
    for (let i = 0; i < restored.length; i++) {
      expect(restored[i].facts).toEqual(step.evidence![i].facts);
      expect(restored[i].rawOutput).toEqual(step.evidence![i].rawOutput);
      expect(restored[i].id).toEqual(step.evidence![i].id);
    }
    expect(JSON.stringify(projected).length).toBeLessThan(original.length);
    expect(JSON.stringify(step)).toBe(original);
  });

  it("keeps complete tool JSON as data, including the end of large contents", () => {
    const data = { path: "/opt/app/README.md", content: "x".repeat(5000) + "FINAL ACCEPTANCE", truncated: false };
    const step = { result: { facts: { toolId: "files.read_content" } } } as unknown as PlanStep;
    expect(modelToolOutput(step, JSON.stringify(data, null, 2))).toEqual(data);
    expect(modelToolOutput(step, "legacy text")).toBe("legacy text");
    expect(modelToolOutput({} as PlanStep, JSON.stringify(data))).toBe(JSON.stringify(data));
  });
});
