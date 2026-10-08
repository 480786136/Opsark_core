import { describe, expect, it, vi } from "vitest";
import type { NextStageDecision, OpsTask, PlanStep, ServerProfile } from "@/types";
import { executionDigest, preparePlanForApproval } from "./planPreparation";
import { toolExecutionScope } from "./toolEvidenceScope";
import { runToolStepLifecycle } from "./toolStepLifecycle";
import { prepareTaskDecision, taskDecisionEvidenceIds, TaskDecisionError, TaskEvidenceError } from "./taskDecisionResolution";
import { buildTaskDecisionSnapshot } from "./taskDecisionSnapshot";
import { decideTaskNextStage } from "./agentService";

const startedAt = "2026-09-30T01:00:00.000Z", completedAt = "2026-09-30T01:00:01.000Z";
const server: ServerProfile = { id: "server", name: "server", host: "server.example", port: 22, username: "deploy",
  group: "", status: "online", environment: [], createdAt: startedAt,
  info: { os: "", kernel: "", cpu: "", cores: 1, memoryGb: 1, diskGb: 1, uptime: "" } };

async function executedTask() {
  const proposal: PlanStep = { id: "inspect", title: "读取目录", description: "", command: "", validation: "",
    action: { type: "tool", toolId: "files.get_structure", arguments: { rootPath: "/opt/app" } },
    risk: "low", kind: "observe", expected: "记录目录结构", status: "pending" };
  const prepared = preparePlanForApproval([proposal], { taskId: "task", permission: "managed", server, servers: [server] });
  const step: PlanStep = JSON.parse(JSON.stringify(prepared.compatibilitySteps[0]));
  step.executionIntent = prepared.steps[0].intent;
  step.attemptContext = JSON.stringify([server.id, "round", "", 0, 0]);
  const action = prepared.steps[0].action;
  if (action.type !== "tool") throw new Error("fixture requires a tool");
  const call = { id: "call", toolId: action.toolId, arguments: action.arguments };
  const times = [startedAt, completedAt];
  await runToolStepLifecycle({ step, call,
    execute: async () => ({ callId: call.id, toolId: call.toolId, success: true,
      data: { rootPath: "/opt/app", tree: "/opt/app/", truncated: false, warnings: [] } }),
    createEvidenceId: () => "tool-proof", now: () => times.shift()!, isCancelled: () => false, onStart: vi.fn() });
  const task: OpsTask = { id: "task", serverId: server.id, title: "读取目录", status: "running", permission: "managed",
    modelId: "model", currentRoundId: "round", createdAt: startedAt, updatedAt: completedAt, messages: [], plan: [step],
    requirementLifecycle: { version: 1, revision: 1, focus: { roundId: "round", sourceMessageId: "message", requirementIds: ["read"] },
      items: [{ id: "read", kind: "goal", content: "读取目录", status: "active", evidenceIds: [],
        source: { content: "读取目录", source: "user_message", relation: "new_goal", sourceMessageId: "message", createdAt: startedAt } }] } };
  return task;
}
function decision(): NextStageDecision {
  return { decision: "complete", reason: "目录已读取", summary: "目录已读取", source: "model", steps: [],
    requirementReview: { baseRevision: 1, roundId: "round", focusOutcome: "completed", overallOutcome: "completed",
      items: [{ requirementId: "read", outcome: "satisfied", evidenceIds: ["tool-proof"], reason: "真实目录结果" }] } };
}
function legacy(task: OpsTask) {
  const step = task.plan[0];
  delete step.evidence![0].scope;
  step.executionLedgerAttempts = [{ operationId: "op", attemptId: "attempt", executionId: "execution", phase: "tool" }];
  step.ledgerAppliedAttemptIds = ["attempt"];
  step.ledgerVerifiedAttemptIds = ["attempt"];
  return step;
}

