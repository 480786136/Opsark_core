import { describe, expect, it } from "vitest";
import type { ExecutionIntentSemantic, NextStageDecision, OpsTask, PlanStep, TaskHistoryIssue } from "@/types";
import { executionDigest } from "./planPreparation";
import { textFingerprint } from "./longRunningReviewOutput";
import { currentRequestCompleted, prepareTaskDecision, resolvedTaskIssue, stepHasResolvedIssue } from "./taskDecisionResolution";

const at = (minute: number) => `2026-09-29T10:${String(minute).padStart(2, "0")}:00.000Z`;
const context = (round = "round-1", target = "server") => JSON.stringify([target, round, "", 0, 0]);
function step(id: string, minute: number, options: { path?: string; change?: boolean; failed?: boolean; target?: string; username?: string } = {}): PlanStep {
  const path = options.path ?? "/opt/core-case", target = options.target ?? "server";
  const semantic: ExecutionIntentSemantic = { taskId: "task", stepId: id,
    action: { type: "tool", toolId: options.change ? "core.sftp.delete" : "files.read_content", arguments: { path } },
    targets: [{ role: "execution", serverId: target, host: "server.example", port: 22, username: options.username ?? "root", path }],
    kind: options.change ? "change" : "observe", effect: options.change ? "change" : "read", risk: "low",
    expected: "项目资源已验证", dependencies: { precedingStepIds: [] }, permission: "managed", policyVersion: "test@1" };
  return { id, title: id, description: "", command: "", action: semantic.action, kind: semantic.kind, risk: "low",
    expected: semantic.expected, validation: "", validationScope: "isolated_exec", status: options.failed ? "failed" : "completed",
    attemptContext: context("round-1", target), startedAt: at(minute),
    executionIntent: { version: "execution-intent@1", algorithm: "sha256", semantic,
      digest: executionDigest({ version: "execution-intent@1", semantic }) },
    result: { executionStatus: options.failed ? "failed" : "success", observationStatus: "unknown", evidenceIds: [`proof-${id}`],
      facts: { commandDispatched: true }, warnings: [] },
    evidence: [{ id: `proof-${id}`, type: "command-output", source: "main", facts: { exitCode: options.failed ? 1 : 0 },
      rawOutput: options.failed ? "original failure" : "observed actual state", collectedAt: at(minute),
      scope: { targetId: target, scope: "isolated_exec", persistence: "command", doesNotProve: [] } }] };
}
function task(): OpsTask {
  const failed = step("failed", 1, { failed: true, change: true }), read = step("read", 2);
  const issue: TaskHistoryIssue = { issueId: "issue-a", stepId: failed.id, title: failed.title, status: "failed",
    commandFingerprint: textFingerprint(failed.command), attemptContext: failed.attemptContext, attemptCount: 1,
    evidenceIds: ["proof-failed"], countedAttemptKeys: ["attempt-failed"], recoveryContract: { roundId: "round-1", step: failed } };
  return { id: "task", serverId: "server", title: "Deploy", status: "running", permission: "managed", modelId: "model",
    currentRoundId: "round-1", createdAt: at(0), updatedAt: at(2), messages: [], plan: [failed, read],
    historyCheckpoint: { version: 2, sourceRoundCount: 1, sourcePhaseCount: 1, sourceStepCount: 1,
      statusCounts: { failed: 1 }, verifiedFacts: [], unresolvedIssues: [issue], phaseSummaries: [],
      sourceHistoryFingerprint: "original-history", updatedAt: at(1) },
    requirementLifecycle: { version: 1, revision: 1, focus: { roundId: "round-1", sourceMessageId: "root-message", requirementIds: ["deploy"] },
      items: [{ id: "deploy", kind: "goal", content: "部署网站", status: "active", evidenceIds: [],
        source: { content: "部署网站", source: "user_message", relation: "new_goal", sourceMessageId: "root-message", createdAt: at(0) } }] } };
}
function decision(withResolution = false): NextStageDecision {
  return { decision: "complete", reason: "真实证据已取得", summary: "本轮完成", source: "model", steps: [],
    requirementReview: { baseRevision: 1, roundId: "round-1", focusOutcome: "completed", overallOutcome: "completed",
      items: [{ requirementId: "deploy", outcome: "satisfied", evidenceIds: ["proof-read"], reason: "目标资源已验收" }] },
    ...(withResolution ? { issueResolutions: [{ issueId: "issue-a", evidenceIds: ["proof-read"], reason: "独立检查确认目标资源已恢复" }] } : {}) };
}

