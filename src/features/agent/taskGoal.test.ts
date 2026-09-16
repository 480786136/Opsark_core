import { describe, expect, it } from "vitest";
import {
  activeRoundSteps,
  allTaskSteps,
  archiveActivePhase,
  beginRequirementRound,
  capturePreviousRound,
  commitPreviousRound,
  mergeTaskSkillIds,
  normalizeRequirementRelation,
  taskGoal,
} from "@/features/agent/taskGoal";
import { buildTaskDecisionSnapshot } from "@/features/agent/taskDecisionSnapshot";
import { initializeTaskHistoryCheckpoint, refreshTaskHistoryCheckpoint } from "./taskHistoryCheckpoint";
import { textFingerprint } from "./longRunningReviewOutput";
import { recoveryHistory, unresolvedRecoveryBlockers, validateRecoveryReferences } from "./recoveryContract";
import { taskAttemptContext } from "./attemptState";
import type { OpsTask, PlanStep } from "@/types";

function step(id: string, status: PlanStep["status"] = "completed"): PlanStep {
  return {
    id,
    title: id,
    description: id,
    command: `echo ${id}`,
    expected: id,
    validation: "true",
    risk: "low",
    status,
  };
}

function task(): OpsTask {
  return {
    id: "task-1",
    serverId: "server-1",
    title: "部署 office",
    rootGoal: "帮我部署 office 项目",
    currentInstruction: "继续部署",
    currentRoundId: "round-1",
    status: "completed",
    permission: "managed",
    modelId: "model-1",
    messages: [
      { id: "m1", role: "user", kind: "message", content: "帮我部署 office 项目", createdAt: "2026-01-01" },
      { id: "m2", role: "user", kind: "message", content: "重试", createdAt: "2026-01-02" },
    ],
    plan: [step("composer")],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
  };
}

