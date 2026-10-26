import { describe, expect, it } from "vitest";
import type { OpsTask } from "@/types";
import type { ExecutionOperationRecord } from "@/services/executionLedger";
import type { TaskModelRequest } from "@/services/taskModelRequests";
import { transitionTask } from "./taskMachine";
import { mergeTaskModelEvidence, mergeTaskRemoteEvidence, recordTaskCancellation, taskTerminalEvidenceSummary } from "./taskTerminalEvidence";

const started = Date.parse("2026-10-12T00:00:00.000Z");
function task(): OpsTask {
  return { id: "task", currentRoundId: "round-1", workflowEpoch: 2, serverId: "server", title: "采样", status: "running",
    permission: "observe", modelId: "model", plan: [], messages: [], createdAt: new Date(started - 2000).toISOString(),
    updatedAt: new Date(started).toISOString(), currentExecutionId: "exec-original" };
}
function operation(): ExecutionOperationRecord {
  return { version: 1, operationId: "operation-original", taskId: "task", stepId: "step", roundId: "round-1", workflowEpoch: 2,
    planRevision: 1, stepRevision: 1, intentDigest: "sha256:original", intent: {} as ExecutionOperationRecord["intent"],
    phase: "command", effect: "read", resourceKeys: ["endpoint:host:22"], executionId: "exec-original", state: "failed",
    cancelRequested: true, createdAt: started, updatedAt: started + 7578,
    attempts: [{ version: 1, id: "attempt-original", operationId: "operation-original", executionId: "exec-original",
      status: "failed", bootId: "boot", cancelRequested: true, late: true, startedAt: started - 1000,
      completedAt: started + 7578, outcome: { status: "failed", result: { exitCode: 130, output: "original sample" }, evidenceRefs: ["evidence-original"] } }],
  };
}
function model(overrides: Partial<TaskModelRequest> = {}): TaskModelRequest {
  return { taskId: "task", roundId: "round-1", requestId: "request-original", operationId: "model-operation",
    state: "cancelled", phase: "cancelled", cancelRequested: true, late: true,
    createdAtMs: started, updatedAtMs: started + 8000, ...overrides };
}