describe("task decision evidence and historical issue receipts", () => {
  it("persists an exact historical resolution and leaves the failed execution unchanged", () => {
    const current = task(), originalFailure = JSON.stringify(current.plan[0]);
    const prepared = prepareTaskDecision(current, decision(true));
    expect(current.issueResolutions).toBeUndefined();
    Object.assign(current, prepared);
    expect(currentRequestCompleted(current)).toBe(true);
    expect(prepared.issueResolutions[0]).toMatchObject({ issueFingerprint: expect.stringMatching(/^sha256:/),
      evidenceBindings: [{ evidenceId: "proof-read", stepId: "read", attemptContext: context(), fingerprint: expect.stringMatching(/^sha256:/) }] });
    const restored = JSON.parse(JSON.stringify(current)) as OpsTask;
    expect(resolvedTaskIssue(restored, restored.historyCheckpoint!.unresolvedIssues[0])).toBeDefined();
    expect(stepHasResolvedIssue(restored, restored.plan[0])).toBe(true);
    expect(JSON.stringify(current.plan[0])).toBe(originalFailure);
    expect(restored.plan[0].status).toBe("failed");
  });

  it("requires post-failure read evidence while allowing a different verification command", () => {
    const current = task();
    current.plan[1].command = "a different read-only verification";
    expect(prepareTaskDecision(current, decision(true)).issueResolutions).toHaveLength(1);
    current.plan[1].evidence![0].collectedAt = at(0);
    delete current.requirementLifecycle;
    const proposal = decision(true); delete proposal.requirementReview;
    expect(() => prepareTaskDecision(current, proposal)).toThrow("晚于原失败");
  });

  it.each(["foreign_resource", "changed_account", "write_only", "unknown_target", "cancelled", "blocked"] as const)
    ("rejects %s evidence as a resolution", mode => {
      const current = task();
      if (mode === "foreign_resource") current.plan[1] = step("read", 2, { path: "/etc/unrelated" });
      if (mode === "changed_account") current.plan[1] = step("read", 2, { username: "other-user" });
      if (mode === "write_only") current.plan[1] = step("read", 2, { change: true });
      if (mode === "unknown_target") delete current.plan[1].attemptContext;
      if (mode === "cancelled" || mode === "blocked") current.plan[1].result!.executionStatus = mode;
      expect(() => prepareTaskDecision(current, decision(true))).toThrow();
    });

  it.each(["changed_evidence", "changed_issue", "changed_acceptance", "missing_proof", "missing_bindings", "duplicate_evidence_id"] as const)
    ("does not trust a persisted resolution after %s", mode => {
      const current = task();
      Object.assign(current, prepareTaskDecision(current, decision(true)));
      if (mode === "changed_evidence") current.plan[1].evidence![0].rawOutput = "other output";
      if (mode === "changed_issue") current.historyCheckpoint!.unresolvedIssues[0].countedAttemptKeys!.push("new-attempt");
      if (mode === "changed_acceptance") current.historyCheckpoint!.unresolvedIssues[0].recoveryContract!.step.expected = "different acceptance";
      if (mode === "missing_proof") current.plan = current.plan.slice(0, 1);
      if (mode === "missing_bindings") delete (current.issueResolutions![0] as Partial<NonNullable<OpsTask["issueResolutions"]>[number]>).evidenceBindings;
      if (mode === "duplicate_evidence_id") {
        const duplicate = step("foreign", 3);
        duplicate.result!.evidenceIds = ["proof-read"]; duplicate.evidence![0].id = "proof-read";
        current.plan.push(duplicate);
      }
      expect(resolvedTaskIssue(current, current.historyCheckpoint!.unresolvedIssues[0])).toBeUndefined();
    });

  it("retains the historical handling fact after another change but invalidates the old current-state evidence", () => {
    const current = task();
    Object.assign(current, prepareTaskDecision(current, decision(true)));
    current.plan.push(step("delete-again", 3, { change: true }));
    expect(resolvedTaskIssue(current, current.historyCheckpoint!.unresolvedIssues[0])).toBeDefined();
    const proposal = decision(); proposal.requirementReview!.baseRevision = 2;
    expect(() => prepareTaskDecision(current, proposal)).toThrow();
    expect(current.plan[0].status).toBe("failed");
  });

  it("never transfers a resolution receipt to another task with the same requested goal", () => {
    const current = task();
    Object.assign(current, prepareTaskDecision(current, decision(true)));
    const another = JSON.parse(JSON.stringify(current)) as OpsTask;
    another.id = "another-task";
    // Legacy projections can lack frozen intents; task identity is still required.
    for (const oldStep of another.plan) delete oldStep.executionIntent;
    expect(resolvedTaskIssue(another, another.historyCheckpoint!.unresolvedIssues[0])).toBeUndefined();
  });

  it("does not invalidate a completed project for an unrelated path change on the same server", () => {
    const current = task();
    current.plan.push(step("other-project", 3, { change: true, path: "/opt/other-project" }));
    expect(prepareTaskDecision(current, decision()).currentRequestReview?.completed).toBe(true);
  });

  it("does not let pre-request evidence complete a new or reactivated requirement", () => {
    for (const mode of ["new", "reactivated"] as const) {
      const current = task();
      const requirement = current.requirementLifecycle!.items[0];
      if (mode === "new") requirement.source.createdAt = at(3);
      else requirement.lastChangedAt = at(3);
      expect(() => prepareTaskDecision(current, decision())).toThrow("提出或重新激活后");
      current.plan[1].evidence![0].collectedAt = at(4);
      expect(prepareTaskDecision(current, decision()).currentRequestReview?.completed).toBe(true);
    }
  });

  it("may reuse applicable evidence when the user continues the unchanged original requirement", () => {
    const current = task();
    current.currentRoundId = "round-2";
    current.requirementLifecycle!.focus.roundId = "round-2";
    current.messages.push({ id: "continue-message", role: "user", kind: "message", content: "继续", createdAt: at(3) });
    const proposal = decision(); proposal.requirementReview!.roundId = "round-2";
    expect(prepareTaskDecision(current, proposal).currentRequestReview?.completed).toBe(true);
  });

  it("invalidates nested path evidence after a dispatched failed mutation, including a cancelled partial result", () => {
    const current = task(); current.plan[1] = step("read", 2, { path: "/opt/core-case/dist/index.html" });
    const mutation = step("partial-delete", 3, { change: true, failed: true });
    mutation.result!.executionStatus = "cancelled";
    current.plan.push(mutation);
    expect(() => prepareTaskDecision(current, decision())).toThrow();
    mutation.result!.facts.commandDispatched = false;
    expect(prepareTaskDecision(current, decision()).currentRequestReview?.completed).toBe(true);
  });
});
