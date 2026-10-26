import { describe, expect, it } from "vitest";
import type { OpsTask, PlanStep } from "@/types";
import { automaticContinuationBlocker, automaticContinuationStop, renewAutomaticPhaseBudget, observationIdentity, workflowProgress, MAX_AUTOMATIC_PHASES } from "./workflowProgress";
import { workflowLifetime } from "./workflowLifetime";
const LEGACY_OBSERVATION_LIMIT = 6;

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
  it.each([{ validationPassed: false }, { acceptancePassed: false },
    { semanticAcceptanceRequired: true, semanticAcceptanceStatus: "not_met" },
    { semanticAcceptanceRequired: true, semanticAcceptanceStatus: "unknown" }])(
    "does not reset stagnation for repeated exit-zero mutations with unproven acceptance: %j", facts => {
      const steps = ["a", "b", "c"].map(id => {
        const current = observed(id, "service remains unhealthy", { kind: "change", action: { type: "shell", command: `change-${id}` } });
        Object.assign(current.result!.facts, facts, { commandDispatched: true });
        return current;
      });
      expect(workflowProgress(task(steps))).toMatchObject({ stagnantPhases: 2, evidenceCount: 1 });
      expect(automaticContinuationStop(task(steps))?.code).toBe("no_progress");
    },
  );
  it.each([{ commandDispatched: false }, { dispatchState: "not_sent" }, { dispatchState: "unknown" }])(
    "does not infer progress from changed output when dispatch is not confirmed: %j", facts => {
      const steps = ["a", "b"].map(id => {
        const current = observed(id, `claimed-${id}`, { kind: "change" });
        Object.assign(current.result!.facts, facts);
        return current;
      });
      expect(workflowProgress(task(steps))).toMatchObject({ stagnantPhases: 2, evidenceCount: 0 });
      expect(automaticContinuationStop(task(steps))?.code).toBe("no_progress");
    },
  );
  it("allows a confirmed accepted change but does not change task or requirement completion", () => {
    const change = observed("changed", "service healthy", { kind: "change" });
    Object.assign(change.result!.facts, { commandDispatched: true, semanticAcceptanceRequired: true, semanticAcceptanceStatus: "proven" });
    const current = task([observed("a"), observed("b"), change]);
    const before = JSON.stringify(current);
    expect(workflowProgress(current)).toMatchObject({ stagnantPhases: 0, observationPhases: 0 });
    expect(JSON.stringify(current)).toBe(before);
    expect(current.status).toBe("awaiting_continuation");
  });
  it("uses adapter business fingerprints instead of changed envelopes, prose or unrelated extra facts", () => {
    const probe = (id: string): PlanStep => observed(id, JSON.stringify({ callId: id, data: { installed: false }, timestamp: id }), {
      action: { type: "tool", toolId: "software.check", arguments: { names: ["python3"] } },
      result: { executionStatus: "success", observationStatus: "matched", warnings: [], evidenceIds: [id], facts: {
        evidenceComplete: true, evidenceKind: "software_check", evidenceScope: "python3", evidenceFingerprint: "returned:missing",
        extraDescription: id,
      } },
    });
    const first = probe("first"), second = probe("second"), third = probe("third");
    // Persisted mistakes cannot turn the read-only tool into a mutation boundary.
    second.kind = "change";
    expect(observationIdentity(first)).toEqual(observationIdentity(second));
    expect(workflowProgress(task([first, second, third])).stagnantPhases).toBe(2);
    expect(automaticContinuationStop(task([first, second, third]))?.code).toBe("no_progress");
    third.result!.facts.evidenceFingerprint = "returned:installed";
    expect(workflowProgress(task([first, second, third])).stagnantPhases).toBe(0);
  });
  it("counts carried pending steps only when executed, not their earlier archived plan", () => {
    const pending = observed("carried", "", { status: "pending", result: undefined });
    const current = task([observed("first"), observed("carried", "built", { kind: "change" })]);
    current.phaseHistory![0].plan.push(pending);
    expect(workflowProgress(current)).toMatchObject({ completedPhases: 2, stagnantPhases: 0, observationPhases: 0 });
    const exhausted = task(Array.from({ length: MAX_AUTOMATIC_PHASES }, (_, i) => observed(`${i}`, `built-${i}`, { kind: "change" })));
    exhausted.phaseHistory![0].plan.push(pending);
    expect(renewAutomaticPhaseBudget(exhausted, "now")).toBe(true);
    expect(exhausted.automaticPhaseBudget!.stepIds).not.toContain("carried");
  });
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
  it("allows distinct read-only evidence beyond six observation phases", () => {
    const current = task(Array.from({ length: LEGACY_OBSERVATION_LIMIT }, (_, i) => observed(`${i}`, `sample-${i}`)));
    expect(automaticContinuationBlocker(current)).toBeUndefined();
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
  it("retains evidence identities but reviews old stagnation on an explicit continuation", () => {
    const current = task(Array.from({ length: 12 }, (_, i) => observed(`${i}`)));
    expect(renewAutomaticPhaseBudget(current, "now")).toBe(true);
    expect(automaticContinuationStop(current)).toBeUndefined();
    expect(workflowProgress(current)).toMatchObject({ stagnantPhases: 0, evidenceCount: 1 });
    current.phaseHistory!.push({ id: "last", roundId: "round", requirement: "inspect", reason: "adjustment", plan: current.plan, createdAt: "now", completedAt: "now" });
    current.plan = [observed("repeat-1")];
    expect(workflowProgress(current).stagnantPhases).toBe(1);
    current.phaseHistory!.push({ id: "again", roundId: "round", requirement: "inspect", reason: "adjustment", plan: current.plan, createdAt: "now", completedAt: "now" });
    current.plan = [observed("repeat-2")];
    expect(automaticContinuationStop(current)?.code).toBe("no_progress");
  });
  it("does not inherit another target's phase exemptions when continuing a stagnant task", () => {
    const current = task([observed("a"), observed("b"), observed("c")]);
    current.automaticPhaseBudget = { roundId: "round", serverId: "server-b", stepIds: ["a", "b", "c"], renewedAt: "before" };
    expect(renewAutomaticPhaseBudget(current, "now")).toBe(true);
    expect(current.automaticPhaseBudget.stepIds).toEqual([]);
    expect(workflowProgress(current)).toMatchObject({ automaticPhases: 3, stagnantPhases: 0 });
  });
  it("starts a fresh observation budget after a confirmed user decision", () => {
    const decision = observed("decision", JSON.stringify({ values: { registry: "mirror.example" } }), {
      result: { executionStatus: "success", observationStatus: "matched",
        facts: { toolId: "user.request_input" }, warnings: [], evidenceIds: [] },
    });
    const current = task([
      ...Array.from({ length: LEGACY_OBSERVATION_LIMIT }, (_, i) => observed(`before-${i}`, `sample-${i}`)),
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
      ...Array.from({ length: LEGACY_OBSERVATION_LIMIT }, (_, i) => observed(`before-${i}`, `sample-${i}`)),
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