describe("explicit task and cancellation terminal evidence", () => {
  it("refines unknown only with a non-older original receipt and rejects stale or changed-start identities", () => {
    const current = task(), unknown = operation();
    unknown.attempts[0].status = "unknown"; unknown.attempts[0].outcome = { status: "unknown", result: {}, evidenceRefs: ["unknown-evidence"] };
    mergeTaskRemoteEvidence(current, [unknown]);
    const changedStart = operation(); changedStart.attempts[0].startedAt += 1;
    expect(mergeTaskRemoteEvidence(current, [changedStart])).toBe(false);
    const older = operation(); older.attempts[0].completedAt! -= 1;
    expect(mergeTaskRemoteEvidence(current, [older])).toBe(false);
    expect(current.terminalEvidence!.remoteAttempts[0].status).toBe("unknown");
    const late = operation(); late.attempts[0].completedAt! += 10;
    expect(mergeTaskRemoteEvidence(current, [late])).toBe(true);
    expect(current.terminalEvidence!.remoteAttempts[0]).toMatchObject({ status: "failed", state: "exit_recorded", exitCode: 130 });
    expect(mergeTaskRemoteEvidence(current, [unknown])).toBe(false);
  });
  it("does not turn a last business event or legacy updatedAt into terminal time", () => {
    const current = task(); current.status = "cancelled";
    expect(taskTerminalEvidenceSummary(current).terminalAt).toBeUndefined();
    transitionTask(current, "cancelled", new Date(started + 10_000).toISOString());
    expect(taskTerminalEvidenceSummary(current).terminalAt).toBeUndefined();
  });

  it("stores cancellation and task transition independently, keeping the earliest request", () => {
    const current = task();
    recordTaskCancellation(current, { reason: "terminate", requestedAt: new Date(started).toISOString() });
    recordTaskCancellation(current, { reason: "terminate", requestedAt: new Date(started + 1000).toISOString() });
    current.workflowEpoch = 3;
    transitionTask(current, "cancelled", new Date(started + 2000).toISOString());
    transitionTask(current, "cancelled", new Date(started + 3000).toISOString());
    expect(current.terminalEvidence!.cancellations).toHaveLength(1);
    expect(current.terminalEvidence!.terminals).toHaveLength(1);
    expect(taskTerminalEvidenceSummary(current)).toMatchObject({ cancelRequestedAt: new Date(started).toISOString(),
      terminalAt: new Date(started + 2000).toISOString(), remoteState: "pending" });
  });

  it("preserves late original exit 130 across stop and restart without reviving the task", () => {
    const current = task();
    recordTaskCancellation(current, { reason: "terminate", requestedAt: new Date(started).toISOString() });
    current.workflowEpoch = 3; transitionTask(current, "cancelled", new Date(started + 2000).toISOString());
    const restored: OpsTask = JSON.parse(JSON.stringify(current));
    mergeTaskRemoteEvidence(restored, [operation()]);
    expect(restored.status).toBe("cancelled");
    expect(taskTerminalEvidenceSummary(restored)).toMatchObject({ remoteState: "exit_recorded", exitCode: 130,
      exitRecordedAt: started + 7578, exitReceiptDelayMs: 7578, terminalAt: new Date(started + 2000).toISOString() });
    expect(restored.terminalEvidence!.remoteAttempts[0]).toMatchObject({ operationId: "operation-original", attemptId: "attempt-original", late: true });
    restored.currentExecutionId = undefined;
    recordTaskCancellation(restored, { reason: "terminate", requestedAt: new Date(started + 20_000).toISOString() });
    expect(restored.terminalEvidence!.cancellations).toHaveLength(1);
    expect(taskTerminalEvidenceSummary(restored).remoteState).toBe("exit_recorded");
  });

  it.each(["missing_receipt", "missing_exit", "unknown_outcome", "foreign_attempt"])("does not confirm exit from %s", reason => {
    const current = task(); recordTaskCancellation(current, { reason: "terminate" });
    const record = operation();
    if (reason === "missing_receipt") record.attempts[0].outcome!.evidenceRefs = [];
    if (reason === "missing_exit") record.attempts[0].outcome!.result = { message: "已停止", pidMissing: true };
    if (reason === "unknown_outcome") { record.attempts[0].status = "unknown"; record.attempts[0].outcome!.status = "unknown"; }
    if (reason === "foreign_attempt") record.attempts[0].operationId = "another-operation";
    mergeTaskRemoteEvidence(current, [record]);
    expect(taskTerminalEvidenceSummary(current).remoteState).toBe("pending");
    expect(taskTerminalEvidenceSummary(current).exitCode).toBeUndefined();
  });

  it("does not accept another task's receipt or let a stale refresh downgrade a saved exit", () => {
    const current = task(); const foreign = operation(); foreign.taskId = "another-task";
    mergeTaskRemoteEvidence(current, [foreign]); expect(current.terminalEvidence!.remoteAttempts).toHaveLength(0);
    mergeTaskRemoteEvidence(current, [operation()]);
    const stale = operation(); stale.attempts[0].status = "dispatching"; stale.attempts[0].outcome = undefined;
    mergeTaskRemoteEvidence(current, [stale]);
    expect(current.terminalEvidence!.remoteAttempts[0].state).toBe("exit_recorded");
    const contradicting = operation();
    contradicting.attempts[0].status = "not_dispatched";
    contradicting.attempts[0].outcome = { status: "not_dispatched", evidenceRefs: ["different"], result: {} };
    mergeTaskRemoteEvidence(current, [contradicting]);
    expect(current.terminalEvidence!.remoteAttempts[0].exitCode).toBe(130);
  });

  it("does not use an older round's terminal time as the end of a resumed task", () => {
    const current = task(); transitionTask(current, "cancelled", new Date(started).toISOString());
    current.currentRoundId = "round-2"; current.workflowEpoch = 3; transitionTask(current, "planning");
    expect(taskTerminalEvidenceSummary(current).terminalAt).toBeUndefined();
    transitionTask(current, "completed", new Date(started + 5000).toISOString());
    expect(current.terminalEvidence!.terminals).toHaveLength(2);
    expect(taskTerminalEvidenceSummary(current).terminalAt).toBe(new Date(started + 5000).toISOString());
  });

  it("keeps missing cancelled usage unknown and adds late usage only to the original request", () => {
    const current = task(); current.status = "cancelled";
    mergeTaskModelEvidence(current, [model()]);
    expect(current.terminalEvidence!.modelRequests[0].usageStatus).toBe("missing");
    mergeTaskModelEvidence(current, [model({ updatedAtMs: started + 9000, usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } })]);
    expect(current.status).toBe("cancelled");
    expect(current.terminalEvidence!.modelRequests[0]).toMatchObject({ requestId: "request-original", usageStatus: "reported", usage: { total_tokens: 19 } });
    mergeTaskModelEvidence(current, [model({ requestId: "foreign", taskId: "other", usage: { total_tokens: 999 } })]);
    expect(current.terminalEvidence!.modelRequests).toHaveLength(1);
    mergeTaskModelEvidence(current, [model({ updatedAtMs: started + 10_000 })]);
    expect(current.terminalEvidence!.modelRequests[0].usage?.total_tokens).toBe(19);
  });

  it("distinguishes definite non-dispatch from zero usage and preserves unresolved cost", () => {
    const current = task();
    mergeTaskModelEvidence(current, [model({ state: "not_dispatched", requestId: "never-started" }),
      model({ state: "unknown", requestId: "unknown", usage: { total_tokens: -1, secret: "not retained" } }),
      model({ state: "completed", requestId: "zero-reported", usage: { total_tokens: 0 } })]);
    expect(current.terminalEvidence!.modelRequests.map(item => item.usageStatus)).toEqual(["not_dispatched", "missing", "reported"]);
    expect(current.terminalEvidence!.modelRequests[0].usage).toBeUndefined();
    expect(taskTerminalEvidenceSummary(current).modelRequestsWithMissingUsage).toBe(1);
  });
});