describe("tool execution through requirement acceptance", () => {
  it.each(["context.expand", "evidence.read", "server.resolve_connection", "user.request_input"])(
    "does not promote %s context into a fresh remote observation", async toolId => {
      const task = await executedTask(), step = legacy(task);
      step.executionIntent = JSON.parse(JSON.stringify(step.executionIntent));
      step.action = { type: "tool", toolId, arguments: {} };
      step.executionIntent!.semantic.action = step.action;
      step.executionIntent!.digest = executionDigest({ version: step.executionIntent!.version, semantic: step.executionIntent!.semantic });
      step.result!.facts.toolId = toolId; step.evidence![0].facts.toolId = toolId;
      expect(toolExecutionScope(step, toolId)).toBeUndefined();
      expect(taskDecisionEvidenceIds(task)).toEqual([]);
      expect(() => prepareTaskDecision(task, decision())).toThrow(TaskDecisionError);
    });

  it("produces usable target evidence and shares exactly that index with the model", async () => {
    const task = await executedTask();
    expect(task.plan[0].evidence![0].scope).toMatchObject({ targetId: "server", scope: "isolated_exec" });
    expect(taskDecisionEvidenceIds(task)).toEqual(["tool-proof"]);
    expect(buildTaskDecisionSnapshot(task).requirementEvidence.availableIds).toEqual(["tool-proof"]);
    expect(prepareTaskDecision(task, decision()).currentRequestReview?.completed).toBe(true);
    task.executionTargetServerId = "another-server";
    expect(taskDecisionEvidenceIds(task)).toEqual([]);
    expect(() => prepareTaskDecision(task, decision())).toThrow(TaskDecisionError);
  });

  it("recovers only verified historical tool identity without rewriting saved evidence", async () => {
    const task = await executedTask(), step = legacy(task);
    expect(taskDecisionEvidenceIds(task)).toEqual(["tool-proof"]);
    expect(prepareTaskDecision(task, decision()).currentRequestReview?.completed).toBe(true);
    expect(step.evidence![0].scope).toBeUndefined();
  });

  it("keeps the original dispatch target when mutable task state changes during a read", async () => {
    const task = await executedTask(), step = task.plan[0];
    step.status = "pending";
    if (step.action?.type !== "tool") throw new Error("fixture requires a tool");
    const call = { id: "second", toolId: step.action.toolId, arguments: step.action.arguments };
    await runToolStepLifecycle({ step, call, execute: async () => {
      step.attemptContext = JSON.stringify(["other-server", "round", "", 0, 0]);
      task.executionTargetServerId = "other-server";
      return { callId: call.id, toolId: call.toolId, success: true,
        data: { rootPath: "/opt/app", tree: "/opt/app/", truncated: false, warnings: [] } };
    }, createEvidenceId: () => "original-target", now: () => completedAt, isCancelled: () => false, onStart: vi.fn() });
    expect(step.evidence![0].scope?.targetId).toBe("server");
    expect(taskDecisionEvidenceIds(task)).toEqual([]);
  });

  it.each(["unverified", "unapplied", "wrong_attempt", "tampered_intent", "changed_action", "changed_task", "wrong_target", "old_time"])(
    "does not infer scope for %s historical evidence", async mode => {
      const task = await executedTask(), step = legacy(task);
      // Frozen preparation data is copied to simulate an archive restored from disk.
      step.executionIntent = JSON.parse(JSON.stringify(step.executionIntent));
      if (mode === "unverified") step.ledgerVerifiedAttemptIds = [];
      if (mode === "unapplied") step.ledgerAppliedAttemptIds = [];
      if (mode === "wrong_attempt") step.executionLedgerAttempts![0].attemptId = "another";
      if (mode === "tampered_intent") step.executionIntent!.semantic.targets[0].host = "different.example";
      if (mode === "changed_action" && step.action?.type === "tool") step.action.arguments.rootPath = "/different";
      if (mode === "changed_task") task.id = "another-task";
      if (mode === "wrong_target") step.attemptContext = JSON.stringify(["other-server", "round", "", 0, 0]);
      if (mode === "old_time") step.evidence![0].collectedAt = "2026-09-29T00:00:00Z";
      expect(taskDecisionEvidenceIds(task)).toEqual([]);
      expect(() => prepareTaskDecision(task, decision())).toThrow(TaskEvidenceError);
    });

  it("does not ask the model to regenerate an unrepairable local receipt", async () => {
    const task = await executedTask();
    delete task.plan[0].evidence![0].scope;
    const decide = vi.fn().mockResolvedValue(decision());
    await expect(decideTaskNextStage({ task,
      model: { id: "model", name: "fixture", provider: "Remote", model: "fixture", endpoint: "https://fixture.test", enabled: true, hasApiKey: true },
      apiKey: "fixture", tools: [], secretMetadata: [],
      generationSettings: { limitOutput: false, maxPlanSteps: 6, maxOutputTokens: 5000, maxTextChars: 200, maxCommandChars: 4000 },
    }, decide)).rejects.toBeInstanceOf(TaskEvidenceError);
    expect(decide).toHaveBeenCalledOnce();
  });
});
