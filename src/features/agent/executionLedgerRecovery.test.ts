import { describe, expect, it } from "vitest";
import type { OpsTask, ExecutionIntentSemantic, ExecutionIntentSnapshot, ServerProfile } from "@/types";
import type { ExecutionOperationRecord } from "@/services/executionLedger";
import { executionDigest } from "./planPreparation";
import { buildReadOnlyReconciliation, isReadOnlyServiceValidator, parseFileReconciliationObservation,
  missingInspectionReceipts, isUntouchedRecoveryShell, executionRecordTitle, projectExecutionLedgerRecovery, readExecutionLedger, readTaskProjection } from "./executionLedgerRecovery";

function record(overrides: Partial<ExecutionOperationRecord> = {}, semantics: Partial<ExecutionIntentSemantic> = {}): ExecutionOperationRecord {
  const semantic: ExecutionIntentSemantic = { taskId: "task-a", stepId: "step-a", action: { type: "shell", command: "systemctl start app" },
    targets: [{ role: "execution", serverId: "server-a", host: "a.example", port: 22, username: "deploy" }],
    kind: "change", effect: "change", risk: "medium", expected: "app is ready", permission: "safe", dependencies: { precedingStepIds: [] },
    policyVersion: "core-execution-policy@1", runtimeClass: "persistent_service",
    validator: { type: "service", command: "systemctl is-active app", validStates: ["healthy"] }, ...semantics };
  const intent: ExecutionIntentSnapshot = { version: "execution-intent@1", algorithm: "sha256",
    digest: executionDigest({ version: "execution-intent@1", semantic }), semantic };
  return { version: 1, operationId: "op-a", taskId: "task-a", stepId: "step-a", workflowEpoch: 1,
    planRevision: 1, stepRevision: 1, intentDigest: intent.digest, intent, phase: "command", effect: "change", resourceKeys: ["endpoint:a.example:22"],
    state: "unknown", cancelRequested: false, createdAt: 1, updatedAt: 2,
    attempts: [{ version: 1, id: "attempt-a", operationId: "op-a", executionId: "exec-a", status: "unknown", bootId: "old-boot", cancelRequested: false, late: false, startedAt: 1 }], ...overrides };
}
const server = (id: string, host: string) => ({ id, host, port: 22, username: "deploy" }) as ServerProfile;
const servers = [server("server-a", "a.example"), server("server-b", "b.example")];

