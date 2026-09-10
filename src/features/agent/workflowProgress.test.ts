import { describe, expect, it } from "vitest";
import type { OpsTask, PlanStep } from "@/types";
import { automaticContinuationBlocker, observationIdentity, workflowProgress, MAX_AUTOMATIC_PHASES, MAX_OBSERVATION_PHASES } from "./workflowProgress";
import { workflowLifetime } from "./workflowLifetime";

function observed(id: string, output = "STATE=ready", overrides: Partial<PlanStep> = {}): PlanStep {
  return { id, title: id, description: "observe", command: `inspect-${id}`, validation: "test state",
    kind: "observe", risk: "low", expected: "state", status: "completed", output,
    attemptContext: JSON.stringify(["server-a", "round", "session", 1, 0]),
    result: { executionStatus: "success", observationStatus: "matched", facts: { found: true, lineCount: 1 }, warnings: [], evidenceIds: [] },
    ...overrides };
}
function task(steps: PlanStep[]): OpsTask {
  return { id: "task", serverId: "server-a", title: "inspect", status: "awaiting_continuation", permission: "managed",
    modelId: "model", currentRoundId: "round", messages: [], plan: steps.slice(-1), createdAt: "now", updatedAt: "now",
    phaseHistory: steps.slice(0, -1).map(step => ({ id: step.id, roundId: "round", requirement: "inspect",
      reason: "adjustment", plan: [step], createdAt: "now", completedAt: "now" })) };
}

describe("generic workflow progress", () => {
  it("does not treat different command wording and bookkeeping as new facts", () => {
    const first = observed("a");
    const next = observed("b", "STATE=ready\n[exit: 0]");
    next.result!.facts.lineCount = 2;
    next.attemptContext = JSON.stringify(["server-a", "round", "new-session", 9, 0]);
    expect(observationIdentity(first)).toBe(observationIdentity(next));
    const current = task([first, next, observed("c")]);
    expect(workflowProgress(current)).toMatchObject({ stagnantPhases: 2, completedPhases: 3, rereadEvidence: true });
    expect(automaticContinuationBlocker(current)).toContain("没有新增执行事实");
  });
  it("distinguishes targets and actual state changes", () => {
    const other = observed("b", "STATE=ready", { attemptContext: JSON.stringify(["server-b", "round", "session", 1, 0]) });
    expect(observationIdentity(other)).not.toBe(observationIdentity(observed("a")));
    expect(automaticContinuationBlocker(task([observed("a"), other, observed("c", "STATE=active")]))).toBeUndefined();
  });
  it("bounds repeated discovery even if output formatting keeps changing", () => {
    const current = task(Array.from({ length: MAX_OBSERVATION_PHASES }, (_, i) => observed(`${i}`, `sample-${i}`)));
    expect(automaticContinuationBlocker(current)).toContain("停留在取证");
  });
  it("allows fresh verification after a mutation but bounds all automatic stages", () => {
    const changed = observed("change", "done", { kind: "change" });
    const current = task([observed("a"), observed("b"), changed, observed("c")]);
    expect(workflowProgress(current)).toMatchObject({ stagnantPhases: 0, observationPhases: 1 });
    expect(automaticContinuationBlocker(current)).toBeUndefined();
    expect(automaticContinuationBlocker(task(Array.from({ length: MAX_AUTOMATIC_PHASES }, (_, i) =>
      observed(`${i}`, `done-${i}`, { kind: "change" }))))).toContain("自动阶段上限");
  });
  it("does not count phases from another round or transport recovery", () => {
    const current = task([observed("a"), observed("b"), observed("c")]);
    current.phaseHistory!.forEach(phase => { phase.roundId = "old"; });
    expect(workflowProgress(current).completedPhases).toBe(1);
    current.plan[0].result!.facts.category = "validation_protocol_exception";
    expect(workflowProgress(current).completedPhases).toBe(0);
  });
  it("invalidates old async results even when a cancelled task is reused", () => {
    const current = task([observed("a")]);
    const lifetime = workflowLifetime(current);
    current.workflowEpoch = 1;
    current.cancelRequested = false;
    expect(lifetime.current()).toBe(false);
    expect(() => lifetime.assertCurrent()).toThrow("过期结果");
  });
});
