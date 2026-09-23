import { describe, expect, it } from "vitest";
import type { OpsTask, PlanStep } from "@/types";
import { automaticContinuationBlocker, automaticContinuationStop, renewAutomaticPhaseBudget, observationIdentity, workflowProgress, MAX_AUTOMATIC_PHASES, MAX_OBSERVATION_PHASES } from "./workflowProgress";
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
      observed(`${i}`, `done-${i}`, { kind: "change" }))))).toContain("自动阶段预算");
  });
  it("renews only the phase budget, persists its boundary, and reaches a fresh finite limit", () => {
    const current = task(Array.from({ length: MAX_AUTOMATIC_PHASES }, (_, i) => observed(`${i}`, `done-${i}`, { kind: "change" })));
    const history = JSON.stringify(current.phaseHistory);
    expect(automaticContinuationStop(current)?.code).toBe("phase_budget_exhausted");
    expect(renewAutomaticPhaseBudget(current, "now")).toBe(true);
    expect(JSON.stringify(current.phaseHistory)).toBe(history);
    const restored: OpsTask = JSON.parse(JSON.stringify(current));
    expect(automaticContinuationStop(restored)).toBeUndefined();
    expect(workflowProgress(restored)).toMatchObject({ completedPhases: 12, automaticPhases: 0 });
    const next = task(Array.from({ length: 12 }, (_, i) => observed(`next-${i}`, `new-${i}`, { kind: "change" })));
    restored.phaseHistory!.push({ id: "previous", roundId: "round", requirement: "inspect", reason: "adjustment", plan: restored.plan, createdAt: "now", completedAt: "now" }, ...next.phaseHistory!);
    restored.plan = next.plan;
    expect(automaticContinuationStop(restored)?.code).toBe("phase_budget_exhausted");
    restored.currentRoundId = "another-round";
    expect(workflowProgress(restored).automaticPhases).toBe(1);
  });
  it("does not erase repeated evidence or stagnation when renewing an exhausted phase budget", () => {
    const current = task(Array.from({ length: 12 }, (_, i) => observed(`${i}`)));
    expect(renewAutomaticPhaseBudget(current, "now")).toBe(true);
    expect(automaticContinuationStop(current)?.code).toBe("no_progress");
    expect(workflowProgress(current).stagnantPhases).toBe(11);
  });
  it("starts a fresh observation budget after a confirmed user decision", () => {
    const decision = observed("decision", JSON.stringify({ values: { registry: "mirror.example" } }), {
      result: { executionStatus: "success", observationStatus: "matched",
        facts: { toolId: "user.request_input" }, warnings: [], evidenceIds: [] },
    });
    const current = task([
      ...Array.from({ length: MAX_OBSERVATION_PHASES }, (_, i) => observed(`before-${i}`, `sample-${i}`)),
      decision,
      observed("after", "new-state"),
    ]);

    expect(workflowProgress(current)).toMatchObject({ observationPhases: 1, stagnantPhases: 0 });
    expect(automaticContinuationBlocker(current)).toBeUndefined();
  });
  it("does not count a dispatched failed change as another observation-only phase", () => {
    const failedChange = observed("change-failed", "network timeout", {
      kind: "change",
      status: "failed",
      result: { executionStatus: "failed", observationStatus: "unknown", exitCode: 1,
        facts: { commandDispatched: true, category: "network_failure" }, warnings: [], evidenceIds: [] },
    });
    const current = task([
      ...Array.from({ length: MAX_OBSERVATION_PHASES }, (_, i) => observed(`before-${i}`, `sample-${i}`)),
      failedChange,
      observed("diagnose-new-failure", "registry timeout"),
    ]);

    expect(workflowProgress(current).observationPhases).toBe(1);
    expect(automaticContinuationBlocker(current)).toBeUndefined();
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