describe("versioned pure recovery readers", () => {
  it("preserves old historical fields, polluted tool fields and their evidence through repeated reads", () => {
    const historical = { id: "task-a", serverId: "server-a", status: "completed", messages: [], plan: [{
      id: "old-step", status: "completed", command: "original command  ", validation: "original validator",
      action: { type: "tool", toolId: "files.read_content", arguments: { path: "/a" } },
      evidence: [{ id: "evidence-original", output: "actual old output" }], legacyUnknownField: { fact: "untouched" },
    }], phaseHistory: [{ plan: [{ id: "old-phase-step", command: "old phase command" }] }] };
    const original = JSON.stringify(historical);
    const once = readTaskProjection([historical]);
    expect(once.compatible).toBe(true);
    expect(readTaskProjection({ version: 1, contractVersion: "task-projection@1", tasks: once.tasks }).tasks).toEqual([historical]);
    once.tasks[0].plan[0].command = "runtime edit";
    expect(JSON.stringify(historical)).toBe(original);
  });
  it("never treats unknown versions or malformed rows as an empty successful store", () => {
    expect(readTaskProjection({ version: 9, tasks: [] })).toMatchObject({ compatible: false });
    expect(readTaskProjection({ version: 1, contractVersion: "wrong", tasks: [] }).issues).not.toHaveLength(0);
    expect(readTaskProjection([{ id: "bad-task" }])).toMatchObject({ compatible: false });
    expect(readTaskProjection(undefined)).toEqual({ tasks: [], compatible: true, issues: [] });
  });
  it("rejects native future versions, identity mismatch, modified snapshots and duplicate attempts", () => {
    const valid = record();
    expect(readExecutionLedger([valid]).compatible).toBe(true);
    const changed = record(); changed.intent.semantic.expected = "changed after approval";
    for (const bad of [{ ...valid, version: 2 }, { ...valid, taskId: "other-task" }, changed,
      { ...valid, attempts: [...valid.attempts, valid.attempts[0]] }]) {
      expect(readExecutionLedger([bad]).compatible).toBe(false);
    }
    expect(readExecutionLedger({ records: [] }).compatible).toBe(false);
    expect(readExecutionLedger([valid]).operations).toEqual([valid]);
  });
  it("requires a terminal result and matching outcome status without inventing success", () => {
    const missing = record(); missing.attempts[0].status = "succeeded";
    expect(readExecutionLedger([missing]).compatible).toBe(false);
    missing.attempts[0].outcome = { status: "failed", evidenceRefs: [] };
    expect(readExecutionLedger([missing]).compatible).toBe(false);
  });
  it("does not hide uncertainty using a future or foreign reconciliation record", () => {
    const operation = record({ reconciliation: { version: 1, status: "completed", attemptId: "attempt-a", readOperationId: "read-a", readOperationIds: ["read-a"],
      reason: "current_state_verified", evidenceRefs: ["proof"], kind: "service", resolvedAt: 3 } });
    expect(readExecutionLedger([operation]).compatible).toBe(true);
    expect(readExecutionLedger([{ ...operation, reconciliation: { ...operation.reconciliation, version: 9 } }]).compatible).toBe(false);
    expect(readExecutionLedger([{ ...operation, reconciliation: { ...operation.reconciliation, attemptId: "other-attempt" } }]).compatible).toBe(false);
  });
});

