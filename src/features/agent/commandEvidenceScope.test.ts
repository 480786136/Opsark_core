import { describe, expect, it } from "vitest";
import type { ExecutionIntentSemantic, NextStageDecision, OpsTask, PlanStep } from "@/types";
import type { ExecutionOperationRecord } from "@/services/executionLedger";
import { executionDigest } from "./planPreparation";
import { buildCommandFailure, buildPeriodicReviewFailure } from "./commandStepResult";
import { commandExecutionScope, restoreCommandEvidenceScopes } from "./commandEvidenceScope";
import { prepareTaskDecision, taskDecisionEvidenceIndex, TaskEvidenceError } from "./taskDecisionResolution";
import { buildTaskDecisionSnapshot } from "./taskDecisionSnapshot";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 2, 3, 0, seconds)).toISOString();
// Redacted shapes of the two failure paths observed in the deployment incident:
// existing checkout rejects clone; periodic review stops exhausted image pulls.
function fixture(periodic = false) {
  const command = periodic ? "docker build ." : "git clone https://example.invalid/app.git /opt/app";
  const semantic: ExecutionIntentSemantic = { taskId: "task", stepId: "failed",
    action: { type: "shell", command },
    targets: [{ role: "execution", serverId: "original", host: "original.example", port: 22, username: "deploy",
      agentSession: { id: "session", generation: 2, contextRevision: 1, cwd: "/opt/app", shell: "bash" } }],
    executionScope: "agent_session", kind: "change", effect: "change", risk: "medium", expected: "application deployed",
    dependencies: { precedingStepIds: [] }, permission: "managed", policyVersion: "test@1" };
  const output = periodic ? "registry connect timed out; retry 3/3 failed" : "destination path already exists";
  const exitCode = periodic ? 130 : 1;
  const input = { output, exitCode, evidenceId: "failure-proof", collectedAt: at(2) };
  const failure = periodic ? buildPeriodicReviewFailure({ ...input, reviewRound: 3, validationPassed: false,
    review: { decision: "adjust", reason: "image pull failed", summary: "inspect alternatives", source: "model" } }) : buildCommandFailure(input);
  const step: PlanStep = { id: "failed", title: "deploy", description: "", command,
    action: semantic.action, kind: "change", executionScope: "agent_session", risk: "medium", expected: semantic.expected,
    validation: "", status: "failed", startedAt: at(0), attemptContext: JSON.stringify(["original", "round", "session", 2, 0]),
    executionIntent: { version: "execution-intent@1", algorithm: "sha256", semantic,
      digest: executionDigest({ version: "execution-intent@1", semantic }) }, result: failure.result, evidence: failure.evidence,
    executionLedgerAttempts: [{ operationId: "operation", attemptId: "attempt", executionId: "execution", phase: "command" }],
    ledgerAppliedAttemptIds: ["attempt"] };
  const task: OpsTask = { id: "task", serverId: "original", title: "deploy", permission: "managed", status: "needs_adjustment",
    modelId: "fixture", createdAt: at(0), updatedAt: at(2), currentRoundId: "round", messages: [], plan: [step],
    requirementLifecycle: { version: 1, revision: 1, focus: { roundId: "round", sourceMessageId: "message", requirementIds: ["deploy"] },
      items: [{ id: "deploy", kind: "goal", content: "deploy", status: "active", evidenceIds: [],
        source: { content: "deploy", source: "user_message", relation: "new_goal", sourceMessageId: "message", createdAt: at(0) } }] } };
  const operation: ExecutionOperationRecord = { version: 1, operationId: "operation", taskId: "task", stepId: step.id,
    workflowEpoch: 0, planRevision: 1, stepRevision: 1, intentDigest: step.executionIntent!.digest,
    intent: structuredClone(step.executionIntent!), phase: "command", effect: "change", resourceKeys: ["endpoint:original.example:22"],
    state: "failed", cancelRequested: false, createdAt: Date.parse(at(0)), updatedAt: Date.parse(at(1)),
    attempts: [{ version: 1, id: "attempt", operationId: "operation", executionId: "execution", bootId: "boot",
      status: "failed", cancelRequested: periodic, late: false, startedAt: Date.parse(at(0)), completedAt: Date.parse(at(1)),
      projectionAppliedAt: Date.parse(at(2)),
      outcome: { status: "failed", evidenceRefs: ["durable-output"], result: { success: false, exitCode, output } } }] };
  return { task, step, operation };
}
function diagnosis(): NextStageDecision {
  return { decision: "continue", reason: "verify current state", summary: "read-only diagnosis", source: "model",
    steps: [{ id: "inspect", title: "inspect", description: "", command: "ls /opt/app", action: { type: "shell", command: "ls /opt/app" },
      kind: "observe", risk: "low", expected: "current files", validation: "", status: "pending" }],
    requirementReview: { baseRevision: 1, roundId: "round", focusOutcome: "pending", overallOutcome: "pending",
      items: [{ requirementId: "deploy", outcome: "unknown", evidenceIds: ["failure-proof"], reason: "failed receipt requires verification" }] } };
}

