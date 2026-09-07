import { describe, expect, it } from "vitest";
import {
  applyStepExecutionEntry,
  applyStepExecutionException,
} from "@/features/agent/stepExecutionEntry";
import type { PlanStep } from "@/types";

function step(status: PlanStep["status"] = "pending"): PlanStep {
  return {
    id: "step-1",
    title: "部署应用",
    description: "部署应用",
    command: "deploy --token ${secret.TOKEN}",
    risk: "medium",
    expected: "部署完成",
    validation: "true",
    status,
  };
}

describe("step execution entry", () => {
  it("passes a tool call through without changing the step", () => {
    const currentStep = step();
    const call = { id: "call-1", toolId: "files.get_structure", arguments: {} };
    const entry = applyStepExecutionEntry({
      taskTitle: "部署",
      step: currentStep,
      dispatch: { kind: "tool", call },
      startedAt: "now",
    });

    expect(entry).toEqual({ kind: "tool", call });
    expect(currentStep.status).toBe("pending");
  });

  it("coordinates a tool protocol failure", () => {
    const currentStep = step();
    const entry = applyStepExecutionEntry({
      taskTitle: "部署",
      step: currentStep,
      dispatch: { kind: "invalid", error: "参数必须是 JSON 对象" },
      startedAt: "now",
    });

    expect(entry).toMatchObject({ kind: "stop", taskStatus: "needs_adjustment" });
    expect(currentStep.status).toBe("failed");
    expect(currentStep.result?.facts.category).toBe("tool_command_parse");
  });

  it("coordinates sensitive input wait with its description", () => {
    const currentStep = step();
    const entry = applyStepExecutionEntry({
      taskTitle: "部署",
      step: currentStep,
      dispatch: { kind: "await-secret", key: "TOKEN" },
      startedAt: "now",
      secretDescription: "部署令牌",
    });

    expect(entry).toMatchObject({
      kind: "stop",
      taskStatus: "awaiting_input",
      pendingSecretKey: "TOKEN",
    });
    if (entry.kind === "stop") expect(entry.eventMessage).toContain("部署令牌");
    expect(currentStep.status).toBe("awaiting_input");
  });

  it("initializes remote command execution consistently", () => {
    const currentStep = step();
    const entry = applyStepExecutionEntry({
      taskTitle: "部署任务",
      step: currentStep,
      dispatch: { kind: "command" },
      startedAt: "2026-08-14T01:00:00.000Z",
    });

    expect(entry).toMatchObject({ kind: "command", taskStatus: "running" });
    if (entry.kind === "command") expect(entry.terminalHeader).toContain("部署任务");
    expect(currentStep).toMatchObject({
      status: "running",
      startedAt: "2026-08-14T01:00:00.000Z",
      elapsedSeconds: 0,
      progressMessage: "正在建立远程执行通道…",
    });
  });

  it("coordinates an unexpected execution exception", () => {
    const currentStep = step("running");
    const result = applyStepExecutionException(currentStep, new Error("connection lost"));

    expect(result).toMatchObject({ taskStatus: "needs_adjustment" });
    expect(currentStep.status).toBe("failed");
    expect(currentStep.result?.facts.category).toBe("execution_exception");
  });
});