describe("recovery projection", () => {
  it("keeps cancellation and dispatching uncertain until remote evidence exists", () => {
    const pending = record({ state: "dispatching", cancelRequested: true });
    pending.attempts[0].status = "dispatching";
    const result = projectExecutionLedgerRecovery([pending]);
    expect(result.items[0]).toMatchObject({ kind: "uncertain", action: "none", cancelRequested: true, attemptId: "attempt-a" });
    expect(result.items[0].knownFacts.join()).toContain("尚未确认远端停止");
  });
  it("retains late known command success for verification instead of deployment retry", () => {
    const success = record({ state: "succeeded" });
    Object.assign(success.attempts[0], { status: "succeeded", late: true, outcome: { status: "succeeded", result: { exitCode: 0 }, evidenceRefs: ["real-proof"] } });
    const result = projectExecutionLedgerRecovery([success]);
    expect(result.items[0]).toMatchObject({ kind: "recorded_result", action: "verify", late: true });
    expect(result.items[0].summary).toContain("不重复执行主命令");
    expect(projectExecutionLedgerRecovery([success], { appliedAttemptIds: ["attempt-a"] }).items).toHaveLength(1);
    expect(projectExecutionLedgerRecovery([success], { appliedAttemptIds: ["attempt-a"], verifiedAttemptIds: ["attempt-a"] }).items).toHaveLength(1);
    success.attempts[0].late = false;
    expect(projectExecutionLedgerRecovery([success], { appliedAttemptIds: ["attempt-a"], verifiedAttemptIds: ["attempt-a"] }).items).toHaveLength(0);
  });
  it("only hides unresolved attempts when native reconciliation names that attempt", () => {
    const operation = record({ reconciliation: { version: 1, status: "completed", attemptId: "attempt-a", readOperationId: "read-a", readOperationIds: ["read-a"],
      reason: "current_state_verified", evidenceRefs: ["proof"], kind: "service", resolvedAt: 3 } });
    expect(projectExecutionLedgerRecovery([operation]).items).toHaveLength(0);
    expect(operation.attempts[0].status).toBe("unknown");
    operation.reconciliation!.attemptId = "other-attempt";
    expect(projectExecutionLedgerRecovery([operation]).items).toHaveLength(1);
  });
  it("does not turn native-verified reconciliation reads into new pending work when their display step is missing", () => {
    const operation = record({ reconciliation: { version: 1, status: "completed", attemptId: "attempt-a", readOperationId: "read-a", readOperationIds: ["read-a"],
      reason: "current_state_verified", evidenceRefs: ["proof"], kind: "service", resolvedAt: 3 } });
    const read = record({ operationId: "read-a", stepId: "read-step", state: "succeeded", effect: "read", attempts: [{ version: 1,
      id: "read-attempt", operationId: "read-a", executionId: "read-execution", status: "succeeded", bootId: "boot", startedAt: 2,
      cancelRequested: false, late: false, outcome: { status: "succeeded", result: { exitCode: 0 }, evidenceRefs: ["proof"] } }] },
    { stepId: "read-step", effect: "read", kind: "observe", action: { type: "shell", command: "systemctl is-active app" } });
    expect(projectExecutionLedgerRecovery([operation, read]).items).toHaveLength(0);
    expect(operation.attempts[0].status).toBe("unknown");
  });
  it("restores saved reads as historical evidence even when every display marker is absent", () => {
    const read = record({ effect: "read", state: "succeeded" }, { effect: "read", kind: "observe", action: { type: "tool", toolId: "disk.inspect", arguments: { path: "/" } } });
    Object.assign(read.attempts[0], { status: "succeeded", late: true, completedAt: 9,
      outcome: { status: "succeeded", evidenceRefs: ["archived-result"] } });
    const original = JSON.stringify(read);
    const projection = projectExecutionLedgerRecovery([read]);
    expect(projection.items).toEqual([]);
    expect(projection.recordedReads).toMatchObject([{ toolId: "disk.inspect", late: true, recordedAt: 9, evidenceRefs: ["archived-result"] }]);
    expect(JSON.stringify(read)).toBe(original);
  });
  it("uses durable review acknowledgement without a task cache and does not infer it from success", () => {
    const operation = record({ state: "succeeded" });
    Object.assign(operation.attempts[0], { status: "succeeded", outcome: { status: "succeeded", evidenceRefs: ["proof"] } });
    expect(projectExecutionLedgerRecovery([operation]).items).toHaveLength(1);
    Object.assign(operation.attempts[0], { projectionAppliedAt: 3, reviewCompletedAt: 4 });
    expect(readExecutionLedger([operation]).compatible).toBe(true);
    expect(projectExecutionLedgerRecovery([operation]).items).toEqual([]);
  });
  it("removes a task-owned negative review from duplicate pending cards without changing historical failure", () => {
    const operation = record({ state: "succeeded" });
    Object.assign(operation.attempts[0], { status: "succeeded", outcome: { status: "succeeded", evidenceRefs: ["proof"] }, projectionAppliedAt: 3 });
    expect(projectExecutionLedgerRecovery([operation]).items).toHaveLength(1);
    operation.attempts[0].reviews = [{ version: 1, operationId: operation.operationId, attemptId: "attempt-a", intentDigest: operation.intentDigest,
      outcome: "not_met", disposition: "task_followup", evidenceRefs: ["proof"], reviewFingerprint: executionDigest("port mismatch review"), recordedAt: 4 }];
    const restored = readExecutionLedger(JSON.parse(JSON.stringify([operation])));
    expect(restored.compatible).toBe(true);
    expect(projectExecutionLedgerRecovery(restored.operations).items).toEqual([]);
    expect(restored.operations[0].attempts[0]).toMatchObject({ status: "succeeded", reviews: [{ outcome: "not_met" }] });
    expect(restored.operations[0].reconciliation).toBeUndefined();
    for (const changed of [
      { ...operation.attempts[0], late: true },
      { ...operation.attempts[0], cancelRequested: true },
      { ...operation.attempts[0], status: "unknown" as const, outcome: { status: "unknown" as const, evidenceRefs: ["proof"] } },
    ]) expect(projectExecutionLedgerRecovery([{ ...operation, attempts: [changed] }]).items).toHaveLength(1);
    expect(projectExecutionLedgerRecovery([{ ...operation, cancelRequested: true }]).items).toHaveLength(1);
    expect(projectExecutionLedgerRecovery([operation], { storageFailures: [{ kind: "storage_failed", operationId: "op-a", attemptId: "attempt-a",
      action: "retry_storage", summary: "storage failed", knownFacts: [] }] }).items[0].kind).toBe("storage_failed");
  });
  it("does not apply a review from another attempt or evidence scope", () => {
    const operation = record({ state: "succeeded" });
    Object.assign(operation.attempts[0], { status: "succeeded", outcome: { status: "succeeded", evidenceRefs: ["proof"] }, projectionAppliedAt: 3 });
    const review = { version: 1 as const, operationId: operation.operationId, attemptId: "attempt-a", intentDigest: operation.intentDigest,
      outcome: "unknown" as const, disposition: "task_followup" as const, evidenceRefs: ["proof"], reviewFingerprint: executionDigest("review"), recordedAt: 4 };
    for (const invalid of [{ ...review, attemptId: "old-attempt" }, { ...review, evidenceRefs: ["other-proof"] },
      { ...review, disposition: "accepted" as const }, { ...review, intentDigest: executionDigest("other-intent") }]) {
      operation.attempts[0].reviews = [invalid];
      expect(readExecutionLedger([operation]).compatible).toBe(false);
      expect(projectExecutionLedgerRecovery([operation]).items).toHaveLength(1);
    }
  });
  it("keeps unsupported uncertain changes visible without an unusable reconciliation button", () => {
    const operation = record({}, { runtimeClass: undefined, action: { type: "shell", command: "touch /srv/a" } });
    const recovery = projectExecutionLedgerRecovery([operation]);
    expect(recovery.items[0]).toMatchObject({ kind: "uncertain", action: "none" });
    expect(recovery.items[0].knownFacts.join()).toContain("只读排查");
    expect(projectExecutionLedgerRecovery([record()], { servers }).items[0].action).toBe("reconcile");
    expect(projectExecutionLedgerRecovery([record()], { servers: [] }).items[0].action).toBe("none");
  });
  it("separates result-commit failure from remote execution failure", () => {
    const result = projectExecutionLedgerRecovery([record()], { storageFailures: [{ kind: "storage_failed", operationId: "op-a", attemptId: "attempt-a",
      action: "retry_storage", summary: "结果已返回，台账提交失败", knownFacts: ["禁止重新发送主命令"] }], issues: ["未知记录版本"] });
    expect(result.items.map(item => item.action)).toEqual(["retry_storage", "none"]);
  });
});