describe("task goal lifecycle", () => {
  it("carries a failed attempt explicitly across rounds and keeps its original acceptance after persistence", () => {
    const current = task();
    const originalContext = taskAttemptContext(current);
    current.plan = [{ ...step("failed-install", "failed"), kind: "change", command: "install artifact",
      validation: "test -f /opt/app/artifact", expected: "artifact exists", attemptContext: originalContext,
      result: { executionStatus: "failed", observationStatus: "unknown", exitCode: 1,
        facts: { blockingSignal: true }, warnings: [], evidenceIds: [] } }];
    beginRequirementRound(current, "round-2", capturePreviousRound(current));
    const verify: PlanStep = { ...step("verify"), kind: "observe", command: "test -f /opt/app/artifact",
      expected: "artifact exists", validation: "", status: "pending",
      recovery: { failedStepId: "failed-install", targetContext: originalContext, purpose: "verify" } };
    current.plan = [verify];
    const restored = JSON.parse(JSON.stringify(current)) as OpsTask;
    const currentContext = taskAttemptContext(restored);
    expect(() => validateRecoveryReferences(recoveryHistory(restored), restored.plan, currentContext)).not.toThrow();
    expect(unresolvedRecoveryBlockers(restored).map(step => step.id)).toEqual(["failed-install"]);
    expect(() => validateRecoveryReferences(recoveryHistory(restored), [{ ...verify, command: "true" }], currentContext))
      .toThrow("RECOVERY_ACCEPTANCE_MISMATCH");
    expect(() => validateRecoveryReferences(recoveryHistory({ ...restored, id: "other-task" }), restored.plan, currentContext))
      .toThrow("RECOVERY_TARGET_MISMATCH");
    expect(() => validateRecoveryReferences(recoveryHistory(restored), restored.plan,
      JSON.stringify(["another-server", "round-2", "session-new", 3, 2]))).toThrow("RECOVERY_TARGET_MISMATCH");
    expect(() => validateRecoveryReferences(recoveryHistory({ ...restored, recoveryCarryForwards: [] }), restored.plan, currentContext))
      .toThrow("RECOVERY_TARGET_MISMATCH");
    // Binding is rebuilt from the restored task, never from model metadata.
    const completed = restored.plan[0];
    completed.status = "completed";
    completed.attemptContext = currentContext;
    completed.result = { executionStatus: "success", observationStatus: "matched", exitCode: 0,
      facts: {}, warnings: [], evidenceIds: ["verify-evidence"] };
    completed.evidence = [{ id: "verify-evidence", type: "command", source: "main", facts: {}, rawOutput: "",
      collectedAt: "2026-09-16T01:00:00Z" }];
    expect(unresolvedRecoveryBlockers(restored)).toEqual([]);
    expect(buildTaskDecisionSnapshot(restored).historyCheckpoint?.unresolvedIssues).toEqual([]);
    beginRequirementRound(restored, "round-3", capturePreviousRound(restored));
    restored.plan = [];
    expect(unresolvedRecoveryBlockers(restored)).toEqual([]);
    expect(restored.planHistory?.[0].plan[0].attemptContext).toBe(originalContext);
  });

  it("round capture ignores pure continue and side-question messages", () => {
    const current = task();
    current.messages = [current.messages[0],
      { ...current.messages[1], content: "继续完成", requirementRelation: "continue" },
      { ...current.messages[1], id: "side", content: "进展如何", requirementRelation: "side_question" }];
    expect(capturePreviousRound(current)?.history.requirement).toBe("帮我部署 office 项目");
  });

  it("rejects a pending plan that reuses an executed failure id, including a persisted collision", () => {
    const current = task();
    const failed = { ...step("reused-id", "failed"), attemptContext: taskAttemptContext(current) };
    current.phaseHistory = [{ id: "phase-original", roundId: current.currentRoundId!, requirement: "目标", reason: "adjustment",
      plan: [failed], createdAt: "before", completedAt: "now" }];
    current.plan = [{ ...step("reused-id", "pending"), kind: "observe", command: "uname -a", validation: "" }];
    const history = recoveryHistory(current);
    expect(history.find(item => item.id === "reused-id")?.status).toBe("failed");
    expect(() => validateRecoveryReferences(history, current.plan, taskAttemptContext(current))).toThrow("PLAN_ATTEMPT_ID_REUSED");
  });
  it("retains distinct unresolved issues and never resolves a different target by command text", () => {
    const current = task();
    const closeRound = (date: string) => {
      const snapshot = capturePreviousRound(current, date)!;
      snapshot.history.id = date;
      commitPreviousRound(current, snapshot);
    };
    current.plan = Array.from({ length: 10 }, (_, index) => ({ ...step(`failure-${index}`, "failed"),
      attemptContext: "server-a", command: `check-${index}` }));
    closeRound("2026-01-03");
    expect(current.historyCheckpoint?.unresolvedIssues).toHaveLength(10);
    current.plan = [{ ...step("recheck"), command: "check-0", attemptContext: "server-b",
      result: { executionStatus: "success", observationStatus: "matched", facts: {}, warnings: [], evidenceIds: ["proof"] },
      evidence: [{ id: "proof", type: "command-output", source: "main", facts: {}, rawOutput: "ok", collectedAt: "now" }],
    }];
    closeRound("2026-01-04");
    expect(current.historyCheckpoint?.unresolvedIssues).toHaveLength(10);
    current.plan[0].attemptContext = "server-a";
    closeRound("2026-01-05");
    expect(current.historyCheckpoint?.unresolvedIssues).toHaveLength(9);
    expect(buildTaskDecisionSnapshot(current).historyCheckpoint?.unresolvedIssues).toHaveLength(9);
  });

  it("does not turn a successful unknown observation into an unresolved incident without an explicit warning", () => {
    const current = task();
    current.plan = [{
      ...step("successful-unknown"),
      output: "command completed",
      result: {
        executionStatus: "success",
        observationStatus: "unknown",
        exitCode: 0,
        facts: { commandCompleted: true, blockingSignal: false, evidenceConflict: false },
        warnings: [],
        evidenceIds: ["successful-unknown-proof"],
      },
      evidence: [{
        id: "successful-unknown-proof",
        type: "command-output",
        source: "main",
        facts: { exitCode: 0 },
        rawOutput: "command completed",
        collectedAt: "now",
      }],
    }];
    const snapshot = capturePreviousRound(current, "2026-01-03")!;
    snapshot.history.id = "successful-unknown-round";
    commitPreviousRound(current, snapshot);

    expect(current.historyCheckpoint?.verifiedFacts.map(({ stepId }) => stepId))
      .toContain("successful-unknown");
    expect(current.historyCheckpoint?.unresolvedIssues).toEqual([]);
    expect(buildTaskDecisionSnapshot(current).currentIncident).toBeUndefined();

    const blocked = task();
    blocked.plan = [{
      ...current.plan[0],
      id: "successful-unknown-with-blocker",
      result: {
        ...current.plan[0].result!,
        facts: { commandCompleted: true, blockingSignal: true },
      },
    }];
    const blockedSnapshot = capturePreviousRound(blocked, "2026-01-04")!;
    blockedSnapshot.history.id = "successful-unknown-blocked-round";
    commitPreviousRound(blocked, blockedSnapshot);
    expect(blocked.historyCheckpoint?.unresolvedIssues).toMatchObject([{
      stepId: "successful-unknown-with-blocker",
    }]);
    expect(buildTaskDecisionSnapshot(blocked).currentIncident?.stepId)
      .toBe("successful-unknown-with-blocker");
  });

  it("retains every unresolved issue, bounds only model details and coalesces target-specific retries", () => {
    const current = task();
    const closeRound = (id: string) => {
      const snapshot = capturePreviousRound(current, `${id}T00:00:00.000Z`)!;
      snapshot.history.id = id;
      commitPreviousRound(current, snapshot);
    };
    current.plan = Array.from({ length: 20 }, (_, index) => ({
      ...step(`bounded-failure-${index}`, "failed"),
      attemptContext: "server-a",
      command: `bounded-check-${index}`,
    }));
    closeRound("2026-02-01");

    expect(current.historyCheckpoint?.unresolvedIssues).toHaveLength(20);
    expect(current.historyCheckpoint?.unresolvedIssues.map(({ stepId }) => stepId))
      .toEqual(Array.from({ length: 20 }, (_, index) => `bounded-failure-${index}`));
    const projected = buildTaskDecisionSnapshot(current).historyCheckpoint!;
    expect(projected.unresolvedIssues).toHaveLength(16);
    expect(projected.unresolvedIssueIndex).toHaveLength(20);
    expect(projected.omittedUnresolvedDetails).toBe(4);
    expect(projected.unresolvedIssueIndex[0]).toMatchObject({
      stepId: "bounded-failure-0", ledgerRef: { available: true },
    });
    expect(projected.sourcePhaseFingerprints).toBeUndefined();

    current.plan = [{
      ...step("bounded-failure-retry", "failed"),
      attemptContext: "server-a",
      command: "bounded-check-19",
    }];
    closeRound("2026-02-02");
    const issues = current.historyCheckpoint?.unresolvedIssues ?? [];
    const retry = issues[issues.length - 1];
    expect(current.historyCheckpoint?.unresolvedIssues).toHaveLength(20);
    expect(retry).toMatchObject({ stepId: "bounded-failure-retry", attemptCount: 2 });
    expect(new Set(current.historyCheckpoint?.unresolvedIssues.map(({ commandFingerprint, attemptContext }) =>
      `${attemptContext}:${commandFingerprint}`)).size).toBe(20);
  });

  it("migrates a complete version 1 ledger, removes false unknown issues and never replays counts", () => {
    const current = task();
    current.plan = [{ ...step("legacy-unknown"),
      result: { executionStatus: "success", observationStatus: "unknown", exitCode: 0,
        facts: {}, warnings: [], evidenceIds: [] },
    }, { ...step("real-failure", "failed"), command: "inspect failed state" }];
    const round = capturePreviousRound(current, "2026-04-01")!;
    round.history.id = "legacy-round";
    commitPreviousRound(current, round);
    const checkpoint = current.historyCheckpoint!;
    checkpoint.version = 1;
    delete checkpoint.sourcePhaseFingerprints;
    checkpoint.unresolvedIssues.unshift({ stepId: "legacy-unknown", title: "old false incident", status: "completed",
      commandFingerprint: textFingerprint("echo legacy-unknown"), attemptCount: 1 });
    current.plan = [];

    initializeTaskHistoryCheckpoint(current);
    expect(current.historyCheckpoint).toMatchObject({ version: 2, sourcePhaseCount: 1, sourceStepCount: 2,
      migration: { ledgerCoverage: "complete", countsExact: true, requiresReview: false } });
    expect(current.historyCheckpoint?.unresolvedIssues.map(issue => issue.stepId)).toEqual(["real-failure"]);
    const stable = JSON.stringify(current.historyCheckpoint);
    refreshTaskHistoryCheckpoint(current);
    refreshTaskHistoryCheckpoint(current);
    buildTaskDecisionSnapshot(current);
    expect(JSON.stringify(current.historyCheckpoint)).toBe(stable);
    expect(current.historyCheckpoint?.unresolvedIssues[0].attemptCount).toBe(1);
  });

  it("preserves legacy issues when persisted raw evidence is missing and exposes the coverage gap", () => {
    const current = task();
    current.plan = [step("missing-source", "failed")];
    const round = capturePreviousRound(current, "2026-04-02")!;
    commitPreviousRound(current, round);
    current.historyCheckpoint!.version = 1;
    delete current.historyCheckpoint!.sourcePhaseFingerprints;
    current.planHistory = [];
    current.plan = [];

    const projected = buildTaskDecisionSnapshot(current).historyCheckpoint!;
    expect(projected.migration).toMatchObject({ ledgerCoverage: "partial", missingPhaseCount: 1,
      missingStepCount: 1, countsExact: false, requiresReview: true });
    expect(projected.unresolvedIssues).toMatchObject([{ stepId: "missing-source", verificationState: "needs_review" }]);
    expect(projected.unresolvedIssueIndex[0].ledgerRef.available).toBe(false);
    const stable = JSON.stringify(current.historyCheckpoint);
    refreshTaskHistoryCheckpoint(current);
    expect(JSON.stringify(current.historyCheckpoint)).toBe(stable);
  });

  it("does not treat a legacy completed step without a structured result as disproving its old incident", () => {
    const current = task();
    current.plan = [step("legacy-no-result")];
    const round = capturePreviousRound(current, "2026-04-03")!;
    commitPreviousRound(current, round);
    current.historyCheckpoint!.version = 1;
    current.historyCheckpoint!.unresolvedIssues = [{ stepId: "legacy-no-result", title: "needs verification",
      status: "completed", commandFingerprint: textFingerprint("echo legacy-no-result"), attemptCount: 1 }];
    const migrated = initializeTaskHistoryCheckpoint(current)!;
    expect(migrated.migration).toMatchObject({ ledgerCoverage: "complete", requiresReview: true });
    expect(migrated.unresolvedIssues).toMatchObject([{ verificationState: "needs_review" }]);
  });

  it("merges each immutable archived phase once even when refresh revisits the entire ledger", () => {
    const current = task();
    for (let index = 0; index < 5; index += 1) {
      current.plan = [{ ...step(`attempt-${index}`, "failed"), attemptContext: "target", command: "inspect state" }];
      archiveActivePhase(current, "adjustment", `2026-05-0${index + 1}`);
    }
    const checkpoint = current.historyCheckpoint!;
    expect(checkpoint).toMatchObject({ sourcePhaseCount: 3, sourceStepCount: 3 });
    expect(checkpoint.unresolvedIssues[0].attemptCount).toBe(3);
    const stable = JSON.stringify(checkpoint);
    refreshTaskHistoryCheckpoint(current);
    refreshTaskHistoryCheckpoint(current);
    expect(JSON.stringify(current.historyCheckpoint)).toBe(stable);
  });

  it("counts an executed failure once when later phase snapshots retain the same attempts", () => {
    const current = task();
    const attempts = ["first-attempt", "second-attempt"].map(id => ({
      ...step(id, "failed"), attemptContext: "target", command: "inspect state",
    }));
    for (let index = 0; index < 5; index += 1) {
      current.plan = attempts;
      archiveActivePhase(current, "adjustment", `2026-05-${index + 10}`);
    }
    expect(current.historyCheckpoint?.sourcePhaseCount).toBe(3);
    expect(current.historyCheckpoint?.unresolvedIssues).toMatchObject([{
      stepId: "second-attempt", attemptCount: 2,
    }]);
    expect(current.historyCheckpoint?.unresolvedIssues[0].countedAttemptKeys).toHaveLength(2);
    expect(JSON.stringify(buildTaskDecisionSnapshot(current).historyCheckpoint)).not.toContain("countedAttemptKeys");
  });

  it("clears an indexed failure only after its explicitly related acceptance verification succeeds", () => {
    const current = task();
    const failure = { ...step("failed-build", "failed"), kind: "change" as const,
      attemptContext: "target-a", command: "build application", validation: "test -f /opt/a/ready" };
    const close = (id: string) => {
      const round = capturePreviousRound(current, id)!;
      round.history.id = id;
      commitPreviousRound(current, round);
    };
    current.plan = [failure];
    close("2026-06-01");
    const verify: PlanStep = { ...step("verify-build"), kind: "observe", attemptContext: "target-a",
      command: failure.validation, validation: "", expected: failure.expected,
      recovery: { failedStepId: failure.id, targetContext: "target-a", purpose: "verify" },
      result: { executionStatus: "success", observationStatus: "matched", exitCode: 0,
        facts: {}, warnings: [], evidenceIds: [] } };
    current.plan = [verify];
    close("2026-06-02");
    expect(current.historyCheckpoint?.unresolvedIssues).toHaveLength(1);
    verify.result!.evidenceIds = ["acceptance"];
    verify.evidence = [{ id: "acceptance", type: "command-output", source: "main", facts: {}, rawOutput: "ok", collectedAt: "now" }];
    verify.attemptContext = "target-b";
    close("2026-06-03");
    expect(current.historyCheckpoint?.unresolvedIssues).toHaveLength(1);
    verify.attemptContext = "target-a";
    const currentProjection = buildTaskDecisionSnapshot(current).historyCheckpoint!;
    expect(currentProjection.unresolvedIssueIndex).toEqual([]);
    expect(currentProjection.resolvedByRecentEvidence).toMatchObject([{
      stepId: failure.id, verifiedByStepId: verify.id,
    }]);
    expect(current.historyCheckpoint?.unresolvedIssues).toHaveLength(1); // Stored checkpoint still describes its archived prefix.
    close("2026-06-04");
    expect(current.historyCheckpoint?.unresolvedIssues).toEqual([]);
  });

  it("does not clear a failure when a replanned step reuses its id for another target", () => {
    const current = task();
    const closeRound = (id: string) => {
      const snapshot = capturePreviousRound(current, `${id}T00:00:00.000Z`)!;
      snapshot.history.id = id;
      commitPreviousRound(current, snapshot);
    };
    current.plan = [{
      ...step("reused-step", "failed"),
      attemptContext: "server-a",
      command: "check-original-target",
    }];
    closeRound("2026-03-01");

    current.plan = [{
      ...step("reused-step", "skipped"),
      attemptContext: "server-b",
      command: "check-different-target",
    }];
    closeRound("2026-03-02");

    expect(current.historyCheckpoint?.unresolvedIssues).toMatchObject([{
      stepId: "reused-step",
      attemptContext: "server-a",
    }]);

    current.plan = [{
      ...step("reused-step", "failed"),
      attemptContext: "server-b",
      command: "check-different-target",
    }];
    closeRound("2026-03-03");

    expect(current.historyCheckpoint?.unresolvedIssues.map(({ attemptContext }) => attemptContext))
      .toEqual(["server-a", "server-b"]);
  });

  it("keeps the root goal instead of replacing it with retry text", () => {
    expect(taskGoal(task())).toBe("帮我部署 office 项目");
  });

  it("preserves superseded adjustment phases in the complete evidence ledger", () => {
    const current = task();
    current.pauseReason = "依赖已安装，但服务尚未启动。";
    archiveActivePhase(current, "adjustment", "2026-01-03T00:00:00.000Z");
    current.plan = [step("web-server", "pending")];

    expect(current.phaseHistory?.[0]?.summary).toBe("依赖已安装，但服务尚未启动。");
    expect(activeRoundSteps(current).map(({ id }) => id)).toEqual(["composer", "web-server"]);
    expect(allTaskSteps(current).map(({ id }) => id)).toEqual(["composer", "web-server"]);

    const snapshot = capturePreviousRound(current, "2026-01-04T00:00:00.000Z");
    commitPreviousRound(current, snapshot);
    expect(current.planHistory?.[0]?.phases?.[0]).toMatchObject({
      reason: "adjustment",
      summary: "依赖已安装，但服务尚未启动。",
    });
    expect(current.planHistory?.[0]?.finalPlan?.map(({ id }) => id)).toEqual(["web-server"]);
    expect(current.phaseHistory).toEqual([]);
  });

  it("keeps two recent phases detailed and rolls older evidence into a bounded checkpoint", () => {
    const current = task();
    for (let index = 1; index <= 4; index += 1) {
      current.plan = [{
        ...step(`phase-step-${index}`),
        output: index === 1 ? "EARLIER_VERIFIED_VALUE=enabled" : `output-${index}`,
        result: {
          executionStatus: "success",
          observationStatus: "matched",
          exitCode: 0,
          facts: { category: "verified", value: index },
          warnings: [],
          evidenceIds: [],
        },
      }];
      archiveActivePhase(current, "adjustment", `2026-01-0${index + 2}T00:00:00.000Z`, `phase ${index}`);
    }
    current.plan = [step("current-pending", "pending")];

    expect(current.historyCheckpoint).toMatchObject({
      sourcePhaseCount: 2,
      sourceStepCount: 2,
    });
    expect(current.historyCheckpoint?.verifiedFacts.map(({ stepId }) => stepId))
      .toEqual(["phase-step-1", "phase-step-2"]);

    const snapshot = buildTaskDecisionSnapshot(current);
    expect(snapshot.recentPhases.map(({ steps }) => steps[0]?.stepId))
      .toEqual(["phase-step-3", "phase-step-4"]);
    expect(snapshot.historyCheckpoint?.phaseSummaries.map(({ summary }) => summary))
      .toEqual(["phase 1", "phase 2"]);
    expect(snapshot.progress.totalSteps).toBe(5);
    expect(snapshot.historyCheckpoint?.verifiedFacts[0].output).toMatchObject({
      content: "EARLIER_VERIFIED_VALUE=enabled", contentState: "complete",
    });
  });

  it("uses model relation when available and has a safe continuation fallback", () => {
    expect(normalizeRequirementRelation({
      intent: "execute",
      relation: "supplement",
      plan: [],
    }, "数据库使用已有实例", true)).toBe("supplement");
    expect(normalizeRequirementRelation({ intent: "execute", plan: [] }, "继续部署", true)).toBe("continue");
  });

  it("uses the model's complete current Skill set so stale matches can be removed", () => {
    expect(mergeTaskSkillIds(["source", "build"], ["build", "deploy"], "continue"))
      .toEqual(["build", "deploy"]);
    expect(mergeTaskSkillIds(["ssh-terminal-jump"], [], "continue"))
      .toEqual([]);
    expect(mergeTaskSkillIds(["source", "build"], ["transfer"], "new_goal"))
      .toEqual(["transfer"]);
  });
});