describe("failed command evidence identity", () => {
  it.each([false, true])("restores %s periodic failure from matching durable receipt without certifying success", periodic => {
    const { task, step, operation } = fixture(periodic);
    expect(restoreCommandEvidenceScopes(task, [operation])).toBe(1);
    expect(step.evidence![0].scope).toMatchObject({ targetId: "original", scope: "agent_session", sessionId: "session", generation: 2 });
    expect(step.result!.executionStatus).toBe("failed");
    expect(step.ledgerVerifiedAttemptIds).toBeUndefined();
    expect(taskDecisionEvidenceIndex(task)).toEqual({ availableIds: [], diagnosticIds: ["failure-proof"], untrustedDiagnosticIds: [] });
    const proposal = diagnosis(); proposal.requirementReview!.items[0].outcome = "unmet";
    expect(prepareTaskDecision(task, proposal).currentRequestReview?.completed).toBe(false);
    proposal.requirementReview!.items[0].outcome = "satisfied";
    expect(() => prepareTaskDecision(task, proposal)).toThrow();
  });

  it("allows an unverified failed receipt only as unknown during a read-only proposal", () => {
    const { task, step } = fixture();
    expect(restoreCommandEvidenceScopes(task, [])).toBe(0);
    expect(taskDecisionEvidenceIndex(task)).toEqual({ availableIds: [], diagnosticIds: [], untrustedDiagnosticIds: ["failure-proof"] });
    expect(buildTaskDecisionSnapshot(task).requirementEvidence.untrustedDiagnosticIds).toEqual(["failure-proof"]);
    expect(prepareTaskDecision(task, diagnosis()).currentRequestReview?.completed).toBe(false);
    expect(step.evidence![0].scope).toBeUndefined();
    const wrong = diagnosis(); wrong.requirementReview!.items[0].outcome = "unmet";
    expect(() => prepareTaskDecision(task, wrong)).toThrow("未核实记录仅能支持 unknown");
    wrong.requirementReview!.items[0].outcome = "satisfied";
    expect(() => prepareTaskDecision(task, wrong)).toThrow(TaskEvidenceError);
    wrong.requirementReview!.items[0].outcome = "unknown";
    wrong.steps[0].kind = "change";
    expect(() => prepareTaskDecision(task, wrong)).toThrow("不能据此重试");
  });

  it("never uses a diagnostic receipt to close an issue or authorize a retry", () => {
    const { task, operation } = fixture();
    const closing = diagnosis();
    closing.issueResolutions = [{ issueId: "original-failure", reason: "resolved", evidenceIds: ["failure-proof"] }];
    expect(() => prepareTaskDecision(task, closing)).toThrow(TaskEvidenceError);
    const retrying = diagnosis();
    retrying.steps[0].retryAfterStepId = "failed";
    expect(() => prepareTaskDecision(task, retrying)).toThrow("不能据此重试");
    restoreCommandEvidenceScopes(task, [operation]);
    closing.requirementReview!.items[0].outcome = "satisfied";
    expect(() => prepareTaskDecision(task, closing)).toThrow();
  });

  it.each(["command", "action", "validation", "validator", "session", "user_action", "change_intent"])(
    "rejects a supposedly read-only diagnostic proposal with %s side effects", mode => {
      const { task, step } = fixture();
      const proposal = diagnosis(), inspect = proposal.steps[0];
      if (mode === "command") inspect.command = "touch /tmp/changed";
      if (mode === "action") inspect.action = { type: "shell", command: "rm -rf /opt/app" };
      if (mode === "validation") inspect.validation = "systemctl restart app";
      if (mode === "validator") inspect.validator = { type: "command", command: "touch /tmp/validated", validStates: ["healthy"] };
      if (mode === "session") inspect.sessionContextChange = { cwd: "/other" };
      if (mode === "user_action") inspect.executionScope = "user_action";
      if (mode === "change_intent") inspect.executionIntent = structuredClone(step.executionIntent);
      expect(() => prepareTaskDecision(task, proposal)).toThrow("不能据此重试");
    });

  it("retains genuinely read-only validation on an untrusted diagnostic proposal", () => {
    const { task } = fixture();
    const proposal = diagnosis();
    proposal.steps[0].validation = "test -d /opt/app";
    proposal.steps[0].validator = { type: "command", command: "test -d /opt/app", validStates: ["healthy"] };
    expect(prepareTaskDecision(task, proposal).currentRequestReview?.completed).toBe(false);
  });

  it.each(["task", "attempt", "execution", "output", "exit", "time", "intent", "session", "unapplied", "unacknowledged", "early_acknowledgement", "late", "unknown"])(
    "does not restore a mismatched %s receipt", mode => {
      const { task, step, operation } = fixture();
      if (mode === "task") operation.taskId = "other-task";
      if (mode === "attempt") operation.attempts[0].id = "other-attempt";
      if (mode === "execution") operation.attempts[0].executionId = "other-execution";
      if (mode === "output") (operation.attempts[0].outcome!.result as { output: string }).output = "different";
      if (mode === "exit") (operation.attempts[0].outcome!.result as { exitCode: number }).exitCode = 0;
      if (mode === "time") step.evidence![0].collectedAt = "2026-10-01T00:00:00Z";
      if (mode === "intent") operation.intent.semantic.targets[0].host = "foreign.example";
      if (mode === "session") step.attemptContext = JSON.stringify(["original", "round", "other-session", 2, 0]);
      if (mode === "unapplied") step.ledgerAppliedAttemptIds = [];
      if (mode === "unacknowledged") delete operation.attempts[0].projectionAppliedAt;
      if (mode === "early_acknowledgement") operation.attempts[0].projectionAppliedAt = Date.parse(at(0));
      if (mode === "late") operation.attempts[0].late = true;
      if (mode === "unknown") operation.attempts[0].status = "unknown";
      expect(restoreCommandEvidenceScopes(task, [operation])).toBe(0);
      expect(step.evidence![0].scope).toBeUndefined();
    });

  it("preserves original identity when task target changes and excludes both trusted and untrusted foreign diagnosis", () => {
    const { task, step, operation } = fixture();
    task.executionTargetServerId = "other-target";
    expect(commandExecutionScope(step, task.id)?.targetId).toBe("original");
    expect(taskDecisionEvidenceIndex(task).untrustedDiagnosticIds).toEqual([]);
    expect(() => prepareTaskDecision(task, diagnosis())).toThrow();
    expect(restoreCommandEvidenceScopes(task, [operation])).toBe(1);
    expect(step.evidence![0].scope?.targetId).toBe("original");
    expect(taskDecisionEvidenceIndex(task)).toEqual({ availableIds: [], diagnosticIds: [], untrustedDiagnosticIds: [] });
    expect(() => prepareTaskDecision(task, diagnosis())).toThrow();
  });
});
