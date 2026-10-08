import { describe, expect, it } from "vitest";
import type { OpsTask, PlanStep } from "@/types";
import { toolFailureFallback, failedToolRetryBlocker, toolFallbackContext } from "./toolFallback";

const context = (target = "server") => JSON.stringify([target, "round", "", 0, 0]);
const task = { id: "task", serverId: "server", plan: [], messages: [] } as unknown as OpsTask;
const blocker = (current: OpsTask, next: PlanStep, history: PlanStep[]) =>
  failedToolRetryBlocker({ ...current, plan: history }, next, history);
function failed(): PlanStep {
  return { id: "failed", title: "检查目录", description: "", command: "", validation: "", expected: "目录内容", risk: "low", kind: "observe",
    action: { type: "tool", toolId: "files.get_structure", arguments: { rootPath: "/app", maxDepth: 4, maxNodes: 600, includeHidden: false } },
    status: "failed", attemptContext: context(), startedAt: "2026-09-30T00:00:00Z", result: { executionStatus: "failed", observationStatus: "unknown", warnings: [], evidenceIds: [],
      facts: { category: "timeout", attempts: [{ number: 1 }, { number: 2 }, { number: 3 }] } } };
}
function candidate(): PlanStep {
  return { ...failed(), id: "retry", status: "pending", result: undefined,
    action: { type: "tool", toolId: "files.get_structure", arguments: { rootPath: "/app" } } };
}
function proof(): PlanStep {
  return { ...failed(), id: "proof", status: "completed", action: { type: "shell", command: "test -d /app" }, command: "test -d /app", output: "current state",
    result: { executionStatus: "success", observationStatus: "matched", warnings: [], evidenceIds: ["proof-e"], facts: { commandDispatched: true } },
    evidence: [{ id: "proof-e", type: "command-output", source: "main", rawOutput: "current state", facts: {}, collectedAt: "2026-09-30T00:01:00Z",
      scope: { targetId: "server", scope: "isolated_exec", persistence: "command", doesNotProve: [] } }] };
}

describe("failed tool replacement and retry scope", () => {
  it("compares normalized arguments so omitted defaults cannot reset the retry budget", () => {
    expect(blocker(task, candidate(), [failed()])).toContain("同参数调用已失败");
  });
  it("permits a changed argument set or a different target without inheriting the old retry blockade", () => {
    const next = candidate();
    if (next.action?.type === "tool") next.action.arguments.rootPath = "/other";
    expect(blocker(task, next, [failed()])).toBeUndefined();
    expect(blocker({ ...task, executionTargetServerId: "other" }, candidate(), [failed()])).toBeUndefined();
    expect(toolFallbackContext({ ...task, executionTargetServerId: "other" }, [failed()])).toBeUndefined();
  });
  it("requires genuinely newer successful evidence for the same call instead of a fresh transient budget", () => {
    const old = failed(), next = candidate(), fresh = proof();
    next.retryBasis = { failedStepId: old.id, kind: "transient", reason: "再试一次", evidenceIds: ["proof-e"] };
    expect(blocker(task, next, [old, fresh])).toBeTruthy();
    next.retryBasis.kind = "changed_state";
    expect(blocker(task, next, [old, fresh])).toBeUndefined();
    expect(blocker(task, next, [fresh, old])).toBeTruthy();
    fresh.attemptContext = context("other");
    expect(blocker(task, next, [old, fresh])).toBeTruthy();
  });
  it("does not accept another copy of an old observation as changed-state evidence", () => {
    const next = candidate();
    next.retryBasis = { failedStepId: "failed", kind: "changed_state", reason: "又看了一次", evidenceIds: ["proof-e"] };
    const earlier = { ...proof(), id: "earlier" };
    expect(blocker(task, next, [earlier, failed(), proof()])).toBeTruthy();
  });
  it.each(["missing_scope", "stale_time", "missing_failure_time", "local_context"])("does not unlock a failed call with %s evidence", mode => {
    const old = failed(), fresh = proof(), next = candidate();
    next.retryBasis = { failedStepId: "failed", kind: "changed_state", reason: "已有新检查", evidenceIds: ["proof-e"] };
    if (mode === "missing_scope") delete fresh.evidence![0].scope;
    if (mode === "stale_time") fresh.evidence![0].collectedAt = old.startedAt!;
    if (mode === "missing_failure_time") delete old.startedAt;
    if (mode === "local_context") {
      fresh.action = { type: "tool", toolId: "evidence.read", arguments: { evidenceId: "archived" } };
      delete fresh.evidence![0].scope;
    }
    expect(blocker(task, next, [old, fresh])).toBeTruthy();
  });
  it.each(["server.resolve_connection", "secret.merge_command", "evidence.read", "user.request_input", "server.connect", "files.transfer_between_servers"])
    ("never grants a tool bypass for %s", toolId => {
      const step = failed(); step.action = { type: "tool", toolId, arguments: {} };
      expect(toolFailureFallback(step)).toBeUndefined();
    });
  it("does not mark a read timeout replaceable until its existing finite retries are exhausted", () => {
    const step = failed(); step.result!.facts.attempts = [{ number: 1 }, { number: 2 }];
    expect(toolFailureFallback(step)).toBeUndefined();
  });
});