describe("bounded read-only reconciliation", () => {
  const transfer = () => record({ phase: "tool" }, { action: { type: "tool", toolId: "files.transfer_between_servers", arguments: { targetServer: "server-b", sourcePath: "/source", targetPath: "/dest" } },
    targets: [{ role: "source", serverId: "server-a", host: "a.example", port: 22, username: "deploy", path: "/source" },
      { role: "target", serverId: "server-b", host: "b.example", port: 22, username: "deploy", path: "/dest" }] });
  it("pins both original endpoints, uses file fingerprints and never adds writes", () => {
    const plan = buildReadOnlyReconciliation(transfer(), { id: "task-a" }, servers);
    expect(plan.kind).toBe("file_transfer");
    expect(plan.reads.map(read => [read.role, read.serverId])).toEqual([["source", "server-a"], ["target", "server-b"]]);
    expect(plan.reads[0].command).toBe("test -f '/source' && LC_ALL=C stat -Lc '%s' -- '/source' && sha256sum -- '/source' && LC_ALL=C stat -Lc '%s' -- '/source'");
    expect(plan.reads.map(read => read.command).join()).not.toMatch(/scp|sftp|cp |mv |rm /);
    expect(() => buildReadOnlyReconciliation(transfer(), { id: "task-a" }, [servers[0], { ...servers[1], username: "changed-account" }])).toThrow("账户已变化");
  });
  it("only accepts matching before/after size and a complete SHA-256 result", () => {
    const read = buildReadOnlyReconciliation(transfer(), { id: "task-a" }, servers).reads[0];
    const hash = "a".repeat(64);
    expect(parseFileReconciliationObservation(read, `12\n${hash}  /source\n12`, 0)).toMatchObject({ size: 12, sha256: hash, path: "/source" });
    for (const output of [`12\n${hash}  /source\n13`, `12\n${hash.slice(0, 40)}  /source\n12`, "12", ""]) {
      expect(() => parseFileReconciliationObservation(read, output, 0)).toThrow("稳定");
    }
    expect(() => parseFileReconciliationObservation(read, `12\n${hash}  /source\n12`, 1)).toThrow();
  });
  it("only reuses frozen service readiness checks", () => {
    const original = record();
    const plan = buildReadOnlyReconciliation(original, { id: "task-a" }, servers);
    expect(plan.reads[0].command).toBe("systemctl is-active app");
    expect(JSON.stringify(original)).not.toContain("reconciliation");
    for (const command of ["true", "echo ready", "systemctl restart app", "systemctl is-active app; touch /tmp/replayed", "curl -I http://localhost:3000", "curl -fsS http://localhost:3000 && reboot", "curl -fsS -X POST http://localhost:3000"]) {
      expect(isReadOnlyServiceValidator(command), command).toBe(false);
    }
    for (const command of ["systemctl is-active --quiet app.service", "sudo -n systemctl is-active app", "curl -fsS --max-time 5 http://localhost:3000/health"]) {
      expect(isReadOnlyServiceValidator(command), command).toBe(true);
    }
  });
  it("refuses arbitrary shell replay and foreign task evidence", () => {
    expect(() => buildReadOnlyReconciliation(record({}, { runtimeClass: "bounded" }), { id: "task-a" }, servers)).toThrow("尚无自动对账契约");
    expect(() => buildReadOnlyReconciliation(record(), { id: "other-task" }, servers)).toThrow("不属于当前任务");
  });
  it("maps direct-operation endpoint identities only when the local directory match is unique", () => {
    const direct = record({}, { targets: [{ role: "execution", host: "a.example", port: 22, username: "deploy" }] });
    const before = JSON.stringify(direct.intent);
    expect(buildReadOnlyReconciliation(direct, { id: "task-a" }, servers).reads[0].serverId).toBe("server-a");
    expect(JSON.stringify(direct.intent)).toBe(before);
    expect(() => buildReadOnlyReconciliation(direct, { id: "task-a" }, [...servers, server("duplicate", "a.example")])).toThrow("原执行目标");
  });
});

