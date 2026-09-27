import { describe, expect, it } from "vitest";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import type { PlanStep, ServerProfile } from "@/types";
import { preparePlanForApproval, type PlanPreparationContext } from "./planPreparation";
import {
  acceptPreparedPlanApproval, acceptStepApproval, authorizePreparedPlan, hasCurrentPlanApproval,
  hasCurrentStepApproval, requestStepApproval, stepMatchesExecutionIntent,
} from "./stepApproval";
import { resolveStepDispatch } from "./executionDispatch";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const server = { id: "server-a", name: "Source", host: "192.0.2.10", port: 22, username: "deploy" } as ServerProfile;
const context = (): PlanPreparationContext => ({ taskId: "task-approval", permission: "safe", server,
  servers: [server], connectionGeneration: 3 });
const toolStep = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  id: "read-tree", title: "检查目录", description: "读取目录结构", kind: "observe", risk: "low",
  action: { type: "tool", toolId: "files.get_structure", arguments: { rootPath: "/opt/app" } },
  command: "", validation: "", expected: "获得当前目录结构", status: "pending", ...overrides,
});

function prepared(overrides: Partial<PlanStep> = {}) {
  return preparePlanForApproval([toolStep(overrides)], context(), defaultToolCatalog);
}

describe("prepared plan / approval / dispatch contract", () => {
  it("authorizes a prepared read through existing policy and dispatches its exact final arguments", () => {
    const plan = prepared();
    const step = clone(plan.compatibilitySteps[0]!);
    const grant = authorizePreparedPlan(plan, defaultToolCatalog);
    expect(grant?.source).toBe("policy");
    expect(hasCurrentPlanApproval(plan, grant)).toBe(true);
    expect(stepMatchesExecutionIntent(step)).toBe(true);
    expect(requestStepApproval("safe", step, defaultToolCatalog)).toBeUndefined();
    expect(resolveStepDispatch(step, [], "call-read", defaultToolCatalog)).toEqual({
      kind: "tool", call: { id: "call-read", toolId: "files.get_structure", arguments: step.action!.type === "tool" ? step.action!.arguments : {} },
    });
  });

  it("uses the same prepared intent for user step approval", () => {
    const plan = prepared({ risk: "high" });
    const step = clone(plan.compatibilitySteps[0]!);
    expect(authorizePreparedPlan(plan, defaultToolCatalog)).toBeUndefined();
    requestStepApproval("safe", step, defaultToolCatalog);
    expect(acceptStepApproval(step, plan)?.shouldExecute).toBe(true);
    expect(hasCurrentStepApproval(step)).toBe(true);
    expect(step.approvalGrant).toMatchObject({ scope: "step", source: "user", taskId: plan.taskId,
      executionDigest: plan.steps[0]!.intent.digest, planRevision: plan.planRevision, stepRevision: plan.steps[0]!.stepRevision });
  });

  it("cannot approve edited arguments while the prompt is waiting, even if the fields remain valid", () => {
    const plan = prepared({ risk: "high" });
    const step = clone(plan.compatibilitySteps[0]!);
    requestStepApproval("safe", step);
    if (step.action?.type === "tool") step.action.arguments.rootPath = "/etc";
    expect(acceptStepApproval(step, plan)).toBeUndefined();
    expect(resolveStepDispatch(step, [], "edited", defaultToolCatalog)).toMatchObject({ kind: "invalid" });
  });

  it("does not carry approval over changes to expected results or dependency structure", () => {
    const first = prepared({ risk: "high" });
    const next = preparePlanForApproval([{ ...toolStep({ risk: "high" }), expected: "other acceptance",
      retryAfterStepId: "previous" }], { ...context(), previous: first }, defaultToolCatalog);
    expect(acceptPreparedPlanApproval(first, next)).toBeUndefined();
    expect(next.planRevision).toBe(first.planRevision + 1);
  });

  it.each(["permission", "target", "connection"] as const)("rejects an old plan approval after %s changes", field => {
    const first = prepared();
    const nextContext = { ...context(), previous: first };
    if (field === "permission") nextContext.permission = "observe";
    if (field === "target") {
      nextContext.server = { ...server, host: "192.0.2.11" };
      nextContext.servers = [nextContext.server];
    }
    if (field === "connection") nextContext.connectionGeneration = 4;
    const next = preparePlanForApproval(first.compatibilitySteps, nextContext, defaultToolCatalog);
    expect(acceptPreparedPlanApproval(first, next)).toBeUndefined();
    expect(hasCurrentPlanApproval(next, acceptPreparedPlanApproval(first, first))).toBe(false);
  });

  it("retains authorization across display-only and catalog-documentation changes", () => {
    const first = prepared();
    const edited = clone(first.compatibilitySteps);
    edited[0]!.title = "新的名称";
    edited[0]!.description = "新的说明";
    const tools = defaultToolCatalog.map(tool => ({ ...tool, description: "发布说明更新", configurationVersion: 99 }));
    const next = preparePlanForApproval(edited, { ...context(), previous: first }, tools);
    expect(next.executionDigest).toBe(first.executionDigest);
    expect(next.displayDigest).not.toBe(first.displayDigest);
    expect(acceptPreparedPlanApproval(first, next)?.source).toBe("user");
    expect(resolveStepDispatch(clone(next.compatibilitySteps[0]!), [], "description", tools).kind).toBe("tool");
  });

  it("blocks a newly disabled tool immediately", () => {
    const plan = prepared();
    const disabled = defaultToolCatalog.map(tool => tool.id === "files.get_structure" ? { ...tool, enabled: false } : tool);
    expect(resolveStepDispatch(clone(plan.compatibilitySteps[0]!), [], "disabled", disabled))
      .toMatchObject({ kind: "invalid", error: expect.stringContaining("禁用") });
    expect(authorizePreparedPlan(plan, disabled)).toBeUndefined();
  });

  it("rejects changed effective defaults rather than re-applying them under an old approval", () => {
    const plan = prepared();
    const changed = clone(defaultToolCatalog);
    const schema = changed.find(tool => tool.id === "files.get_structure")!.inputSchema;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    properties.maxDepth!.default = 2;
    const step = clone(plan.compatibilitySteps[0]!);
    const before = clone(step.action);
    expect(resolveStepDispatch(step, [], "new-default", changed))
      .toMatchObject({ kind: "invalid", error: expect.stringContaining("契约已变化") });
    expect(step.action).toEqual(before);
  });

  it("does not fill removed prepared defaults during dispatch", () => {
    const plan = prepared();
    const step = clone(plan.compatibilitySteps[0]!);
    if (step.action?.type === "tool") delete step.action.arguments.maxDepth;
    expect(resolveStepDispatch(step, [], "missing-default", defaultToolCatalog).kind).toBe("invalid");
    expect(step.action?.type === "tool" && step.action.arguments.maxDepth).toBeUndefined();
  });

  it("rejects altered digests and mismatched plan membership", () => {
    const plan = prepared({ risk: "high" });
    const corrupt = clone(plan);
    (corrupt as { executionDigest: string }).executionDigest = "sha256:edited";
    expect(acceptPreparedPlanApproval(corrupt, corrupt)).toBeUndefined();
    const step = clone(plan.compatibilitySteps[0]!);
    requestStepApproval("safe", step);
    const other = preparePlanForApproval([toolStep({ id: "different" })], context());
    expect(acceptStepApproval(step, other)).toBeUndefined();
  });

  it("binds shell acceptance behavior as well as the command", () => {
    const proposal: PlanStep = { id: "verify", kind: "observe", title: "验证", description: "验证",
      command: "test -d /opt/app", action: { type: "shell", command: "test -d /opt/app" },
      risk: "high", expected: "目录存在", validation: "test -d /opt/app", status: "pending" };
    const plan = preparePlanForApproval([proposal], context());
    const step = clone(plan.compatibilitySteps[0]!);
    requestStepApproval("safe", step);
    acceptStepApproval(step, plan);
    expect(hasCurrentStepApproval(step)).toBe(true);
    step.expected = "不要求目录存在";
    expect(hasCurrentStepApproval(step)).toBe(false);
    expect(resolveStepDispatch(step, [], "changed-acceptance").kind).toBe("invalid");
  });
});
