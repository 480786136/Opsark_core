import { describe, expect, it } from "vitest";
import {
  buildAdjustmentBlockerSnapshot,
  isSameAdjustmentIncident,
  openAdjustmentIncident,
} from "./adjustmentIncident";
import type { OpsTask, PlanStep } from "@/types";

function failedStep(output = "connection refused"): PlanStep {
  return {
    id: "step-1",
    title: "检查服务",
    description: "检查目标服务",
    command: "curl -f http://127.0.0.1/health",
    expected: "health endpoint is ready",
    validation: "curl -f http://127.0.0.1/health",
    risk: "low",
    status: "failed",
    output,
    result: {
      executionStatus: "failed",
      observationStatus: "unknown",
      facts: { category: "command_failed", commandCompleted: false },
      warnings: [],
      evidenceIds: [],
      failureReason: "health check failed",
    },
  };
}

function taskWith(step: PlanStep): OpsTask {
  return {
    id: "task-1",
    serverId: "server-1",
    title: "deploy app",
    status: "needs_adjustment",
    permission: "managed",
    modelId: "model-1",
    messages: [],
    plan: [step],
    currentRoundId: "round-1",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

const target = {
  paneId: "pane-1",
  terminalRevision: 1,
  terminalStatus: "connected",
  terminalBusy: false,
  host: "192.0.2.10",
  port: 22,
  username: "root",
};

describe("adjustment incident fingerprint", () => {
  it("不使用可变的展示文案作为阻塞身份", () => {
    const task = taskWith(failedStep());
    task.pauseReason = "已等待 30 秒";
    const first = buildAdjustmentBlockerSnapshot(task, task.plan[0], target);
    task.pauseReason = "已等待 120 秒，请继续";
    const second = buildAdjustmentBlockerSnapshot(task, task.plan[0], target);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(isSameAdjustmentIncident(openAdjustmentIncident(first, true, task.createdAt), second)).toBe(true);
  });

  it("新证据、新凭据或新终端代次会开启新 incident", () => {
    const task = taskWith(failedStep("first evidence"));
    const first = buildAdjustmentBlockerSnapshot(task, task.plan[0], target);

    task.plan[0].output = "new evidence";
    const evidenceChanged = buildAdjustmentBlockerSnapshot(task, task.plan[0], target);
    task.plan[0].output = "first evidence";
    task.credentialRevision = 1;
    const credentialChanged = buildAdjustmentBlockerSnapshot(task, task.plan[0], target);
    task.credentialRevision = 0;
    const terminalChanged = buildAdjustmentBlockerSnapshot(task, task.plan[0], {
      ...target,
      terminalRevision: 2,
    });

    expect(evidenceChanged.fingerprint).not.toBe(first.fingerprint);
    expect(credentialChanged.fingerprint).not.toBe(first.fingerprint);
    expect(terminalChanged.fingerprint).not.toBe(first.fingerprint);
  });

  it("终端未释放时标记为 transport incident", () => {
    const task = taskWith(failedStep());
    const snapshot = buildAdjustmentBlockerSnapshot(task, task.plan[0], {
      ...target,
      terminalBusy: true,
    });

    expect(snapshot.kind).toBe("transport");
  });
});
