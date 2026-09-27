import { describe, expect, it } from "vitest";
import { classifyStepResult, ensureStepValidator, normalizeStepValidation } from "./validation";
import { normalizePlanPreconditions } from "@/features/agent/planNormalizer";
import type { PlanStep } from "@/types";
const step: PlanStep = { id: "s", title: "检查 mysql 服务", description: "数据库端口与socket", command: "ss -lntp; ls /var/lib/mysql/mysql.sock", validation: "", kind: "observe", risk: "low", status: "pending", expected: "收集事实" };

describe("tool and Shell validation boundary", () => {
  const tool: PlanStep = { ...step, command: "", validation: "",
    action: { type: "tool", toolId: "server.resolve_connection", arguments: { host: "host.example" } } };

  it("preserves a valid tool through preparation and repeated plan normalization", () => {
    const original = structuredClone(tool);
    const prepared = normalizeStepValidation(original);
    expect(prepared).toEqual(tool);
    expect(prepared.validator).toBeUndefined();
    const normalized = normalizePlanPreconditions([prepared]);
    expect(normalizePlanPreconditions(normalized)).toEqual(normalized);
    expect(normalizeStepValidation(normalized[0])).toEqual(normalized[0]);
    expect(normalized[0].validator).toBeUndefined();
    expect(original).toEqual(tool);
  });

  it.each([
    { command: "id" }, { validation: "true" },
    { validator: { type: "command" as const, command: "", validStates: ["unknown" as const] } },
    { sessionContextChange: { cwd: "/tmp" } },
  ])("does not sanitize forbidden tool fields into an executable plan: %j", fields => {
    const invalid = { ...tool, ...fields };
    expect(normalizeStepValidation(invalid)).toEqual(invalid);
    expect(() => normalizePlanPreconditions([normalizeStepValidation(invalid)]))
      .toThrow("工具步骤不能夹带 Shell");
  });

  it("rejects tools at the Shell validator and result classification boundaries", () => {
    expect(() => ensureStepValidator(tool)).toThrow("工具步骤不能进入 Shell 验收流程");
    expect(() => classifyStepResult(tool, { success: true, exitCode: 0, output: "" },
      { passed: true, detail: "" })).toThrow("工具步骤不能进入 Shell 验收流程");
  });
});

describe("raw Shell evidence contract", () => {
  it("ignores prose, path keywords and legacy validators", () => {
    const s = ensureStepValidator({ ...step, validator: { type: "sql-query", command: "", validStates: ["matched"] } });
    expect(s.validator.type).toBe("command");
    const r = classifyStepResult(s, { success: true, exitCode: 0, output: "LISTEN 3306\n/run/mysql.sock\nmissing file" }, { passed: true, detail: "" });
    expect(r.result.facts).toMatchObject({ interpretation: "raw", lineCount: 3 });
    expect(r.result.facts).not.toHaveProperty("rowCount");
    expect(r.result.observationStatus).toBe("unknown");
    expect(r.needsModelReview).toBe(false);
    expect(r.accepted).toBe(true);
  });
  it("keeps main and validation evidence separate and does not invent a row-count comparison", () => {
    const r = classifyStepResult({ ...step, kind: "change", validation: "another-command" },
      { success: true, exitCode: 0, output: "a\nb\nc" }, { passed: true, exitCode: 0, detail: "ok", output: "7" });
    expect(r.evidence[0].facts.lineCount).toBe(3);
    expect(r.evidence[1].facts.observationFacts).toMatchObject({ lineCount: 1 });
    expect(r.evidence[0].rawOutput).toBe("a\nb\nc");
    expect(r.result.facts).not.toHaveProperty("count");
    expect(r.needsModelReview).toBe(true);
    expect(r.result.facts).toMatchObject({ semanticAcceptanceRequired: true, semanticAcceptanceStatus: "unknown" });
  });
  it("retains postcondition failures and raw empty output without claiming absence of a resource", () => {
    const r = classifyStepResult({ ...step, kind: "change", validation: "check" },
      { success: true, exitCode: 0, output: "" }, { passed: false, exitCode: 1, detail: "failed", output: "" });
    expect(r.accepted).toBe(false);
    expect(r.result.facts.evidenceConflict).toBe(true);
    expect(r.result.observationStatus).toBe("unknown");
  });
});
