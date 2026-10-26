import { describe, expect, it, vi } from "vitest";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import type { OpsTask, PlanStep } from "@/types";
import { prepareInitialTaskPlanWithRecovery, type PrepareInitialTaskPlanInput } from "./agentService";
import { assertObservationPlanProgress, ObservationPlanError } from "./observationPlanProgress";

function probe(id: string, name = "runtime"): PlanStep {
  return { id, title: id, description: "读取环境", command: "", validation: "", expected: "实际状态", kind: "observe",
    risk: "low", status: "pending", action: { type: "tool", toolId: "software.check", arguments: { names: [name] } } };
}

function setup() {
  const task: OpsTask = { id: "task", serverId: "server", currentRoundId: "round", title: "检查环境", rootGoal: "检查环境",
    status: "planning", permission: "safe", modelId: "model", messages: [], plan: [], createdAt: "now", updatedAt: "now" };
  const input: PrepareInitialTaskPlanInput = { task, requirement: "检查环境", classified: { intent: "execute", relation: "new_goal", plan: [probe("a"), probe("b")] },
    runtimeModel: { apiKey: "not-in-audit", model: "model", endpoint: "https://fixture.invalid",
      context: JSON.stringify({ permission: "safe", _modelRecovery: { operationId: "initial-operation", startedAtMs: 123, maxTotalTokens: 1000 } }) },
    skillDefinitions: [], tools: defaultToolCatalog, secretMetadata: [], onAttempt: vi.fn(), assertCurrent: vi.fn(),
    prepareCandidate: candidate => { assertObservationPlanProgress(task, candidate); task.plan = candidate; } };
  return input;
}

describe("bounded recovery of the initial observation plan", () => {
  it("retains the whole rejected proposal and uses the original operation budget once", async () => {
    const input = setup();
    const original = structuredClone(input.classified.plan);
    const generate = vi.fn().mockResolvedValue([probe("new", "different-runtime")]);
    await prepareInitialTaskPlanWithRecovery(input, generate);
    expect(generate).toHaveBeenCalledOnce();
    const context = JSON.parse(generate.mock.calls[0][1].context);
    expect(context._modelRecovery).toEqual(JSON.parse(input.runtimeModel.context)._modelRecovery);
    expect(context._modelOutputRecovery.strategy).toBe("regenerate");
    expect(context.outputRecovery.diagnostic).toMatchObject({ code: "OBSERVATION_PLAN_NO_PROGRESS", issues: [{ previousStepId: "a", stepId: "b" }] });
    expect(context.permission).toBe("safe");
    expect(input.classified.plan).toEqual(original);
    expect(input.task.permission).toBe("safe");
    expect(input.task.plan[0].id).toBe("new");
    expect(vi.mocked(input.onAttempt).mock.calls.map(([event]) => event.phase)).toEqual(["rejected", "request", "response"]);
    expect(vi.mocked(input.onAttempt).mock.calls[0][0].candidate).toEqual(original);
    expect(JSON.stringify(vi.mocked(input.onAttempt).mock.calls)).not.toContain("not-in-audit");
  });

  it("rejects a second duplicate atomically without a third candidate or silent deduplication", async () => {
    const input = setup(), generate = vi.fn().mockResolvedValue([probe("again-a"), probe("again-b")]);
    await expect(prepareInitialTaskPlanWithRecovery(input, generate)).rejects.toBeInstanceOf(ObservationPlanError);
    expect(generate).toHaveBeenCalledOnce();
    expect(input.task.plan).toEqual([]);
    expect(vi.mocked(input.onAttempt).mock.lastCall?.[0]).toMatchObject({ phase: "failed", attempt: 2,
      diagnostic: { issues: [{ stepId: "again-b" }] } });
  });

  it.each(["missing", "regenerate"])("does not mint a fresh budget when original recovery is %s", async mode => {
    const input = setup();
    input.runtimeModel.context = mode === "missing" ? "{}" : JSON.stringify({ ...JSON.parse(input.runtimeModel.context), _modelOutputRecovery: { strategy: "regenerate" } });
    const generate = vi.fn();
    await expect(prepareInitialTaskPlanWithRecovery(input, generate)).rejects.toBeInstanceOf(ObservationPlanError);
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(["permission", "requirement", "pending", "cancelled"])("discards regeneration when %s changes in flight", async boundary => {
    const input = setup();
    const generate = vi.fn().mockImplementation(async () => {
      if (boundary === "permission") input.task.permission = "observe";
      if (boundary === "requirement") input.task.currentInstruction = "读取另一份部署需求";
      if (boundary === "pending") input.task.pendingRequirements = [{ id: "p", content: "新增需求", baseRevision: 0, state: "pending", receivedAt: "now" }];
      if (boundary === "cancelled") input.task.cancelRequested = true;
      return [probe("new")];
    });
    await expect(prepareInitialTaskPlanWithRecovery(input, generate)).rejects.toThrow("过期结果");
    expect(generate).toHaveBeenCalledOnce();
    expect(input.task.plan).toEqual([]);
    expect(vi.mocked(input.onAttempt).mock.calls.map(([event]) => event.phase)).toEqual(["rejected", "request", "response", "failed"]);
  });

  it("does not convert a hard authorization rejection into another model call", async () => {
    const input = setup(), generate = vi.fn();
    input.prepareCandidate = () => { throw new Error("权限不允许此计划"); };
    await expect(prepareInitialTaskPlanWithRecovery(input, generate)).rejects.toThrow("权限不允许");
    expect(generate).not.toHaveBeenCalled();
    expect(input.onAttempt).not.toHaveBeenCalled();
  });
});
