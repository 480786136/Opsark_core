import { describe, expect, it, vi } from "vitest";
import type { OpsTask, PlanStep } from "@/types";
import { taskAttemptContext } from "./attemptState";
import { assertTaskPlanAuthorization, hasVerifiedRecovery, isRelatedRecoveryStep, recoveryPlanningContext, persistedRecoveryContract } from "./recoveryContract";
import { remainingPlanCanRepairPostcondition, remainingPlanCanRecoverExecutionFailure } from "./evidenceReview";
import { findUnresolvedBlockingStep, resolveTaskProgression, selectAdjustmentSteps, selectContinuationSteps } from "./taskProgression";
import { reviewPrecondition } from "./reviewService";
import { applyExecutionEvidenceReview } from "./reviewCoordination";
import { normalizePlanPreconditions } from "./planNormalizer";
import { runEvidenceReviewPipeline } from "./stepReviewPipeline";

function fixture() {
  const task: OpsTask = { id: "task", serverId: "server", title: "Build project A", status: "running",
    permission: "managed", modelId: "model", messages: [], plan: [], currentRoundId: "round",
    createdAt: "now", updatedAt: "now" };
  const context = taskAttemptContext(task);
  const failed: PlanStep = { id: "failed-a", kind: "change", title: "Build project A", description: "Build",
    command: "cd /opt/a && npm run build", validation: "test -d /opt/a/dist >/dev/null", expected: "artifact",
    risk: "low", status: "failed", attemptContext: context,
    result: { executionStatus: "failed", observationStatus: "unknown", exitCode: 1,
      facts: {}, warnings: [], evidenceIds: [] } };
  const repair: PlanStep = { ...failed, id: "repair-a", command: "cd /opt/a && npm install dependency",
    status: "pending", result: undefined, attemptContext: undefined,
    recovery: { failedStepId: failed.id, targetContext: context, purpose: "repair" } };
  const verify: PlanStep = { ...repair, id: "verify-a", kind: "observe", command: failed.validation,
    validation: "", recovery: { ...repair.recovery!, purpose: "verify" } };
  const next: PlanStep = { ...repair, id: "business", command: "systemctl restart app", recovery: undefined };
  task.plan = [failed, repair, verify, next];
  return { task, failed, repair, verify, next, context };
}

function finish(step: PlanStep, context: string) {
  step.status = "completed";
  step.attemptContext = context;
  step.result = { executionStatus: "success", observationStatus: "matched", exitCode: 0,
    facts: {}, warnings: [], evidenceIds: [step.id] };
  step.evidence = [{ id: step.id, type: "command", source: "main", facts: {}, rawOutput: "ok", collectedAt: "now" }];
}

