import { describe, expect, it } from "vitest";
import { buildPlanNormalizationRepair, normalizePlanPreconditions } from "@/services/backend";
import type { PlanStep } from "@/types";

const malformedStep: PlanStep = {
  id: "request-git-credential",
  kind: "observe",
  title: "收集 Git 凭据",
  description: "仅在匿名探测证明需要认证后收集",
  command: "opsark-tool user.request_input {}",
  expected: "获得凭据引用",
  validation: "true",
  risk: "low",
  status: "pending",
};

describe("plan normalization repair feedback", () => {
  it("normalizes the logged database username mismatch before a model repair is needed", () => {
    const fields = [
      { key: "mysql_user", label: "数据库用户名", description: "目标实例账户", type: "text", required: true,
        credential: { group: "db", kind: "database", role: "username", target: "db.internal:3306" } },
      { key: "MYSQL_PASSWORD", label: "数据库密码", description: "目标实例密码", type: "password", required: true,
        credential: { group: "db", kind: "database", role: "secret", target: "db.internal:3306" } },
    ];
    const original = { ...malformedStep, command: `opsark-tool user.request_input ${JSON.stringify({ title: "数据库认证", fields })}` };
    const normalized = normalizePlanPreconditions([original], "检查当前mysql有哪些库")[0];
    const args = JSON.parse(normalized.command.slice("opsark-tool user.request_input ".length));
    expect(args.fields[0].type).toBe("password");
    expect(normalized.description).toBe(original.description);
    expect(normalized.kind).toBe(original.kind);
    expect(original.command).toContain('"type":"text"');
  });
  it("returns a field-local credential type error with the prior model output", () => {
    const repair = buildPlanNormalizationRepair(
      new Error("第 1 个计划步骤的工具参数无效：凭据参数 username 必须使用 password 类型"),
      [malformedStep],
    );

    expect(repair).toMatchObject({
      errorCode: "tool_schema_validation_failed",
      fieldPath: "steps[0].command.arguments.fields[key=username].type",
      expected: "password",
      previousModelOutput: [malformedStep],
    });
    expect(repair.instruction).toContain("只修复");
    expect(repair.instruction).toContain("业务目的");
  });
});
