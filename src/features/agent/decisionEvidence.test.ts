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
  it("prioritizes recent content and keeps the output budget bounded", () => {
    const current = task(Array.from({ length: 20 }, (_, i) => step(`${i}`, `${i}:` + "x".repeat(3000))));
    const snapshot = buildTaskDecisionSnapshot(current);
    const outputs = snapshot.currentPlan.steps.map(item => item.output!);
    expect(outputs.reduce((n, item) => n + (item.content?.length ?? 0), 0)).toBeLessThanOrEqual(DECISION_OUTPUT_BUDGET);
    expect(outputs[outputs.length - 1]?.content).toContain("19:");
    expect(outputs[0].contentState).toBe("omitted");
  });
  it("re-reads retained evidence before another stagnant phase", () => {
    const output = "a".repeat(1900) + "IMPORTANT_RESULT=available" + "z".repeat(1900);
    const current = task([step("latest", output)]);
    current.phaseHistory = [{ id: "older", roundId: "round", reason: "adjustment", requirement: "query",
      plan: [step("old", output)], createdAt: "now", completedAt: "now" }];
    const snapshot = buildTaskDecisionSnapshot(current);
    expect(snapshot.currentPlan.steps[0].output?.content).not.toContain("IMPORTANT_RESULT");
    expect(snapshot.recoveredEvidence?.[0].output?.content).toContain("IMPORTANT_RESULT=available");
  });
});
