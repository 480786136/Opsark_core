import { describe, expect, it } from "vitest";
import type { NextStageDecision, OpsTask, PlanStep } from "@/types";
import { taskAttemptContext } from "./attemptState";
import { allTaskSteps } from "./taskGoal";
import {
  bindRetryPrerequisites, currentPlanFingerprint, mergeRemainingPlan, operationalRecoveryContext,
  prepareOperationalDecision, reconciliationBlocker, recordExecutionUncertainty, retryBlocker, validateReconciliation,
} from "./operationalRecovery";

function step(id: string, command = "npm run build", kind: PlanStep["kind"] = "change"): PlanStep {
  return { id, title: id, description: id, kind, command, expected: "可用", validation: "test -f dist/index.html",
    status: "pending", risk: "medium" };
}
function task(): OpsTask {
  return { id: "task", serverId: "server", currentRoundId: "round", title: "部署", modelId: "model",
    status: "needs_adjustment", permission: "safe", messages: [], plan: [], createdAt: "now", updatedAt: "now" };
}
function executed(task: OpsTask, current: PlanStep, success = true, output = "observed") {
  current.attemptContext = taskAttemptContext(task);
  current.status = success ? "completed" : "failed";
  current.output = output;
  current.evidence = [{ id: `${current.id}-proof`, source: "main", type: "command-output", rawOutput: output, facts: {}, collectedAt: "now" }];
  current.result = { executionStatus: success ? "success" : "failed", observationStatus: "unknown",
    facts: { validationPassed: success, semanticAcceptanceRequired: current.kind === "change",
      semanticAcceptanceStatus: success ? "proven" : "not_met" }, warnings: [], evidenceIds: current.evidence.map(item => item.id) };
  return current;
}
function decision(steps: PlanStep[]): NextStageDecision {
  return { decision: "adjust", reason: "修复受影响范围", summary: "保留其他步骤", source: "model", steps };
}

