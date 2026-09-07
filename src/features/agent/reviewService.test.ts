import { describe, expect, it, vi } from "vitest";
import {
  reviewExecutionEvidence,
  reviewExecutionFailure,
  reviewPrecondition,
} from "@/features/agent/reviewService";
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

function createStep(
  id: string,
  command: string,
  status: PlanStep["status"] = "completed",
): PlanStep {
  return {
    id,
    title: id,
    description: id,
    command,
    risk: "low",
    expected: "success",
    validation: "true",
    status,
  };
}

function createTask(): OpsTask {
  return {
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
    plan: [createStep("inspect", "pwd")],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

describe("review service", () => {
  it("fails a precondition review closed when no model decision is available", async () => {
    const task = createTask();
    const blocker = task.plan[0];
    const deploy = createStep("deploy", "systemctl restart app", "pending");
    task.plan.push(deploy);
    const result = await reviewPrecondition({
      task,
      step: deploy,
      blockerStep: blocker,
      model,
      apiKey: "secret-key",
    }, vi.fn().mockResolvedValue({
      decision: "continue",
      reason: "fallback",
      summary: "fallback",
      source: "rules",
    }));

    expect(result.allowed).toBe(false);
    expect(result.finalDecision).toMatchObject({ decision: "adjust", source: "rules" });
    expect(result.context).toMatchObject({ reviewPolicy: { preconditionGate: true } });
  });

  it("does not let a model mark a failed mutating command complete", async () => {
    const task = createTask();
    const failed = createStep("deploy", "systemctl restart app", "failed");
    failed.result = {
      executionStatus: "failed",
      observationStatus: "unknown",
      facts: { category: "command_failed" },
      warnings: [],
      evidenceIds: [],
      failureReason: "command failed",
    };
    task.plan = [failed, createStep("修复服务", "systemctl start app", "pending")];
    const result = await reviewExecutionFailure({
      task,
      step: failed,
      failureReason: "command failed",
      failureCategory: "command_failed",
      model,
      apiKey: "secret-key",
    }, vi.fn().mockResolvedValue({
      decision: "complete",
      reason: "done",
      summary: "done",
      source: "model",
    }));

    expect(result.modelDecision.decision).toBe("complete");
    expect(result.finalDecision).toMatchObject({ decision: "adjust", source: "rules" });
    expect(result.mutatingStep).toBe(true);
    expect(result.recoveryStepFound).toBe(true);
  });

  it("lets deterministic postcondition blockers override a model continue decision", async () => {
    const task = createTask();
    const deploy = createStep("deploy", "systemctl restart app", "validating");
    deploy.result = {
      executionStatus: "success",
      observationStatus: "unknown",
      facts: {},
      warnings: [],
      evidenceIds: [],
    };
    task.plan = [deploy, createStep("验收", "curl -fsS http://localhost", "pending")];
    const result = await reviewExecutionEvidence({
      task,
      step: deploy,
      reviewRequired: true,
      postconditionReview: true,
      validationExitCode: 127,
      model,
      apiKey: "secret-key",
    }, vi.fn().mockResolvedValue({
      decision: "continue",
      reason: "continue",
      summary: "continue",
      source: "model",
    }));

    expect(result.modelDecision?.decision).toBe("continue");
    expect(result.finalDecision).toMatchObject({ decision: "adjust", source: "rules" });
    expect(result.hardBlocker).toContain("不可执行或不存在");
  });

  it("continues adjacent read-only diagnostics before acting on an adjust review", async () => {
    const task = createTask();
    const inspect = createStep("检查端口", "ss -lntp", "validating");
    inspect.result = {
      executionStatus: "success",
      observationStatus: "warning",
      facts: {},
      warnings: ["uncertain"],
      evidenceIds: [],
    };
    task.plan = [inspect, createStep("查看日志", "journalctl -n 20", "pending")];
    const result = await reviewExecutionEvidence({
      task,
      step: inspect,
      reviewRequired: true,
      postconditionReview: false,
      model,
      apiKey: "secret-key",
    }, vi.fn().mockResolvedValue({
      decision: "adjust",
      reason: "uncertain",
      summary: "adjust",
      source: "model",
    }));

    expect(result.continuedForDiagnostics).toBe(true);
    expect(result.finalDecision).toMatchObject({ decision: "continue", source: "rules" });
  });
});

