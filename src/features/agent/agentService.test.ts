import { describe, expect, it, vi } from "vitest";
import {
  planDiscoveryContinuation,
  planTaskAdjustment,
  summarizeFailedTask,
  summarizeTaskExecution,
} from "@/features/agent/agentService";
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

const step = (id: string, command: string, status: PlanStep["status"] = "completed"): PlanStep => ({
  id,
  title: id,
  description: id,
  command,
  risk: "low",
  expected: "success",
  validation: "true",
  status,
});

const task = (): OpsTask => ({
  id: "task-1",
  serverId: "server-1",
  title: "Deploy",
  status: "running",
  permission: "safe",
  modelId: model.id,
  messages: [{
    id: "message-1",
    role: "user",
    kind: "message",
    content: "Deploy the application",
    createdAt: "2026-08-14T00:00:00.000Z",
  }],
  plan: [step("inspect", "pwd")],
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
});

const generationSettings = {
  limitOutput: false,
  maxPlanSteps: 6,
  maxOutputTokens: 5000,
  maxTextChars: 200,
  maxCommandChars: 4000,
};

describe("agentService", () => {
  it("builds discovery context and removes repeated continuation commands", async () => {
    const generatePlan = vi.fn().mockResolvedValue([
      step("duplicate", " pwd ", "pending"),
      step("deploy", "npm run deploy", "pending"),
    ]);
    const continuation = await planDiscoveryContinuation({
      task: task(),
      requirement: "Deploy the application",
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 0, networkOut: 0, sampledAt: "now" },
      tools: [],
      secretMetadata: [],
      model,
      apiKey: "secret-key",
      generationSettings,
    }, generatePlan);

    expect(continuation.map((item) => item.id)).toEqual(["deploy"]);
    expect(generatePlan).toHaveBeenCalledWith(
      expect.stringContaining("发现阶段已完成"),
      expect.objectContaining({ apiKey: "secret-key", context: expect.stringContaining("continue_after_discovery") }),
    );
  });

  it("rejects a continuation that contains no new executable command", async () => {
    await expect(planDiscoveryContinuation({
      task: task(),
      requirement: "Deploy",
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 0, networkOut: 0, sampledAt: "now" },
      tools: [],
      secretMetadata: [],
      model,
      apiKey: "secret-key",
      generationSettings,
    }, vi.fn().mockResolvedValue([step("duplicate", "pwd", "pending")]))).rejects.toThrow(
      "模型未返回可执行的后续步骤",
    );
  });

  it("generates an adjustment plan while retaining only recent completed evidence", async () => {
    const currentTask = task();
    currentTask.plan = [
      step("old-1", "echo 1"),
      step("old-2", "echo 2"),
      step("old-3", "echo 3"),
      step("old-4", "echo 4"),
      step("old-5", "echo 5"),
      step("failed", "npm run deploy", "failed"),
    ];
    const replacement = step("repair", "npm ci", "pending");
    const result = await planTaskAdjustment({
      task: currentTask,
      failedStep: currentTask.plan[5],
      metrics: { cpu: 1, memory: 2, disk: 3, networkIn: 0, networkOut: 0, sampledAt: "now" },
      tools: [],
      secretMetadata: [],
      model,
      apiKey: "secret-key",
      generationSettings,
    }, vi.fn().mockResolvedValue([replacement]));

    expect(result.plan.map((item) => item.id)).toEqual(["old-2", "old-3", "old-4", "old-5", "repair"]);
    expect(result.context).toMatchObject({ workflowPhase: "adjust_after_failure" });
  });

  it("generates a summary and reports the model audit snapshot", async () => {
    const onModelRequest = vi.fn();
    const generateSummary = vi.fn().mockResolvedValue("Completed");
    const result = await summarizeTaskExecution({
      task: task(),
      model,
      apiKey: "secret-key",
      onModelRequest,
    }, generateSummary);

    expect(result).toEqual({
      summary: "Completed",
      requirement: "Deploy the application",
      usedModel: true,
    });
    expect(onModelRequest).toHaveBeenCalledWith(expect.objectContaining({ requirement: "Deploy the application" }));
    expect(generateSummary).toHaveBeenCalledWith(
      "Deploy the application",
      expect.any(Array),
      expect.objectContaining({ apiKey: "secret-key" }),
    );
  });

  it("combines a deterministic failure reason with the generated summary", async () => {
    const result = await summarizeFailedTask({
      task: task(),
      reason: "retry limit reached",
      model,
      apiKey: "secret-key",
    }, vi.fn().mockResolvedValue("The deployment command failed."));

    expect(result.summary).toBe(
      "本轮任务未完成：retry limit reached\n\nThe deployment command failed.",
    );
    expect(result.usedModel).toBe(true);
  });

});