describe("explicit recovery contract", () => {
  it.each(["true;", "/usr/bin/true", ": ;", "exit   0;", "command true", "env true", "set -e; /usr/bin/true"])(
    "does not accept a vacuous original validation: %s", validation => {
      const { failed, verify, context } = fixture();
      failed.validation = validation;
      verify.command = validation;
      finish(verify, context);
      expect(hasVerifiedRecovery(failed, verify)).toBe(false);
    },
  );
  it("rejects shared /dev/null and the same build command on project B", () => {
    const { failed, repair, verify } = fixture();
    const unrelated = { ...verify, recovery: undefined, command: "test -d /opt/b/dist >/dev/null" };
    expect(remainingPlanCanRepairPostcondition([unrelated], failed)).toBe(false);
    expect(isRelatedRecoveryStep(failed, { ...repair, command: "cd /opt/b && npm run build", recovery: undefined })).toBe(false);
    expect(isRelatedRecoveryStep(failed, { ...verify, command: unrelated.command })).toBe(false);
    expect(isRelatedRecoveryStep(failed, { ...verify, recovery: { ...verify.recovery!, failedStepId: "failed-b" } })).toBe(false);
    expect(isRelatedRecoveryStep(failed, { ...verify, recovery: { ...verify.recovery!, targetContext: "server-b" } })).toBe(false);
  });

  it("does not use a future recovery to authorize the preceding business step", async () => {
    const { task, failed, repair, next } = fixture();
    task.plan = [failed, next, repair];
    expect(remainingPlanCanRecoverExecutionFailure("network_failure", [next, repair], failed)).toBe(false);
    expect(findUnresolvedBlockingStep(task, next)).toBe(failed);
    const reviewer = vi.fn().mockResolvedValue({ decision: "continue", source: "model" });
    expect((await reviewPrecondition({ task, step: next, blockerStep: failed }, reviewer)).allowed).toBe(false);
    expect(reviewer).not.toHaveBeenCalled();
  });

  it("does not let a later soft risk waive an earlier hard failure under best_effort", async () => {
    const { task, failed, next } = fixture();
    task.executionConstraints = { changePolicy: "requested_changes_only", failurePolicy: "best_effort",
      environmentPolicy: "preserve", prohibitedActions: [], requiredConditions: [], userDirectives: ["try current environment"] };
    const soft = { ...failed, id: "soft", kind: "observe" as const, status: "completed" as const,
      result: { executionStatus: "success" as const, observationStatus: "warning" as const,
        facts: { blockingSignal: true }, warnings: ["risk"], evidenceIds: [] } };
    task.plan = [failed, soft, next];
    const reviewer = vi.fn().mockResolvedValue({ decision: "continue", source: "model" });
    expect((await reviewPrecondition({ task, step: next, blockerStep: soft }, reviewer)).allowed).toBe(false);
    expect(reviewer).not.toHaveBeenCalled();
  });

  it("recovery metadata does not authorize a mutation in a read-only task", async () => {
    const { task, failed, repair, verify } = fixture();
    task.executionConstraints = { changePolicy: "read_only", failurePolicy: "strict",
      environmentPolicy: "preserve", prohibitedActions: [], requiredConditions: [], userDirectives: [] };
    expect((await reviewPrecondition({ task, step: repair, blockerStep: failed })).allowed).toBe(false);
    expect(() => assertTaskPlanAuthorization(task, [repair])).toThrow("只读授权");
    expect(() => assertTaskPlanAuthorization(task, [verify])).not.toThrow();
    expect(() => assertTaskPlanAuthorization(task, [{ ...verify, kind: "change" }])).toThrow("只读授权");
  });

  it("keeps a successful observe detector completed and permits a separately reviewed best_effort attempt", async () => {
    const { task, failed, next } = fixture();
    task.executionConstraints = { changePolicy: "requested_changes_only", failurePolicy: "best_effort",
      environmentPolicy: "preserve", prohibitedActions: [], requiredConditions: [], userDirectives: ["try current environment"] };
    failed.kind = "observe";
    failed.status = "validating";
    failed.result = { executionStatus: "success", observationStatus: "warning", exitCode: 0,
      facts: { blockingSignal: true }, warnings: ["unsupported runtime"], evidenceIds: [] };
    task.plan = [failed, next];
    // Use the real coordination pipeline, beginning with the actual validating
    // state; the reviewer cannot pre-mark the successful detector failed.
    await runEvidenceReviewPipeline({ task, step: failed, reviewRequired: false, postconditionReview: false,
      blockingFacts: failed.result.facts, serverId: task.serverId, taskId: task.id, isCancelled: () => false });
    expect(failed.status).toBe("completed");
    const reviewer = vi.fn().mockResolvedValue({ decision: "continue", source: "model", reason: "authorized attempt", summary: "risk remains" });
    expect((await reviewPrecondition({ task, step: next, blockerStep: failed }, reviewer)).allowed).toBe(true);
    expect(failed.result.facts.blockingSignal).toBe(true);
  });

  it("executes an archived failure's recovery but only releases business after actual verification", async () => {
    const { task, failed, repair, verify, next, context } = fixture();
    task.phaseHistory = [{ id: "previous", roundId: "round", requirement: task.title, reason: "adjustment",
      plan: [failed], createdAt: "now", completedAt: "now" }];
    task.plan = [repair, verify, next];
    expect((await reviewPrecondition({ task, step: repair, blockerStep: failed })).allowed).toBe(true);
    finish(repair, context);
    expect(findUnresolvedBlockingStep(task, next)).toBe(failed);
    expect((await reviewPrecondition({ task, step: verify, blockerStep: failed })).allowed).toBe(true);
    verify.review = { decision: "complete", reason: "model says done", summary: "done", source: "model" };
    expect(hasVerifiedRecovery(failed, verify)).toBe(false);
    finish(verify, context);
    expect(findUnresolvedBlockingStep(task, next)).toBeUndefined();
    expect(recoveryPlanningContext(task).blockers).toEqual([]);
    expect(failed.status).toBe("failed");
    verify.result!.exitCode = 1;
    expect(findUnresolvedBlockingStep(task, next)).toBe(failed);
  });

  it("cannot complete a recovery-only stage without real verification or with stale evidence", () => {
    const { task, failed, repair, verify, context } = fixture();
    finish(repair, context);
    task.plan = [failed, repair];
    expect(resolveTaskProgression(task).kind).toBe("recovery-required");
    finish(verify, "different-target");
    expect(hasVerifiedRecovery(failed, verify)).toBe(false);
    finish(verify, context);
    verify.evidence = [];
    expect(hasVerifiedRecovery(failed, verify)).toBe(false);
  });

  it("permits fresh verification after reconnect or credential refresh, never across server or round", async () => {
    const { task, failed, verify } = fixture();
    task.agentSessionId = "reconnected";
    task.agentSessionGeneration = 3;
    task.credentialRevision = 2;
    expect((await reviewPrecondition({ task, step: verify, blockerStep: failed })).allowed).toBe(true);
    finish(verify, taskAttemptContext(task));
    expect(hasVerifiedRecovery(failed, verify)).toBe(true);
    task.executionTargetServerId = "other-server";
    expect((await reviewPrecondition({ task, step: verify, blockerStep: failed })).allowed).toBe(false);
    task.executionTargetServerId = task.serverId;
    task.currentRoundId = "other-round";
    expect((await reviewPrecondition({ task, step: verify, blockerStep: failed })).allowed).toBe(false);
  });

  it("keeps a required original-contract verification despite previous identical observations", () => {
    const { failed, verify, context } = fixture();
    const prior = { ...verify, id: "earlier-observation", recovery: undefined };
    finish(prior, context);
    const history = [failed, prior];
    expect(selectAdjustmentSteps(history, [verify], context)).toEqual([verify]);
    expect(selectContinuationSteps(history, [verify], context)).toEqual([verify]);
    const invalid = { ...verify, recovery: { ...verify.recovery!, failedStepId: "different-failure" } };
    expect(selectAdjustmentSteps(history, [invalid], context)).toEqual([]);
  });

  it("rechecks an observe blocker using its original observation contract", () => {
    const { failed, verify, context } = fixture();
    failed.kind = "observe";
    failed.validation = "";
    failed.command = 'test "$(custom-runtime-check --project /opt/a)" = supported';
    failed.result!.facts.blockingSignal = true;
    verify.command = failed.command;
    finish(verify, context);
    verify.result!.facts.blockingSignal = true;
    expect(hasVerifiedRecovery(failed, verify)).toBe(false);
    verify.result!.facts.blockingSignal = false;
    expect(hasVerifiedRecovery(failed, verify)).toBe(true);
  });

  it("preserves a failed postcondition and does not skip verification on model completion", () => {
    const { failed, repair, verify } = fixture();
    failed.status = "validating";
    failed.result!.executionStatus = "success";
    failed.result!.facts.validationPassed = false;
    expect(applyExecutionEvidenceReview({ step: failed, remainingSteps: [repair, verify],
      review: { decision: "continue", source: "model", reason: "recover", summary: "recover" },
      reviewWasRequired: true }).shouldAdvance).toBe(true);
    expect(failed.status).toBe("failed");
    repair.status = "validating";
    applyExecutionEvidenceReview({ step: repair, remainingSteps: [verify], reviewWasRequired: true,
      review: { decision: "complete", source: "model", reason: "done", summary: "done" } });
    expect(verify.status).toBe("pending");
  });

  it("preserves protocol metadata and rejects malformed or self-referential recovery", () => {
    const { repair, verify } = fixture();
    expect(normalizePlanPreconditions([verify])[0].recovery).toEqual(verify.recovery);
    expect(() => normalizePlanPreconditions([{ ...repair, recovery: { ...repair.recovery!, failedStepId: repair.id } }])).toThrow("recovery");
    expect(() => normalizePlanPreconditions([{ ...verify, recovery: { ...verify.recovery!, purpose: "repair" } }])).toThrow("RECOVERY_KIND_MISMATCH");
  });

  it("retains a persisted failure gate after detailed phases are trimmed and releases it after verification", () => {
    const { task, failed, repair, verify, next, context } = fixture();
    task.plan = [repair, verify, next];
    task.phaseHistory = [];
    task.historyCheckpoint = { version: 2, sourceRoundCount: 1, sourcePhaseCount: 1, sourceStepCount: 1,
      statusCounts: { failed: 1 }, verifiedFacts: [], phaseSummaries: [], updatedAt: "now", sourceHistoryFingerprint: "persisted",
      unresolvedIssues: [{ stepId: failed.id, title: failed.title, status: "failed", commandFingerprint: "a",
        attemptCount: 1, attemptContext: context, sourceRoundId: "round", blocksExecution: true,
        recoveryContract: persistedRecoveryContract(failed, "round") }] };
    expect(findUnresolvedBlockingStep(task, next)?.id).toBe(failed.id);
    finish(verify, context);
    expect(findUnresolvedBlockingStep(task, next)).toBeUndefined();
    task.historyCheckpoint!.unresolvedIssues[0].recoveryContract = undefined;
    expect(findUnresolvedBlockingStep(task, next)?.result?.facts.recoveryContractMissing).toBe(true);
    task.currentRoundId = "new-user-goal";
    expect(findUnresolvedBlockingStep(task, next)?.result?.facts.recoveryContractMissing).toBe(true);
  });
});
