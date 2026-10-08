import { describe, expect, it, vi } from "vitest";
import type { OpsTask, PlanStep, ServerProfile } from "@/types";
import { preparePlanForApproval } from "./planPreparation";
import { observationBoundary } from "./observationBoundary";
import { runToolStepLifecycle } from "./toolStepLifecycle";

const startedAt = "2026-10-02T03:15:49.000Z";
const completedAt = "2026-10-02T03:15:49.618Z";
const server: ServerProfile = { id: "server", name: "fixture", host: "fixture.invalid", port: 22, username: "fixture",
  group: "", status: "online", environment: [], createdAt: startedAt,
  info: { os: "", kernel: "", cpu: "", cores: 1, memoryGb: 1, diskGb: 1, uptime: "" } };
const write = (): PlanStep => ({ id: "deploy", kind: "change", title: "启动站点", description: "已确认可以启动",
  command: "systemctl start core-case-static.service", action: { type: "shell", command: "systemctl start core-case-static.service" },
  validation: "systemctl is-active core-case-static.service", expected: "active", risk: "medium", status: "pending" });

async function observedTask(text = 'tcp LISTEN 0 5 0.0.0.0:8080 0.0.0.0:* users:(("python3",pid=68474,fd=3))') {
  const proposal: PlanStep = { id: "ports", kind: "observe", title: "确认 8080 端口当前未被占用", description: "占用时不能启动",
    command: "", validation: "", action: { type: "tool", toolId: "services.inspect", arguments: { check: "ports" } },
    expected: "返回当前监听端口清单，明确 8080 是否已被占用", risk: "low", status: "pending" };
  const prepared = preparePlanForApproval([proposal], { taskId: "task", permission: "managed", server, servers: [server] });
  const step: PlanStep = JSON.parse(JSON.stringify(prepared.compatibilitySteps[0]));
  step.executionIntent = prepared.steps[0].intent;
  step.attemptContext = JSON.stringify([server.id, "round", "session", 2, 0]);
  const action = prepared.steps[0].action;
  if (action.type !== "tool") throw new Error("expected tool");
  const call = { id: "call", toolId: action.toolId, arguments: action.arguments };
  const times = [startedAt, completedAt];
  const lifecycle = await runToolStepLifecycle({ step, call,
    execute: async () => ({ callId: call.id, toolId: call.toolId, success: true,
      data: { request: call.arguments, status: "complete", items: [{ kind: "ports", subject: "server:listening", text, exitCode: 0 }],
        scannedEntries: 0, matchedEntries: 1, skippedCount: 0, skipped: [], coverageComplete: true, truncated: false,
        elapsedMs: 22, finishedAt: completedAt } }),
    createEvidenceId: () => "ports-receipt", now: () => times.shift()!, isCancelled: () => false, onStart: vi.fn() });
  const task: OpsTask = { id: "task", serverId: server.id, title: "部署站点", rootGoal: "部署站点", status: "running",
    permission: "managed", modelId: "model", currentRoundId: "round", createdAt: startedAt, updatedAt: completedAt,
    messages: [], plan: [step, write()] };
  return { task, step, lifecycle };
}

describe("observation-to-change stage boundary", () => {
  it("stops at the change after the real ports lifecycle returns an occupied 8080", async () => {
    const { task, step, lifecycle } = await observedTask();
    expect(lifecycle).toMatchObject({ shouldAdvance: true });
    expect(step.status).toBe("completed");
    expect(step.output).toContain("68474");
    const original = structuredClone(task);
    expect(observationBoundary(task)).toMatchObject({ nextStepId: "deploy", observedStepIds: ["ports"],
      evidenceIds: ["ports-receipt"], pendingStepIds: ["deploy"] });
    expect(task).toEqual(original);
  });

  it("does not guess that an empty port list permits the planned write", async () => {
    const { task } = await observedTask("Netid State Local Address:Port");
    expect(observationBoundary(task)?.nextStepId).toBe("deploy");
    task.plan[0].expected = "肯定空闲，可以继续部署";
    task.plan[0].description = "不用复核";
    expect(observationBoundary(task)?.nextStepId).toBe("deploy");
  });

  it("keeps independent reads together and creates one boundary before the following write", async () => {
    const { task, step } = await observedTask();
    const nextRead: PlanStep = { ...step, id: "second-read", status: "pending", result: undefined, evidence: undefined };
    task.plan.splice(1, 0, nextRead);
    expect(observationBoundary(task)).toBeUndefined();
    nextRead.status = "completed";
    expect(observationBoundary(task)?.observedStepIds).toEqual(["ports"]);
  });

  it("does not repeat the boundary once the observed phase has been archived and replaced", async () => {
    const { task, step } = await observedTask();
    task.phaseHistory = [{ id: "observed", roundId: "round", reason: "adjustment", requirement: "部署站点", plan: [step],
      createdAt: startedAt, completedAt }];
    task.plan = [{ ...write(), id: "reviewed-deploy" }];
    expect(observationBoundary(task)).toBeUndefined();
  });

  it.each(["output-only", "missing-scope", "other-target", "not-dispatched", "failed", "unreferenced"])(
    "does not create a boundary from %s fixture or non-current evidence", async mode => {
      const { task, step } = await observedTask();
      if (mode === "output-only") { step.result = undefined; step.evidence = undefined; }
      if (mode === "missing-scope") delete step.evidence![0].scope;
      if (mode === "other-target") task.executionTargetServerId = "other";
      if (mode === "not-dispatched") step.result!.facts.commandDispatched = false;
      if (mode === "failed") step.status = "failed";
      if (mode === "unreferenced") step.result!.evidenceIds = [];
      expect(observationBoundary(task)).toBeUndefined();
    });

  it.each(["evidence.read", "context.expand", "user.request_input"])("does not treat %s as a new remote observation", async toolId => {
    const { task, step } = await observedTask();
    step.action = { type: "tool", toolId, arguments: {} };
    expect(observationBoundary(task)).toBeUndefined();
  });

  it("recognizes real Shell discovery receipts without depending on a tool name", async () => {
    const { task, step } = await observedTask();
    step.action = { type: "shell", command: "ss -lntp" }; step.command = step.action.command;
    step.executionIntent = undefined;
    expect(observationBoundary(task)?.observedStepIds).toEqual(["ports"]);
  });

  it("keeps user questions on the existing standalone path", async () => {
    const { task } = await observedTask();
    task.plan[1] = { ...write(), kind: "observe", command: "", validation: "",
      action: { type: "tool", toolId: "user.request_input", arguments: {} } };
    expect(observationBoundary(task)).toBeUndefined();
  });
});
