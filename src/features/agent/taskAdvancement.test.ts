import { describe, expect, it, vi } from "vitest";
import {
  runDiscoveryRefinement,
  runTaskCompletion,
} from "@/features/agent/taskAdvancement";
import type { ModelProfile, OpsTask, PlanStep } from "@/types";

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
      pauseReason: "发现后续计划生成失败：Error: invalid plan",
    });
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
