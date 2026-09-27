import { describe, expect, it } from "vitest";
import type { PlanStep } from "@/types";
import { normalizePlanPreconditions } from "@/features/agent/planNormalizer";
import { parseToolAction } from "./toolExecutor";
import { ToolArgumentProtocolError, ToolArgumentValidationError } from "./toolArgumentProtocol";
import { assertPlanRepairScope, buildPlanNormalizationRepair } from "@/services/backend";

function step(toolId: string, args: unknown): PlanStep {
  return { id: "tool-step", kind: "observe", title: "查询确认", description: "当前目标的只读查询",
    command: "", action: { type: "tool" as const, toolId: toolId, arguments: JSON.parse(JSON.stringify(args)) }, expected: "取得目标信息", validation: "", risk: "low", status: "pending" };
}

function issueFor(plan: PlanStep[]) {
  try { normalizePlanPreconditions(plan); } catch (error) {
    expect(error).toBeInstanceOf(ToolArgumentProtocolError);
    return (error as ToolArgumentProtocolError).issue;
  }
  throw new Error("fixture should fail");
}

function request() {
  return { title: "选择目标", description: "选择已发现的目标", fields: [
    { key: "TARGET", label: "目标", description: "从真实目标中选择", type: "select", required: true,
      options: [{ value: "a", label: "目标 A" }, { value: "a", label: "目标 B" }] },
    { key: "COMMENT", label: "备注", description: "补充说明", type: "text", required: false },
  ] };
}

describe("tool argument protocol diagnostics", () => {
  it("reuses the schema path for an empty software names array at the actual plan index", () => {
    const valid = step("software.check", { names: ["git"] });
    const invalid = { ...step("software.check", { names: [], includeVersions: false }), id: "invalid" };
    const issue = issueFor([valid, invalid]);
    expect(issue).toMatchObject({ code: "TOOL_ARGUMENT_INVALID", stepIndex: 1, stepId: "invalid",
      fieldPath: "steps[1].action.arguments.names", allowedRepairPaths: ["steps[1].action.arguments.names"] });
    expect(issue.expected).toContain("至少 1 项");
  });

  it("pinpoints only the later duplicate candidate value, preserving other options and fields", () => {
    const issue = issueFor([step("user.request_input", request())]);
    expect(issue).toMatchObject({ code: "TOOL_ARGUMENT_INVALID",
      fieldPath: "steps[0].action.arguments.fields[0].options[1].value",
      allowedRepairPaths: ["steps[0].action.arguments.fields[0].options[1].value"] });
    expect(issue.expected).toContain("options.value 不能重复");
  });

  it("retains credential type and target restrictions as exact array-index paths", () => {
    const fields = [
      { key: "DB_USER", label: "账号", description: "登录账号", type: "password", required: true,
        credential: { group: "db", kind: "database", role: "username", target: "db.example.com:5432" } },
      { key: "DB_PASS", label: "密码", description: "登录密码", type: "text", required: true,
        credential: { group: "db", kind: "database", role: "secret", target: "db.example.com:5432" } },
    ];
    expect(issueFor([step("user.request_input", { title: "登录资料", fields })]).allowedRepairPaths)
      .toEqual(["steps[0].action.arguments.fields[1].type"]);
    fields[1].type = "password";
    fields[1].credential.target = "db.example.com";
    expect(issueFor([step("user.request_input", { title: "登录资料", fields })]).allowedRepairPaths)
      .toEqual(["steps[0].action.arguments.fields[1].credential.target"]);
  });

  it("records nested schema properties without deriving paths from natural language", () => {
    let failure: unknown;
    try { parseToolAction({ type: "tool" as const, toolId: "software.check", arguments: {"names":["git",3]} }, "call"); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ToolArgumentValidationError);
    expect((failure as ToolArgumentValidationError).argumentPath).toBe("names[1]");
    const fake = new ToolArgumentProtocolError(new Error("参数 names 无效 steps[0].action.arguments.names"), 0);
    expect(fake.issue.allowedRepairPaths).toEqual([]);
  });

  it("pinpoints only an extra property or missing required property", () => {
    expect(issueFor([step("software.check", { names: ["git"], unexplained: true })]).allowedRepairPaths)
      .toEqual(["steps[0].action.arguments.unexplained"]);
    expect(issueFor([step("software.check", {})]).allowedRepairPaths)
      .toEqual(["steps[0].action.arguments.names"]);
  });

  it("refuses an automatic field rewrite for malformed JSON or a cross-field contract conflict", () => {
    const malformed = { ...step("software.check", {}), action: { type: "tool", toolId: "software.check", arguments: [] } as any };
    expect(issueFor([malformed]).allowedRepairPaths).toEqual([]);
    const input = request();
    input.fields[0].options![1].value = "b";
    input.fields[1].key = "TARGET";
    expect(issueFor([step("user.request_input", input)]).allowedRepairPaths).toEqual([]);
  });

  it("allows only names when repairing an empty software list", () => {
    const original = step("software.check", { names: [], includeVersions: false });
    const issue = issueFor([original]);
    const repair = buildPlanNormalizationRepair({ issue }, [original]);
    expect(repair.errorCode).toBe("tool_schema_validation_failed");
    const valid = step("software.check", { names: ["git"], includeVersions: false });
    expect(() => assertPlanRepairScope(repair, [valid])).not.toThrow();
    const broadened = step("software.check", { names: ["git"], includeVersions: true });
    expect(() => assertPlanRepairScope(repair, [broadened])).toThrow();
  });

  it("cannot rewrite another candidate label or user field while fixing a duplicate value", () => {
    const input = request();
    const original = step("user.request_input", input);
    const repair = buildPlanNormalizationRepair({ issue: issueFor([original]) }, [original]);
    input.fields[0].options![1].value = "b";
    expect(() => assertPlanRepairScope(repair, [step("user.request_input", input)])).not.toThrow();
    input.fields[0].options![0].label = "未经确认的目标";
    expect(() => assertPlanRepairScope(repair, [step("user.request_input", input)])).toThrow();
    input.fields[0].options![0].label = "目标 A";
    input.fields[1].required = true;
    expect(() => assertPlanRepairScope(repair, [step("user.request_input", input)])).toThrow();
  });

  it("rejects missing structured action arguments", () => {
    expect(() => parseToolAction({ type: "tool", toolId: "software.check" } as any, "call")).toThrow();
  });
});