it("uses an exact historical attempt title without changing intent or exposing expected as a heading", () => {
  const operation = record({}, { expected: "返回软件状态、版本以及配置字段".repeat(40) });
  const digest = operation.intentDigest;
  const task = { plan: [{ id: operation.stepId, title: "后来计划的标题", executionLedgerAttempts: [{ operationId: "other", attemptId: "other" }] }] } as unknown as OpsTask;
  expect(executionRecordTitle(operation, "attempt-a", task)).toBe("远端操作");
  task.plan[0].executionLedgerAttempts = [{ operationId: operation.operationId, attemptId: "attempt-a", executionId: "exec-a", phase: "command" }];
  expect(executionRecordTitle(operation, "attempt-a", task)).toBe("后来计划的标题");
  expect(operation.intentDigest).toBe(digest);
  expect(operation.intent.semantic.expected.length).toBeGreaterThan(400);
});

it("recognizes an untouched legacy shell whose missing round ID was initialized on restart", () => {
  const operation = record();
  const task = { id: operation.taskId, title: "执行记录恢复 · a.example", modelId: "", messages: [], plan: [], permission: "observe",
    adjustmentCount: 0, status: "awaiting_continuation", rootGoal: operation.intent.semantic.expected,
    createdAt: new Date(operation.createdAt).toISOString(), workflowEpoch: operation.workflowEpoch, currentRoundId: "generated-at-restart",
    pauseReason: "已恢复历史检查结果，可查看已有证据；这不代表当前任务目标已完成。" } as unknown as OpsTask;
  expect(isUntouchedRecoveryShell(task, [operation])).toBe(true);
  expect(isUntouchedRecoveryShell(task, [{ ...operation, roundId: "later-user-round" }])).toBe(false);
});

