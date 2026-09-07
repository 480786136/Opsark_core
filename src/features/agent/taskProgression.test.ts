import { describe, expect, it } from "vitest";
import {
  findUnresolvedBlockingStep,
  latestTaskRequirement,
  resolveTaskProgression,
  selectAdjustmentSteps,
  selectContinuationSteps,
} from "@/features/agent/taskProgression";
import type { OpsTask, PlanStep } from "@/types";
import type { ToolDefinition } from "@/features/tools/types";
<<<<<<< HEAD
=======
import { buildCommandFailure } from "@/features/agent/commandStepResult";
import { currentEvidenceSteps, taskAttemptContext } from "@/features/agent/attemptState";
>>>>>>> origin/master

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
<<<<<<< HEAD
=======
  it("invalidates observations after a real failed compound change while preventing its blind retry", () => {
    const current = task([]);
    const context = taskAttemptContext(current);
    const read = step({ id: "read", kind: "observe", command: "cat package-lock.json", attemptContext: context,
      result: { executionStatus: "success", observationStatus: "matched", facts: {}, warnings: [], evidenceIds: [] } });
    const failure = buildCommandFailure({ output: "installed packages\nBuild failed", exitCode: 1,
      evidenceId: "main", collectedAt: "2026-09-05T00:00:00Z" });
    const build = step({ id: "build", kind: "change", command: "npm install && npm run build",
      status: "failed", attemptContext: context, result: failure.result, evidence: failure.evidence });
    current.plan = [read, build];
    expect(currentEvidenceSteps(current)).toEqual([]);
    const candidate = { ...read, id: "recheck", status: "pending" as const };
    expect(selectAdjustmentSteps(current.plan, [candidate], context)).toEqual([candidate]);
    expect(selectAdjustmentSteps(current.plan, [{ ...build, id: "repeat", status: "pending" }], context)).toEqual([]);
    // Persisted logs created before commandDispatched existed retain exit evidence.
    delete build.result!.facts.commandDispatched;
    expect(currentEvidenceSteps(current)).toEqual([]);
    build.result!.exitCode = undefined;
    build.evidence = [];
    build.result!.facts.category = "tool_command_parse";
    expect(currentEvidenceSteps(current)).toEqual([read]);
  });
>>>>>>> origin/master
  it("rechecks health after an executed mutation, including a partially failed mutation", () => {
    const health = step({ command: "curl -f http://localhost/health", kind: "observe", validation: "", status: "failed" });
    for (const status of ["completed", "failed"] as const) {
      const restart = step({ id: "restart", kind: "change", command: "systemctl restart app", status });
      const candidate = { ...health, id: "retry", status: "pending" as const };
      expect(selectAdjustmentSteps([health], [candidate])).toEqual([]);
      expect(selectAdjustmentSteps([health, restart], [candidate])).toEqual([candidate]);
      expect(selectContinuationSteps([{ ...health, status: "completed" }, restart], [candidate])).toEqual([candidate]);
    }
  });

  it("invalidates attempts on target or credential changes and canonicalizes tool arguments", () => {
    const prior = step({ command: 'opsark-tool files.get_structure {"rootPath":"/opt/app","maxDepth":4}',
      validation: "true", status: "failed", attemptContext: "target-a:v1" });
    const next = { ...prior, command: 'opsark-tool files.get_structure {"maxDepth":4,"rootPath":"/opt/app"}', status: "pending" as const };
    expect(selectAdjustmentSteps([prior], [next], "target-a:v1")).toEqual([]);
    expect(selectAdjustmentSteps([prior], [next], "target-a:v2")).toEqual([next]);
  });

  it("does not invalidate a blocker for a planned or safety-blocked mutation", () => {
    const health = step({ command: "curl -f http://localhost/health", kind: "observe", validation: "", status: "failed" });
    const restart = step({ id: "restart", kind: "change", command: "systemctl restart app", status: "pending" });
    expect(selectAdjustmentSteps([health, restart], [{ ...health, status: "pending" }])).toEqual([]);
    restart.status = "failed";
    restart.result = { executionStatus: "blocked", observationStatus: "unknown", facts: {}, warnings: [], evidenceIds: [] };
    expect(selectAdjustmentSteps([health, restart], [{ ...health, status: "pending" }])).toEqual([]);
  });
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

  it("treats a completed user-input tool as discovery evidence", () => {
    const current = task([step({
      title: "Need parameters",
      command: 'opsark-tool user.request_input {"title":"Deploy","fields":[{"key":"PORT","label":"服务端口","description":"项目对外监听端口","type":"number","required":true}]}',
    })]);
    expect(resolveTaskProgression(current)).toEqual({ kind: "refine-discovery" });
  });

  it("refines after a terminal tool when its catalog metadata requires follow-up", () => {
    const current = task([step({
      title: "连接并切换服务器",
      command: 'opsark-tool server.connect {"host":"192.168.1.237","credentialRef":"managed-server:target"}',
    })], {
      activeSkillIds: ["ssh-terminal-jump"],
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
  });

  it("uses generic completion metadata for newly registered tools", () => {
    const tools: ToolDefinition[] = [{
      id: "custom.discovery", implementation: "custom", name: "Custom", description: "Custom",
      usageInstructions: "Custom", inputSchema: {}, outputDescription: "Custom",
      completionMode: "refine", enabled: true, builtIn: false, version: 1, updatedAt: "now",
    }];
    const current = task([step({ command: 'opsark-tool custom.discovery {"scope":"all"}' })]);
    expect(resolveTaskProgression(current, tools)).toEqual({ kind: "refine-discovery" });
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

  it("rejects an unchanged failed adjustment but permits a validation-only repair", () => {
    const failedTool = step({
      id: "failed-tool",
      command: 'opsark-tool files.get_structure {"rootPath":"/opt/app"}',
      validation: "true",
      status: "failed",
    });
    const failedShellValidation = step({
      id: "failed-shell-validation",
      command: "test -d /opt/app",
      validation: "test -f /wrong/path",
      status: "failed",
    });

    expect(selectAdjustmentSteps([failedTool, failedShellValidation], [
      step({ ...failedTool, id: "same-tool", status: "pending" }),
      step({
        ...failedShellValidation,
        id: "fixed-validation",
        validation: "test -d /opt/app",
        status: "pending",
      }),
    ]).map((item) => item.id)).toEqual(["fixed-validation"]);
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