describe("local operational recovery", () => {
  it.each(["uncertain", "incompatible", "storage_failed"] as const)("blocks writes and completion for a durable %s incident while allowing read-only investigation", kind => {
    const current = task();
    current.executionLedgerRecovery = { version: "execution-ledger-recovery@1", items: [{ kind, operationId: "op", attemptId: "attempt",
      summary: "需核对原尝试", knownFacts: ["已经进入派发"], action: "reconcile" }] };
    expect(reconciliationBlocker(current, step("write"))).toContain("持久执行记录");
    expect(reconciliationBlocker(current, step("read", "ps -ef", "observe"))).toBeUndefined();
    expect(reconciliationBlocker(current, step("fake-read", "touch /tmp/changed", "observe"))).toBeTruthy();
    expect(() => prepareOperationalDecision(current, { ...decision([]), decision: "complete" })).toThrow("未决事实");
    const context = operationalRecoveryContext(current);
    expect(context.durableExecutionRecovery?.[0]).toMatchObject({ operationId: "op", attemptId: "attempt", knownFacts: ["已经进入派发"] });
  });
  it("passes durable success into model context without treating review failure as failed deployment", () => {
    const current = task();
    current.executionLedgerRecovery = { version: "execution-ledger-recovery@1", items: [{ kind: "recorded_result", operationId: "op", attemptId: "attempt",
      summary: "主命令成功已记录", knownFacts: ["复核未完成"], action: "verify" }] };
    expect(operationalRecoveryContext(current).durableExecutionRecovery?.[0].instruction).toContain("禁止重新部署");
  });
  it("replaces only the named contiguous range and preserves pending identities and original records", () => {
    const current = task();
    current.plan = [executed(current, step("done")), step("before", "pwd", "observe"), step("replace"), step("after")];
    const original = structuredClone(current.plan);
    const proposed = { ...decision([step("repair")]), planUpdate: { basePlanFingerprint: currentPlanFingerprint(current),
      replaceStepIds: ["replace"], reason: "仅修复构建" } };
    const merged = mergeRemainingPlan(current, proposed);
    expect(merged.map(item => item.id)).toEqual(["before", "repair", "after"]);
    expect(merged[0]).toBe(current.plan[1]);
    expect(merged[2]).toBe(current.plan[3]);
    expect(current.plan).toEqual(original);
  });

  it.each(["stale", "completed", "disjoint", "duplicate", "unknown", "collision"])("rejects %s local updates", mode => {
    const current = task();
    current.plan = [executed(current, step("done")), step("a"), step("b"), step("c")];
    const proposed = { ...decision([step(mode === "collision" ? "c" : "new")]),
      planUpdate: { basePlanFingerprint: mode === "stale" ? "stale" : currentPlanFingerprint(current),
        replaceStepIds: mode === "completed" ? ["done"] : mode === "disjoint" ? ["a", "c"]
          : mode === "duplicate" ? ["a", "a"] : mode === "unknown" ? ["missing"] : ["a"], reason: "修复" } };
    expect(() => mergeRemainingPlan(current, proposed)).toThrow();
  });

  it("requires new evidence for identical failed or successful writes but not repeated reads", () => {
    const current = task();
    current.plan = [executed(current, step("old"), false)];
    expect(retryBlocker(current, step("retry"))).toContain("缺少重试依据");
    current.plan[0] = executed(current, step("old"));
    expect(retryBlocker(current, step("retry"))).toBeTruthy();
    expect(retryBlocker(current, step("read", "pwd", "observe"))).toBeUndefined();
    current.executionTargetServerId = "another-server";
    expect(retryBlocker(current, step("retry"))).toBeUndefined();
  });

  it("allows one evidenced transient retry, not another identical retry or deterministic error", () => {
    const current = task();
    const failed = executed(current, step("old"), false);
    current.plan = [failed];
    const retry = { ...step("retry"), retryBasis: { failedStepId: "old", kind: "transient" as const,
      evidenceIds: ["old-proof"], reason: "网络暂时不可用" } };
    expect(retryBlocker(current, retry)).toBeTruthy();
    failed.result!.facts.category = "network_failure";
    expect(retryBlocker(current, retry)).toBeUndefined();
    current.plan.push(executed(current, retry, false));
    retry.result!.facts.category = "network_failure";
    const again = { ...step("again"), retryBasis: { ...retry.retryBasis, failedStepId: "retry", evidenceIds: ["retry-proof"] } };
    expect(retryBlocker(current, again)).toContain("一次重试预算");
  });

  it("rejects old/forged/unchanged evidence and accepts a verified repair", () => {
    const current = task();
    const read = executed(current, step("read", "cat package.json", "observe"));
    const failed = executed(current, step("old"), false);
    current.plan = [read, failed, executed(current, step("reread", read.command, "observe"))];
    const retry = { ...step("retry"), retryBasis: { failedStepId: "old", kind: "changed_state" as const,
      evidenceIds: ["reread-proof"], reason: "检查状态" } };
    expect(retryBlocker(current, retry)).toContain("与此前观察相同");
    retry.retryBasis.evidenceIds = ["read-proof"];
    expect(retryBlocker(current, retry)).toBeTruthy();
    retry.retryBasis.evidenceIds = ["forged"];
    expect(retryBlocker(current, retry)).toBeTruthy();
    current.plan.push(executed(current, step("repair", "npm install missing-dependency")));
    retry.retryBasis.evidenceIds = ["repair-proof"];
    expect(retryBlocker(current, retry)).toBeUndefined();
  });

  it("plans repair and retry together but waits for real successful prerequisite evidence", () => {
    const current = task();
    current.plan = [executed(current, step("old"), false)];
    const proposed = decision([step("repair", "npm install missing-dependency"), {
      ...step("retry"), retryBasis: { failedStepId: "old", kind: "changed_state", evidenceIds: [], reason: "修复后重试", afterStepIndex: 1 },
    }]);
    const prepared = prepareOperationalDecision(current, proposed);
    const [repair, retry] = prepared.steps;
    current.plan.push(repair, retry);
    expect(retry.retryAfterStepId).toBe("repair");
    expect(retryBlocker(current, retry)).toContain("尚未成功验收");
    executed(current, repair, false);
    expect(retryBlocker(current, retry)).toBeTruthy();
    executed(current, repair);
    expect(retryBlocker(current, retry)).toBeUndefined();
  });

  it.each([0, 2, -1, 1.5])("rejects invalid future/self prerequisite index %s", afterStepIndex => {
    expect(() => bindRetryPrerequisites([step("repair"), { ...step("retry"), retryBasis: {
      failedStepId: "old", kind: "changed_state", reason: "repair", evidenceIds: [], afterStepIndex,
    } }])).toThrow();
  });

  it("does not trust a fabricated runtime prerequisite or incomplete retry metadata", () => {
    expect(bindRetryPrerequisites([{ ...step("retry"), retryAfterStepId: "forged" }])[0].retryAfterStepId).toBeUndefined();
    expect(() => bindRetryPrerequisites([step("repair"), { ...step("retry"), retryBasis: {
      failedStepId: "", kind: "changed_state", reason: "repair", evidenceIds: [], afterStepIndex: 1,
    } }])).toThrow();
  });

  it("persists uncertainty and permits only read-only inspection until a fresh same-target proof", () => {
    const current = task();
    current.plan = [executed(current, step("old"), false), executed(current, step("old-read", "ps -ef", "observe"))];
    recordExecutionUncertainty(current, current.plan[0], "连接丢失");
    const restored: OpsTask = JSON.parse(JSON.stringify(current));
    expect(reconciliationBlocker(restored, step("write"))).toBeTruthy();
    expect(reconciliationBlocker(restored, step("read", "ps -ef", "observe"))).toBeUndefined();
    expect(reconciliationBlocker(restored, step("fake-read", "touch /opt/changed", "observe"))).toBeTruthy();
    const proof = { incidentId: restored.executionReconciliation!.id, status: "safe_to_retry" as const,
      evidenceIds: ["old-read-proof"], reason: "进程已退出且产物未创建" };
    expect(() => validateReconciliation(restored, proof)).toThrow();
    const fresh = executed(restored, step("fresh", "ps -ef", "observe"));
    restored.plan.push(fresh);
    proof.evidenceIds = ["fresh-proof"];
    expect(validateReconciliation(restored, proof)).toEqual(proof);
    expect(validateReconciliation(restored, { ...proof, status: "still_running" })).toBeUndefined();
    expect(validateReconciliation(restored, { ...proof, status: "unknown" })).toBeUndefined();
    restored.executionTargetServerId = "other";
    expect(() => validateReconciliation(restored, proof)).toThrow();
  });

  it("cannot complete an uncertain execution or pretend a future read is already evidence", () => {
    const current = task();
    current.plan = [executed(current, step("old"), false)];
    recordExecutionUncertainty(current, current.plan[0], "超时");
    expect(() => prepareOperationalDecision(current, { ...decision([]), decision: "complete" })).toThrow();
    expect(() => prepareOperationalDecision(current, decision([step("read", "ps -ef", "observe"), step("retry")]))).toThrow();
    expect(() => prepareOperationalDecision(current, decision([step("read", "ps -ef", "observe")]))).not.toThrow();
  });

  it("accepts a verified recovery proposal atomically without mutating the incident during planning", () => {
    const current = task();
    current.plan = [executed(current, step("old"), false)];
    recordExecutionUncertainty(current, current.plan[0], "超时");
    current.plan.push(executed(current, step("check", "ps -ef", "observe")));
    const reconciliation = { incidentId: current.executionReconciliation!.id, status: "safe_to_retry" as const,
      evidenceIds: ["check-proof"], reason: "原进程已退出，目标目录无半成品" };
    const retry = { ...step("retry"), retryBasis: { failedStepId: "old", kind: "changed_state" as const,
      evidenceIds: ["check-proof"], reason: "已只读核对重试安全" } };
    const prepared = prepareOperationalDecision(current, { ...decision([retry]), reconciliation });
    expect(prepared.resolution).toEqual(reconciliation);
    expect(current.executionReconciliation!.resolution).toBeUndefined();
    current.executionReconciliation!.resolution = prepared.resolution;
    expect(reconciliationBlocker(current, retry)).toBeUndefined();
    expect(retryBlocker(current, retry)).toBeUndefined();
  });

  it("does not create uncertainty for an undispatched write or overwrite an unresolved incident", () => {
    const current = task();
    const failed = executed(current, step("old"), false);
    failed.result!.facts.commandDispatched = false;
    recordExecutionUncertainty(current, failed, "未发送");
    expect(current.executionReconciliation).toBeUndefined();
    failed.result!.facts.commandDispatched = true;
    recordExecutionUncertainty(current, failed, "已发送");
    const incident = structuredClone(current.executionReconciliation);
    recordExecutionUncertainty(current, step("other"), "其他错误");
    expect(current.executionReconciliation).toEqual(incident);
  });

  it("invalidates old state after mutation and keeps the latest status for a carried pending step", () => {
    const current = task();
    const read = executed(current, step("read", "pwd", "observe"));
    const build = executed(current, step("build"));
    current.plan = [read, build];
    expect(operationalRecoveryContext(current).recentAttempts.every(item => !item.currentStateEvidence)).toBe(true);
    current.plan.push(executed(current, step("fresh", "ls dist", "observe")));
    expect(operationalRecoveryContext(current).recentAttempts.slice(-1)[0]?.currentStateEvidence).toBe(true);
    current.phaseHistory = [{ id: "phase", roundId: "round", plan: [{ ...read, status: "pending" }],
      createdAt: "now", completedAt: "now", reason: "adjustment", requirement: "部署" }];
    expect(allTaskSteps(current).find(item => item.id === "read")?.status).toBe("completed");
  });
});
