import { describe, expect, it, vi } from "vitest";
import {
  runDiscoveryRefinement,
  runTaskCompletion,
} from "@/features/agent/taskAdvancement";
import type { ModelProfile, OpsTask, PlanStep } from "@/types";
import { buildPlanNormalizationRepair, PlanProtocolError } from "@/services/backend";

const model: ModelProfile = {
  id: "model-1",
  name: "Model",
  provider: "Remote",
  model: "model-v1",
  endpoint: "https://model.test",
  enabled: true,
  hasApiKey: true,
};

function step(id: string, status: PlanStep["status"] = "completed"): PlanStep {
  return {
    id,
    title: id,
    description: id,
    command: "pwd",
    risk: "low",
    expected: "success",
    validation: "true",
    status,
  };
}

function task(permission: OpsTask["permission"] = "safe"): OpsTask {
  return {
    id: "task-1",
    serverId: "server-1",
    title: "Deploy",
    status: "planning",
    permission,
    modelId: model.id,
    messages: [],
    plan: [step("inspect")],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function discoveryInput(currentTask: OpsTask) {
  return {
    task: currentTask,
    requirement: "Deploy",
    metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 0, networkOut: 0, sampledAt: "now" },
    tools: [],
    secretMetadata: [],
    model,
    apiKey: "api-key",
    generationSettings: {
      limitOutput: false,
      maxPlanSteps: 6,
      maxOutputTokens: 5000,
      maxTextChars: 200,
      maxCommandChars: 4000,
    },
    isCancelled: () => false,
    onStart: vi.fn(),
  };
}

describe("task advancement", () => {
  it("preserves typed protocol failures across discovery continuation", async () => {
    const currentTask = task();
    const repair = buildPlanNormalizationRepair(new Error("工具参数无效"), [step("input", "pending")]);
    const error = new PlanProtocolError(repair, "不得改写业务");
    const planner = vi.fn().mockRejectedValue(error);
    const result = await runDiscoveryRefinement(discoveryInput(currentTask), planner);
    expect(result).toMatchObject({ kind: "failed", protocolError: error });
    if (result.kind !== "failed") throw new Error("expected a failed refinement");
    expect(result.pauseReason).toContain("正在根据已有结果完善后续方案");
    expect(result.pauseReason).not.toContain("PlanProtocolError");
    expect(result.pauseReason).not.toContain("不得改写业务");
    expect(result.technicalDetail).toContain("不得改写业务");
    expect(planner).toHaveBeenCalledOnce();
  });
  it("returns a continuation and automatic approval for managed tasks", async () => {
    const currentTask = task("managed");
    const pending = step("deploy", "pending");
    const result = await runDiscoveryRefinement(
      discoveryInput(currentTask),
      vi.fn().mockResolvedValue([pending]),
    );

    expect(result).toMatchObject({
      kind: "success",
      pending: [pending],
      autoApprove: true,
    });
    if (result.kind === "success") {
      expect(result.eventMessage).toContain("完全托管模式自动批准");
    }
  });

  it("fails discovery refinement before planning when the model is unavailable", async () => {
    const planner = vi.fn();
    const input = { ...discoveryInput(task()), apiKey: undefined };
    const result = await runDiscoveryRefinement(
      input,
      planner,
    );

    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.pauseReason).toContain("已确认输入和真实证据");
      expect(result.pauseReason).not.toContain("后续变更计划");
    }
    expect(planner).not.toHaveBeenCalled();
    expect(input.onStart).not.toHaveBeenCalled();
  });

  it("returns a stable failure without mutating the task", async () => {
    const currentTask = task();
    const result = await runDiscoveryRefinement(
      discoveryInput(currentTask),
      vi.fn().mockRejectedValue(new Error("invalid plan")),
    );

    expect(result).toMatchObject({
      kind: "failed",
      pauseReason: "当前检查结果已保留，但暂时无法形成可执行的后续方案。可以稍后重试生成。",
    });
    if (result.kind !== "failed") throw new Error("expected a failed refinement");
    expect(result.technicalDetail).toContain("invalid plan");
    expect(currentTask.plan).toHaveLength(1);
  });

  it("discards a continuation completed after cancellation", async () => {
    const result = await runDiscoveryRefinement(
      { ...discoveryInput(task()), isCancelled: () => true },
      vi.fn().mockResolvedValue([step("deploy", "pending")]),
    );

    expect(result).toEqual({ kind: "cancelled" });
  });

  it("builds completion request, model success and task success audits", async () => {
    const currentTask = task();
    const result = await runTaskCompletion({
      task: currentTask,
      model,
      apiKey: "api-key",
      serverId: currentTask.serverId,
      taskId: currentTask.id,
      isCancelled: () => false,
    }, vi.fn().mockImplementation(async (input) => {
      input.onModelRequest?.({ requirement: "Deploy", results: [] });
      return { summary: "Completed", requirement: "Deploy", usedModel: true };
    }));

    expect(result.cancelled).toBe(false);
    expect(result.audits.map((event) => event.title)).toEqual([
      "提交执行结果总结请求",
      "模型执行总结已返回",
      "智能运维任务完成",
    ]);
  });

  it("does not produce completion-success audits after cancellation", async () => {
    const currentTask = task();
    const result = await runTaskCompletion({
      task: currentTask,
      serverId: currentTask.serverId,
      taskId: currentTask.id,
      isCancelled: () => true,
    }, vi.fn().mockResolvedValue({
      summary: "Completed",
      requirement: "Deploy",
      usedModel: false,
    }));

    expect(result.cancelled).toBe(true);
    expect(result.audits).toEqual([]);
  });
});
