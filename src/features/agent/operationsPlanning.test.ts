import { describe, expect, it } from "vitest";
import type { OpsTask, PlanStep } from "@/types";
import { buildTaskDecisionSnapshot } from "./taskDecisionSnapshot";
import { automaticContinuationStop, observationIdentity, renewAutomaticPhaseBudget, workflowProgress } from "./workflowProgress";
import { operationsPlanningContext, OPERATIONS_SUMMARY_BUDGET } from "./operationsPlanning";
import { textFingerprint } from "./longRunningReviewOutput";

function inspection(id: string, path = "/srv", check = "directory", sample = 1): PlanStep {
  const request = { path, check, maxDepth: 16, reportDepth: 1, maxEntries: 100000, maxResults: 50, timeoutSeconds: 60, sameFilesystem: true, excludePaths: [] };
  const data = { request, status: "partial", coverageComplete: false, truncated: true,
    scannedEntries: 20, matchedEntries: 1, skippedCount: 150,
    skipped: Array.from({ length: 100 }, (_, i) => ({ path: `${path}/child-${i}`, reason: "depth" })),
    items: [{ kind: check === "capacity" ? "filesystem" : "directory", subject: path, allocatedBytes: 1048576,
      ...(check === "capacity" ? { totalBytes: 10000000, freeBytes: 500000 - sample, usedBytes: 9500000 + sample, inodeTotal: 10000 } : {}) }],
    finishedAt: `2026-09-27T00:00:${sample.toString().padStart(2, "0")}Z`, elapsedMs: sample * 3 };
  const output = JSON.stringify(data);
  return { id, title: "检查", description: "检查实际范围", command: "", validation: "", expected: "观察占用", kind: "observe", risk: "low", status: "completed",
    action: { type: "tool", toolId: "disk.inspect", arguments: request }, output,
    attemptContext: JSON.stringify(["server", "round", "session", 1, 0]),
    result: { executionStatus: "success", observationStatus: "warning", facts: { toolId: "disk.inspect", evidenceKind: "operations_inspection",
      evidenceComplete: false, inspectionStatus: "partial", truncated: true, scanCoverage: { request, skipped: data.skipped } }, warnings: ["partial"], evidenceIds: [id] },
    evidence: [{ id, type: "command-output", source: "main", rawOutput: output, facts: { scanCoverage: data.skipped }, collectedAt: data.finishedAt,
      archive: { evidenceId: "a".repeat(64), fingerprint: textFingerprint(output), characters: output.length, capturedPartial: true } }] };
}
function task(steps: PlanStep[]): OpsTask {
  return { id: "task", serverId: "server", currentRoundId: "round", title: "分析磁盘", status: "awaiting_continuation", permission: "managed", modelId: "model", messages: [],
    rootGoal: "分析磁盘空间占用", plan: steps.slice(-1), createdAt: "now", updatedAt: "now",
    phaseHistory: steps.slice(0, -1).map(step => ({ id: step.id, roundId: "round", requirement: "分析磁盘", reason: "adjustment", plan: [step], createdAt: "now", completedAt: "now" })) };
}

describe("inspection progress and planning evidence", () => {
  it("does not count collection time or repeated capacity polling as new coverage", () => {
    expect(observationIdentity(inspection("first", "/srv", "directory", 1))).toBe(observationIdentity(inspection("second", "/srv", "directory", 9)));
    const current = task([1, 2, 3].map(i => inspection(String(i), "/", "capacity", i)));
    expect(workflowProgress(current)).toMatchObject({ stagnantPhases: 2, evidenceCount: 1 });
    expect(automaticContinuationStop(current)?.code).toBe("no_progress");
  });
  it("counts real coverage changes and scopes, while retaining a finite budget for read-only work", () => {
    const first = inspection("first"), next = inspection("next");
    const data = JSON.parse(next.output!); data.coverageComplete = true; data.status = "complete"; data.skipped = []; data.skippedCount = 0; next.output = JSON.stringify(data);
    expect(observationIdentity(first)).not.toBe(observationIdentity(next));
    expect(automaticContinuationStop(task(Array.from({ length: 7 }, (_, i) => inspection(String(i), `/srv/${i}`))))).toBeUndefined();
    const current = task(Array.from({ length: 12 }, (_, i) => inspection(String(i), `/srv/${i}`)));
    expect(automaticContinuationStop(current)?.code).toBe("phase_budget_exhausted");
    expect(renewAutomaticPhaseBudget(current, "now")).toBe(true);
    expect(automaticContinuationStop(JSON.parse(JSON.stringify(current)))).toBeUndefined();
  });
  it("explicit continuation releases the legacy six-observation stop without discarding history", () => {
    const current = task(Array.from({ length: 6 }, (_, i) => inspection(String(i), `/srv/${i}`)));
    current.managedStopReason = "no_progress";
    const original = JSON.stringify(current.phaseHistory);
    expect(renewAutomaticPhaseBudget(current, "now")).toBe(true);
    expect(workflowProgress(current).automaticPhases).toBe(6);
    expect(JSON.stringify(current.phaseHistory)).toBe(original);
  });
  it("keeps one summary for equivalent observations, preserves scope gaps and bounds model payload", () => {
    const steps = Array.from({ length: 30 }, (_, i) => inspection(String(i), `/srv/${i % 5}`, "directory", i + 1));
    const current = task(steps), before = JSON.stringify([current.plan, current.phaseHistory]);
    const projection = operationsPlanningContext(steps);
    expect(projection.context!.observations).toHaveLength(5);
    expect(JSON.stringify(projection.context!.observations).length).toBeLessThan(OPERATIONS_SUMMARY_BUDGET + 30);
    expect(projection.context!.observations[0]).toMatchObject({ coverageComplete: false, skippedCount: 150, repeatedObservationCount: 6, omittedSkippedDetails: 147 });
    const snapshot = buildTaskDecisionSnapshot(current, undefined, true);
    expect(snapshot.currentPlan.steps[0]?.output ?? snapshot.currentIncident?.output).toMatchObject({ contentState: "omitted", references: [{ readTool: "evidence.read" }] });
    expect(JSON.stringify(snapshot).length).toBeLessThan(35000);
    expect(JSON.stringify(snapshot)).not.toContain('child-99');
    expect(JSON.stringify([current.plan, current.phaseHistory])).toBe(before);
  });
});
