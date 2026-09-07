import { describe, expect, it } from "vitest";
import { buildPlanNormalizationRepair } from "@/services/backend";
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