describe("direct-operation recovery classification", () => {
  function directRecord() {
    return record({ taskId: "direct-endpoint", phase: "tool", state: "succeeded" }, {
      taskId: "direct-endpoint", policyVersion: "direct-user-action@1", runtimeClass: undefined, validator: undefined,
      action: { type: "tool", toolId: "core.sftp.delete", arguments: { path: "/opt/core-case" } },
    });
  }
  it.each(["unknown", "dispatching", "failed"] as const)("keeps %s direct operations actionable", status => {
    const row = directRecord(); row.state = status; row.attempts[0].status = status;
    if (status === "failed") row.attempts[0].outcome = { status, evidenceRefs: ["proof"] };
    const item = projectExecutionLedgerRecovery([row]).items[0];
    expect(item).toMatchObject({ origin: "direct", kind: status === "failed" ? "recorded_result" : "uncertain" });
    expect(item.knownFacts.join()).toContain("执行记录");
    expect(item.knownFacts.join()).not.toContain("请在任务中");
  });
  it.each(["late", "cancelRequested", "operationCancel"])("retains success with a %s flag", flag => {
    const row = directRecord();
    Object.assign(row.attempts[0], { status: "succeeded", outcome: { status: "succeeded", evidenceRefs: ["proof"] } });
    if (flag === "late") row.attempts[0].late = true;
    else if (flag === "cancelRequested") row.attempts[0].cancelRequested = true;
    else row.cancelRequested = true;
    expect(projectExecutionLedgerRecovery([row]).items[0]).toMatchObject({ origin: "direct", kind: "recorded_result" });
  });
  it("does not bypass task review based on an ID prefix or hide a pending save", () => {
    const row = directRecord();
    Object.assign(row.attempts[0], { status: "succeeded", outcome: { status: "succeeded", evidenceRefs: ["proof"] } });
    const storageFailure = { kind: "storage_failed" as const, operationId: row.operationId, attemptId: row.attempts[0].id,
      action: "retry_storage" as const, summary: "保存失败", knownFacts: [] };
    expect(projectExecutionLedgerRecovery([row], { storageFailures: [storageFailure] }).items).toEqual([storageFailure]);
    row.intent.semantic.policyVersion = "core-execution-policy@1";
    expect(projectExecutionLedgerRecovery([row]).items[0].kind).toBe("recorded_result");
  });
});

it("only deduplicates the exact displayed attempt, preserving earlier and cache-truncated outputs", () => {
  const receipts = ["older", "latest"].map(id => ({ operationId: "op", attemptId: id, stepId: "same-step", title: "检查", status: "succeeded", late: false, evidenceRefs: [id] }));
  const task = { plan: [{ id: "same-step", output: "latest output", executionLedgerAttempts: receipts.map(receipt => ({ operationId: "op", attemptId: receipt.attemptId, executionId: receipt.attemptId, phase: "command" })) }],
    executionLedgerRecovery: { version: "execution-ledger-recovery@1", items: [], recordedReads: receipts } } as unknown as OpsTask;
  expect(missingInspectionReceipts(task).map(receipt => receipt.attemptId)).toEqual(["older"]);
  task.plan[0].output = "partial output\n…[持久化时已截断，完整实时输出不受影响]";
  expect(missingInspectionReceipts(task)).toEqual(receipts);
});
