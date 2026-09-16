import { describe, expect, it, vi } from "vitest";
import type { OpsTask, PlanStep } from "@/types";
import { decisionOutput, decisionOutputProjector, DECISION_OUTPUT_BUDGET } from "./decisionEvidence";
import { compactReviewText, textFingerprint } from "./longRunningReviewOutput";
import { buildTaskDecisionSnapshot } from "./taskDecisionSnapshot";
import { archiveToolEvidence } from "./evidenceArchive";

function step(id: string, output: string): PlanStep {
  return { id, title: id, description: "query", command: "inspect state", validation: "check state", expected: "observed",
    kind: "observe", risk: "low", status: "completed", output,
    result: { executionStatus: "success", observationStatus: "matched", exitCode: 0,
      facts: { commandCompleted: true, found: true, lineCount: 1 }, warnings: [], evidenceIds: [id] },
    evidence: [{ id, type: "command-output", source: "main", rawOutput: output, facts: {}, collectedAt: "now" }] };
}
function task(plan: PlanStep[]): OpsTask {
  return { id: "task", serverId: "server", currentRoundId: "round", title: "query", status: "validating",
    permission: "managed", modelId: "model", plan, messages: [], createdAt: "now", updatedAt: "now" };
}

describe("decision evidence projection", () => {
  it.each(["SCHEMA=analytics\nTABLE_COUNT=8", "SERVICE_STATE=active\nLISTEN_PORT=8080", "ARTIFACT_VERSION=2.1\nCHECKSUM=abc123"])(
    "preserves decisive short Shell output for arbitrary workflows: %s", output => {
      const current = task([step("inspect", output)]);
      const snapshot = buildTaskDecisionSnapshot(current);
      expect(snapshot.currentPlan.steps[0].output).toMatchObject({ content: output, contentState: "complete" });
      expect(current.plan[0].output).toBe(output);
    });
  it("archives long Shell evidence and offers scoped recall without requiring toolId", async () => {
    const output = "record\n".repeat(1000);
    const current = task([step("inspect", output)]);
    const save = vi.fn().mockResolvedValue("a".repeat(64));
    await archiveToolEvidence(current, current.plan[0], save, value => value);
    expect(save).toHaveBeenCalledOnce();
    const projection = decisionOutput(output, current.plan[0].evidence, 2048, true);
    expect(projection).toMatchObject({ contentState: "excerpt", references: [{ evidenceId: "a".repeat(64), readTool: "evidence.read" }] });
    expect(projection!.content!.length).toBeLessThanOrEqual(2048);
    expect(current.plan[0].output).toBe(output);
  });
  it("rejects stale archive references and preserves capturedPartial", () => {
    const current = step("inspect", "x".repeat(4000));
    current.evidence![0].archive = { evidenceId: "a".repeat(64), fingerprint: "stale", characters: 4000, capturedPartial: true };
    expect(decisionOutput(current.output, current.evidence, 100, true)?.references).toBeUndefined();
    current.evidence![0].archive!.fingerprint = textFingerprint(current.output!);
    expect(decisionOutput(current.output, current.evidence, 100, true)?.references?.[0].capturedPartial).toBe(true);
  });
  it("never expands the original text when only a tiny budget remains", () => {
    for (const limit of [0, 1, 5, 20, 50, 100]) {
      expect(compactReviewText("x".repeat(5000), limit).length).toBeLessThanOrEqual(limit);
    }
    const project = decisionOutputProjector(false, 2050);
    const results = Array.from({ length: 20 }, () => project("x".repeat(5000))!);
    expect(results.reduce((n, item) => n + (item.content?.length ?? 0), 0)).toBeLessThanOrEqual(2050);
    expect(results[results.length - 1]?.contentState).toBe("omitted");
  });
  it("retains a critical middle error within the canonical body and its existing budget", () => {
    const output = `${"ordinary progress\n".repeat(1000)}fatal: artifact integrity check failed\n${"more progress\n".repeat(1000)}`;
    const projected = decisionOutput(output, [], 1024)!;
    expect(projected.content).toContain("fatal: artifact integrity check failed");
    expect(projected.content!.length).toBeLessThanOrEqual(1024);
    expect(projected.content!.split("fatal: artifact integrity check failed")).toHaveLength(2);
    expect(projected.fingerprint).toBe(textFingerprint(output));
  });
  it("prioritizes recent content and keeps the output budget bounded", () => {
    const current = task(Array.from({ length: 20 }, (_, i) => step(`${i}`, `${i}:` + "x".repeat(3000))));
    const snapshot = buildTaskDecisionSnapshot(current);
    const outputs = snapshot.currentPlan.steps.map(item => item.output!);
    expect(outputs.reduce((n, item) => n + (item.content?.length ?? 0), 0)).toBeLessThanOrEqual(DECISION_OUTPUT_BUDGET);
    expect(outputs[outputs.length - 1]?.content).toContain("19:");
    expect(outputs[0].contentState).toBe("omitted");
  });
  it("merges retained evidence into canonical incident and phase steps without duplicating archive references", () => {
    const output = "a".repeat(1900) + "IMPORTANT_RESULT=available" + "z".repeat(1900);
    const latest = step("latest", output);
    latest.status = "failed";
    latest.result = {
      executionStatus: "failed",
      observationStatus: "unknown",
      exitCode: 1,
      facts: { commandCompleted: true },
      warnings: ["explicit failure"],
      evidenceIds: ["latest"],
      failureReason: "inspection failed",
    };
    latest.evidence![0].archive = {
      evidenceId: "b".repeat(64),
      fingerprint: textFingerprint(output),
      characters: output.length,
      capturedPartial: false,
    };
    const old = step("old", output);
    old.status = "failed";
    old.result = {
      executionStatus: "failed",
      observationStatus: "unknown",
      exitCode: 1,
      facts: { commandCompleted: true },
      warnings: ["explicit failure"],
      evidenceIds: ["old"],
      failureReason: "inspection failed",
    };
    const current = task([latest]);
    current.phaseHistory = [{ id: "older", roundId: "round", reason: "adjustment", requirement: "query",
      plan: [old], createdAt: "now", completedAt: "now" }];
    const snapshot = buildTaskDecisionSnapshot(current, undefined, true);

    expect(snapshot.workflowProgress.rereadEvidence).toBe(true);
    expect(snapshot.currentIncident?.output?.content).toContain("IMPORTANT_RESULT=available");
    expect(snapshot.currentIncident?.output?.references).toMatchObject([{
      evidenceId: "b".repeat(64),
      sourceEvidenceId: "latest",
      readTool: "evidence.read",
    }]);
    expect(snapshot.recentPhases[0].steps[0].output?.content).toContain("IMPORTANT_RESULT=available");
    expect(snapshot.recoveredEvidence).toBeUndefined();
  });

  it("keeps one output per execution across current, recent and checkpoint representations", () => {
    const output = "UNIQUE_EXECUTION_PAYLOAD=retained";
    const same = step("shared", output);
    same.attemptContext = "server-a";
    const current = task([same]);
    current.phaseHistory = Array.from({ length: 3 }, (_, index) => ({
      id: `phase-${index}`, roundId: "round", reason: "adjustment" as const, requirement: "query",
      plan: [same], createdAt: "now", completedAt: "now",
    }));
    const snapshot = buildTaskDecisionSnapshot(current);
    expect(snapshot.currentPlan.steps[0].output?.content).toBe(output);
    expect(snapshot.recentPhases.every(phase => phase.steps[0].output?.content === undefined)).toBe(true);
    expect(snapshot.recentPhases[0].steps[0].output?.contentRef).toBe("currentPlan.steps[0].output");
    expect(snapshot.historyCheckpoint?.verifiedFacts[0].output).toMatchObject({
      contentRef: "currentPlan.steps[0].output",
    });
    expect(JSON.stringify(snapshot).split(output)).toHaveLength(2);
    expect(current.plan[0].output).toBe(output);
  });

  it("does not collapse reused step ids on different targets", () => {
    const sameIdA = { ...step("same-id", "TARGET_A_RESULT"), attemptContext: "target-a" };
    const sameIdB = { ...step("same-id", "TARGET_B_RESULT"), attemptContext: "target-b" };
    const current = task([sameIdB]);
    current.phaseHistory = [{ id: "phase-a", roundId: "round", reason: "adjustment", requirement: "query",
      plan: [sameIdA], createdAt: "now", completedAt: "now" }];
    const snapshot = buildTaskDecisionSnapshot(current);
    expect(snapshot.currentPlan.steps[0].output?.content).toBe("TARGET_B_RESULT");
    expect(snapshot.recentPhases[0].steps[0].output?.content).toBe("TARGET_A_RESULT");
  });

  it("uses the fullest retained body for the same durable execution evidence", () => {
    const full = step("same-evidence", "first line\nDECISIVE_RETAINED_RESULT\nlast line");
    const short = { ...full, output: "first line" };
    const current = task([short]);
    current.phaseHistory = [{ id: "full-phase", roundId: "round", reason: "adjustment", requirement: "query",
      plan: [full], createdAt: "now", completedAt: "now" }];
    const snapshot = buildTaskDecisionSnapshot(current);
    expect(snapshot.currentPlan.steps[0].output?.content).toContain("DECISIVE_RETAINED_RESULT");
    expect(snapshot.recentPhases[0].steps[0].output?.content).toBeUndefined();
    expect(snapshot.recentPhases[0].steps[0].output?.contentRef).toBe("currentPlan.steps[0].output");
  });

  it("uses a single output budget even when an incident requests wider recovered evidence", () => {
    const longOutput = (id: string) => `${id}\n${"a".repeat(2500)}\nimportant middle ${id}\n${"z".repeat(2500)}`;
    const failed = step("failed", longOutput("failed"));
    failed.status = "failed";
    failed.result!.executionStatus = "failed";
    failed.result!.failureReason = "explicit failure";
    failed.evidence!.push({ id: "validation-proof", type: "command-output", source: "validation",
      rawOutput: "permission denied: acceptance failed", facts: {}, collectedAt: "now" });
    const old = step("old", longOutput("old"));
    old.status = "failed";
    old.result!.executionStatus = "failed";
    const current = task([step("other", longOutput("other")), failed]);
    current.phaseHistory = [{ id: "first-phase", roundId: "round", reason: "adjustment", requirement: "query",
      plan: [step("first", longOutput("first"))], createdAt: "now", completedAt: "now" },
    { id: "old-phase", roundId: "round", reason: "adjustment", requirement: "query",
      plan: [old, failed], createdAt: "now", completedAt: "now" }];
    const snapshot = buildTaskDecisionSnapshot(current);
    expect(snapshot.workflowProgress.rereadEvidence).toBe(true);
    const textBodies: string[] = [];
    const collect = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "content" && typeof child === "string") textBodies.push(child);
        else collect(child);
      }
    };
    collect(snapshot);
    expect(textBodies.reduce((total, text) => total + text.length, 0)).toBeLessThanOrEqual(DECISION_OUTPUT_BUDGET);
    expect(snapshot.currentIncident?.output?.content).toContain("important middle failed");
    expect(snapshot.currentIncident?.validationEvidence?.[0].output?.content).toContain("acceptance failed");
    expect(snapshot.recentPhases[1].steps[1].output?.contentRef).toBe("currentIncident.output");
  });

  it("references scope-aware confirmed inputs instead of replaying historical form values", () => {
    const input = step("input", '{"old_choice":"OLD_TARGET_ONLY_VALUE"}');
    input.result!.facts = { toolId: "user.request_input", old_choice: "OLD_TARGET_ONLY_VALUE" };
    input.evidence![0].facts = { old_choice: "OLD_TARGET_ONLY_VALUE" };
    const current = task([input]);
    current.phaseHistory = Array.from({ length: 3 }, (_, index) => ({
      id: `form-phase-${index}`, roundId: "round", reason: "adjustment" as const, requirement: "query",
      plan: [input], createdAt: "now", completedAt: "now",
    }));
    const snapshot = buildTaskDecisionSnapshot(current, undefined, true);
    expect(JSON.stringify(snapshot)).not.toContain("OLD_TARGET_ONLY_VALUE");
    expect(snapshot.currentPlan.steps[0].output?.contentRef).toBe("confirmedUserInputs");
    expect(snapshot.historyCheckpoint?.verifiedFacts[0].output).toMatchObject({ contentRef: "confirmedUserInputs" });
    expect(current.plan[0].output).toContain("OLD_TARGET_ONLY_VALUE");
  });
});
