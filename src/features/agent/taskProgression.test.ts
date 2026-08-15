import { describe, expect, it } from "vitest";
import {
  findUnresolvedBlockingStep,
  latestTaskRequirement,
  resolveTaskProgression,
  selectContinuationSteps,
} from "@/features/agent/taskProgression";
import type { OpsTask, PlanStep } from "@/types";

const step = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  id: overrides.id ?? "step-1",
  title: overrides.title ?? "Inspect",
  description: overrides.description ?? "Inspect state",
  command: overrides.command ?? "pwd",
  risk: overrides.risk ?? "low",
  expected: overrides.expected ?? "Known state",
  validation: overrides.validation ?? "pwd",
  status: overrides.status ?? "completed",
  ...overrides,
});

const task = (plan: PlanStep[], overrides: Partial<OpsTask> = {}): OpsTask => ({
  id: "task-1",
  serverId: "server-1",
  title: "Deploy application",
  status: "running",
  permission: "safe",
  modelId: "model-1",
  messages: [],
  plan,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
  ...overrides,
});

describe("taskProgression", () => {
  it("uses the latest user message requirement and ignores events", () => {
    const current = task([], {
      messages: [
        { id: "1", role: "user", kind: "message", content: "first", createdAt: "2026-08-14T00:00:00Z" },
        { id: "2", role: "user", kind: "event", content: "retry", createdAt: "2026-08-14T00:01:00Z" },
        { id: "3", role: "user", kind: "message", content: "latest", createdAt: "2026-08-14T00:02:00Z" },
      ],
    });
    expect(latestTaskRequirement(current)).toBe("latest");
  });

  it("refines a completed read-only discovery round only once", () => {
    const current = task([step({ title: "检查项目结构", command: "pwd" })], {
      executionConstraints: {
        changePolicy: "requested_changes_only",
        environmentPolicy: "preserve",
        failurePolicy: "strict",
        prohibitedActions: [],
        requiredConditions: [],
        userDirectives: [],
      },
    });
    expect(resolveTaskProgression(current)).toEqual({ kind: "refine-discovery" });
    current.discoveryRefined = true;
    expect(resolveTaskProgression(current)).toEqual({ kind: "complete" });
  });

  it("selects the first pending step and removes duplicate continuation commands", () => {
    const pending = step({ id: "pending", command: "npm test", status: "pending" });
    const current = task([step(), pending]);
    expect(resolveTaskProgression(current)).toEqual({ kind: "execute-step", step: pending });
    expect(selectContinuationSteps(current.plan, [
      step({ id: "duplicate", command: " npm test " }),
      step({ id: "new", command: "npm run build" }),
      step({ id: "new-copy", command: "npm run build" }),
    ]).map((item) => item.id)).toEqual(["new"]);
  });

  it("keeps a blocker until a successful mutating repair occurs", () => {
    const blocker = step({
      id: "blocker",
      result: {
        executionStatus: "success",
        observationStatus: "warning",
        facts: { blockingSignal: true },
        warnings: [],
        evidenceIds: [],
      },
    });
    const current = step({ id: "deploy", command: "systemctl restart app", status: "pending" });
    const blockedTask = task([blocker, current]);
    expect(findUnresolvedBlockingStep(blockedTask, current)).toBe(blocker);

    const repair = step({
      id: "repair",
      command: "apt-get install dependency",
      result: {
        executionStatus: "success",
        observationStatus: "matched",
        facts: {},
        warnings: [],
        evidenceIds: [],
      },
    });
    blockedTask.plan.splice(1, 0, repair);
    expect(findUnresolvedBlockingStep(blockedTask, current)).toBeUndefined();
  });
});
