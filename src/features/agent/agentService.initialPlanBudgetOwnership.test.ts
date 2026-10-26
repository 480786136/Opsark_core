import { describe, expect, it, vi } from "vitest";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import type { OpsTask, PlanStep } from "@/types";
import { prepareInitialTaskPlanWithRecovery, type PrepareInitialTaskPlanInput } from "./agentService";
import { assertObservationPlanProgress } from "./observationPlanProgress";

const probe = (id: string, name = "runtime"): PlanStep => ({ id, title: id, description: "读取环境", command: "",
  validation: "", expected: "实际状态", kind: "observe", risk: "low", status: "pending",
  action: { type: "tool", toolId: "software.check", arguments: { names: [name] } } });

function setup(): PrepareInitialTaskPlanInput {
  const task: OpsTask = { id: "current-task", serverId: "server", currentRoundId: "current-round", title: "检查环境",
    rootGoal: "检查环境", status: "planning", permission: "safe", modelId: "model", messages: [], plan: [], createdAt: "now", updatedAt: "now" };
  return { task, requirement: "检查环境", classified: { intent: "execute", relation: "new_goal", plan: [probe("a"), probe("b")] },
    runtimeModel: { apiKey: "fixture", model: "model", endpoint: "https://fixture.invalid",
      context: JSON.stringify({ _log: { taskId: task.id, roundId: task.currentRoundId },
        _taskModelBudget: { version: 1, taskId: task.id, roundId: task.currentRoundId },
        _modelRecovery: { operationId: "original-operation", startedAtMs: 123, maxTotalTokens: 1000 } }) },
    skillDefinitions: [], tools: defaultToolCatalog, secretMetadata: [], onAttempt: vi.fn(), assertCurrent: vi.fn(),
    prepareCandidate: candidate => { assertObservationPlanProgress(task, candidate); task.plan = candidate; } };
}

describe("initial plan recovery budget ownership after classification", () => {
  it.each(["_log", "baseSnapshot", "task", "_taskModelBudget"])(
    "rejects a stale task or round in %s before sending any automatic regeneration", async location => {
      for (const boundary of ["task", "round"]) {
        const input = setup();
        const context = JSON.parse(input.runtimeModel.context);
        const owner = { taskId: boundary === "task" ? "source-task" : input.task.id,
          roundId: boundary === "round" ? "source-round" : input.task.currentRoundId };
        context[location] = location === "baseSnapshot" || location === "task" ? { _log: owner }
          : location === "_taskModelBudget" ? { version: 1, ...owner } : owner;
        input.runtimeModel.context = JSON.stringify(context);
        const frozenContext = input.runtimeModel.context, original = structuredClone(input.classified.plan);
        const generate = vi.fn();
        await expect(prepareInitialTaskPlanWithRecovery(input, generate)).rejects.toThrow("已停止沿用旧模型请求自动重生成");
        expect(generate).not.toHaveBeenCalled();
        expect(input.task.plan).toEqual([]);
        expect(input.classified.plan).toEqual(original);
        expect(input.runtimeModel.context).toBe(frozenContext);
        expect(vi.mocked(input.onAttempt).mock.calls.map(([event]) => event.phase)).toEqual(["rejected"]);
      }
    });

  it("permits one recovery in the same task/round while preserving both budgets and operation identity", async () => {
    const input = setup(), original = JSON.parse(input.runtimeModel.context);
    const generate = vi.fn().mockResolvedValue([probe("repaired", "other-runtime")]);
    await prepareInitialTaskPlanWithRecovery(input, generate);
    expect(generate).toHaveBeenCalledOnce();
    const next = JSON.parse(generate.mock.calls[0][1].context);
    expect(next._log).toEqual(original._log);
    expect(next._taskModelBudget).toEqual(original._taskModelBudget);
    expect(next._modelRecovery).toEqual(original._modelRecovery);
    expect(next._modelOutputRecovery.strategy).toBe("regenerate");
    expect(input.task.plan.map(step => step.id)).toEqual(["repaired"]);
  });

  it("admits an already valid candidate locally after goal transfer without charging a new model request", async () => {
    const input = setup();
    const context = JSON.parse(input.runtimeModel.context);
    context._log.taskId = "source-task";
    context._taskModelBudget.taskId = "source-task";
    input.runtimeModel.context = JSON.stringify(context);
    input.classified.plan = [probe("already-valid")];
    const generate = vi.fn();
    await prepareInitialTaskPlanWithRecovery(input, generate);
    expect(input.task.plan.map(step => step.id)).toEqual(["already-valid"]);
    expect(generate).not.toHaveBeenCalled();
    expect(input.onAttempt).not.toHaveBeenCalled();
  });
});
