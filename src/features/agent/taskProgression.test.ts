import { describe, expect, it } from "vitest";
import {
  findUnresolvedBlockingStep,
  latestTaskRequirement,
  resolveTaskProgression,
  selectAdjustmentSteps,
  selectBusinessReplanSteps,
  selectContinuationSteps,
} from "@/features/agent/taskProgression";
import type { OpsTask, PlanStep } from "@/types";
import type { ToolDefinition } from "@/features/tools/types";
import { buildCommandFailure } from "@/features/agent/commandStepResult";
import { currentEvidenceSteps, taskAttemptContext } from "@/features/agent/attemptState";
import { validateRecoveryReferences } from "@/features/agent/recoveryContract";

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
  it("preserves a regenerated proposal without rewriting prior successful observations", () => {
    const prior = step({ id: "prior-read", kind: "observe", command: "sysctl -n net.ipv4.ip_forward",
      validation: "", output: "0" });
    const change = step({ id: "enable-forwarding", kind: "change", command: "sysctl -w net.ipv4.ip_forward=1",
      validation: 'test "$(sysctl -n net.ipv4.ip_forward)" = 1', status: "pending" });
    const read = { ...prior, id: "fresh-read", status: "pending" as const, output: undefined };
    const before = JSON.stringify([prior, change, read]);
    expect(selectBusinessReplanSteps([prior], [change, read])).toEqual([change, read]);
    expect(JSON.stringify([prior, change, read])).toBe(before);
    expect(prior.status).toBe("completed");
    expect(change.status).toBe("pending");
    expect(selectBusinessReplanSteps([prior], [read])).toEqual([read]);
    expect(selectBusinessReplanSteps([prior], [read, change])).toEqual([read, change]);
  });

  it("does not silently deduplicate adjacent model-proposed reads", () => {
    const read = step({ id: "read-1", kind: "observe", command: "sysctl -n net.ipv4.ip_forward", validation: "", status: "pending" });
    const repeat = { ...read, id: "read-2" };
    const change = step({ id: "change", kind: "change", command: "sysctl -w net.ipv4.ip_forward=1", status: "pending" });
    expect(selectBusinessReplanSteps([], [read, repeat])).toEqual([read, repeat]);
    expect(selectBusinessReplanSteps([], [read, change, repeat, { ...repeat, id: "read-3" }]))
      .toEqual([read, change, repeat, { ...repeat, id: "read-3" }]);
  });

  it("does not remove model-proposed writes or observations that match completed history", () => {
    const read = step({ id: "old-read", kind: "observe", command: "sysctl -n net.ipv4.ip_forward", validation: "" });
    const change = step({ id: "old-change", kind: "change", command: "sysctl -w net.ipv4.ip_forward=1" });
    const repeatedChange = { ...change, id: "new-change", status: "pending" as const };
    const repeatedRead = { ...read, id: "new-read", status: "pending" as const };
    expect(selectBusinessReplanSteps([change, read], [repeatedChange, repeatedRead]))
      .toEqual([repeatedChange, repeatedRead]);
    const other = { ...repeatedChange, id: "different-change", command: "sysctl -w net.ipv6.conf.all.forwarding=1" };
    expect(selectBusinessReplanSteps([change, read], [other, repeatedChange, repeatedRead]))
      .toEqual([other, repeatedChange, repeatedRead]);
  });

  it("retains recovery verification against full failure history and never changes its acceptance contract", () => {
    const target = JSON.stringify(["server", "round", "session", 1, 0]);
    const failed = step({ id: "failed-change", kind: "change", status: "failed", attemptContext: target,
      command: "sysctl -w net.ipv4.ip_forward=1", validation: 'test "$(sysctl -n net.ipv4.ip_forward)" = 1',
      expected: "转发必须为 1" });
    const previousRead = step({ id: "prior-assertion", kind: "observe", command: failed.validation,
      expected: failed.expected, validation: "", attemptContext: target });
    const verify = { ...previousRead, id: "fresh-verification", status: "pending" as const,
      recovery: { failedStepId: failed.id, targetContext: target, purpose: "verify" as const } };
    // Even a matching completed query cannot stand in for the required,
    // explicitly linked verification of this unresolved failed attempt.
    const history = [failed, previousRead];
    const before = JSON.stringify(history);
    const selected = selectBusinessReplanSteps(history, [verify], target);
    expect(selected).toEqual([verify]);
    expect(() => validateRecoveryReferences(history, selected, target)).not.toThrow();
    expect(() => validateRecoveryReferences(history, [{ ...verify, expected: "命令能返回即可" }], target))
      .not.toThrow();
    expect(JSON.stringify(history)).toBe(before);
  });

  it("preserves all generated tool steps for hard protocol checks instead of filtering by business meaning", () => {
    const software = step({ id: "old-software", kind: "observe", command: 'opsark-tool software.check {"names":["node"]}', validation: "" });
    const userInput = step({ id: "old-input", kind: "observe", validation: "", command:
      'opsark-tool user.request_input {"title":"目标","fields":[{"key":"TARGET","label":"目标","description":"选择目标","type":"text","required":true}]}' });
    const connect = step({ id: "old-connect", kind: "observe", validation: "", command:
      'opsark-tool server.connect {"host":"10.0.0.2","credentialRef":"managed-server:target"}' });
    const change = step({ id: "install", kind: "change", command: "dnf install -y nodejs", status: "pending" });
    const candidates = [change, ...[software, userInput, connect].map(item => ({ ...item, id: `new-${item.id}`, status: "pending" as const }))];
    expect(selectBusinessReplanSteps([software, userInput, connect], candidates).map(item => item.id))
      .toEqual([change.id, "new-old-software", "new-old-input", "new-old-connect"]);
  });

  it("leaves retry usefulness to the model while evidence invalidation remains independently available", () => {
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
    expect(selectAdjustmentSteps(current.plan, [{ ...build, id: "repeat", status: "pending" }], context))
      .toEqual([{ ...build, id: "repeat", status: "pending" }]);
    // Persisted logs created before commandDispatched existed retain exit evidence.
    delete build.result!.facts.commandDispatched;
    expect(currentEvidenceSteps(current)).toEqual([]);
    build.result!.exitCode = undefined;
    build.evidence = [];
    build.result!.facts.category = "tool_command_parse";
    expect(currentEvidenceSteps(current)).toEqual([read]);
  });
  it("preserves a proposed health recheck regardless of prior mutation state", () => {
    const health = step({ command: "curl -f http://localhost/health", kind: "observe", validation: "", status: "failed" });
    for (const status of ["completed", "failed"] as const) {
      const restart = step({ id: "restart", kind: "change", command: "systemctl restart app", status });
      const candidate = { ...health, id: "retry", status: "pending" as const };
      expect(selectAdjustmentSteps([health], [candidate])).toEqual([candidate]);
      expect(selectAdjustmentSteps([health, restart], [candidate])).toEqual([candidate]);
      expect(selectContinuationSteps([{ ...health, status: "completed" }, restart], [candidate])).toEqual([candidate]);
    }
  });

  it("does not use target changes or canonical command identity to discard generated steps", () => {
    const prior = step({ command: 'opsark-tool files.get_structure {"rootPath":"/opt/app","maxDepth":4}',
      validation: "true", status: "failed", attemptContext: "target-a:v1" });
    const next = { ...prior, command: 'opsark-tool files.get_structure {"maxDepth":4,"rootPath":"/opt/app"}', status: "pending" as const };
    expect(selectAdjustmentSteps([prior], [next], "target-a:v1")).toEqual([next]);
    expect(selectAdjustmentSteps([prior], [next], "target-a:v2")).toEqual([next]);
  });

  it("exports only valid completed command identities while consuming the latest server switch", () => {
    const current = task([], { executionTargetServerId: "server-2", currentRoundId: "round-1" });
    const previousContext = JSON.stringify(["server-1", "round-1", "", 0, 0]);
    const currentContext = taskAttemptContext(current);
    const oldObservation = step({
      id: "old-target",
      kind: "observe",
      command: "uname -a",
      attemptContext: previousContext,
    });
    const serverSwitch = step({
      id: "connect-target",
      kind: "observe",
      command: 'opsark-tool server.connect {"host":"10.0.0.2","credentialRef":"managed-server:server-2"}',
      attemptContext: previousContext,
      output: '{"serverId":"server-2"}',
      result: {
        executionStatus: "success",
        observationStatus: "matched",
        facts: { toolId: "server.connect" },
        warnings: [],
        evidenceIds: [],
      },
    });
    const currentObservation = step({
      id: "current-target",
      kind: "observe",
      command: "pwd",
      attemptContext: currentContext,
    });
    current.plan = [oldObservation, serverSwitch, currentObservation];

    expect(selectContinuationSteps(current.plan, [
      { ...oldObservation, id: "recheck", status: "pending" },
      { ...serverSwitch, id: "reconnect", status: "pending" },
      { ...currentObservation, id: "duplicate-current", status: "pending" },
    ], currentContext).map(({ id }) => id)).toEqual(["recheck", "reconnect", "duplicate-current"]);

    current.executionTargetServerId = "server-3";
    expect(selectContinuationSteps(current.plan, [
      { ...serverSwitch, id: "return-to-server-2", status: "pending" },
    ], taskAttemptContext(current)).map(({ id }) => id)).toEqual(["return-to-server-2"]);
  });

  it("does not silently discard a proposed blocker recheck", () => {
    const health = step({ command: "curl -f http://localhost/health", kind: "observe", validation: "", status: "failed" });
    const restart = step({ id: "restart", kind: "change", command: "systemctl restart app", status: "pending" });
    expect(selectAdjustmentSteps([health, restart], [{ ...health, status: "pending" }]))
      .toEqual([{ ...health, status: "pending" }]);
    restart.status = "failed";
    restart.result = { executionStatus: "blocked", observationStatus: "unknown", facts: {}, warnings: [], evidenceIds: [] };
    expect(selectAdjustmentSteps([health, restart], [{ ...health, status: "pending" }]))
      .toEqual([{ ...health, status: "pending" }]);
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

  it("sends an exhausted read-only round to the joint next-stage decision", () => {
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
    expect(resolveTaskProgression(current)).toEqual({ kind: "complete" });
    current.discoveryRefined = true;
    expect(resolveTaskProgression(current)).toEqual({ kind: "complete" });
  });

  it("sends completed user-input evidence to the joint next-stage decision", () => {
    const current = task([step({
      title: "Need parameters",
      command: 'opsark-tool user.request_input {"title":"Deploy","fields":[{"key":"PORT","label":"服务端口","description":"项目对外监听端口","type":"number","required":true}]}',
    })]);
    expect(resolveTaskProgression(current)).toEqual({ kind: "complete" });
    current.refinementCount = 8;
    expect(resolveTaskProgression(current)).toEqual({ kind: "complete" });
  });

  it("does not let terminal-tool metadata force another business stage", () => {
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

    expect(resolveTaskProgression(current)).toEqual({ kind: "complete" });
  });

  it("does not let custom completion metadata replace the joint model decision", () => {
    const tools: ToolDefinition[] = [{
      id: "custom.discovery", implementation: "custom", name: "Custom", description: "Custom",
      usageInstructions: "Custom", inputSchema: {}, outputDescription: "Custom",
      completionMode: "refine", enabled: true, builtIn: false, version: 1, updatedAt: "now",
    }];
    const current = task([step({ command: 'opsark-tool custom.discovery {"scope":"all"}' })]);
    expect(resolveTaskProgression(current, tools)).toEqual({ kind: "complete" });
  });

  it("selects the first pending step and preserves all generated continuation commands", () => {
    const pending = step({ id: "pending", command: "npm test", status: "pending" });
    const current = task([step(), pending]);
    expect(resolveTaskProgression(current)).toEqual({ kind: "execute-step", step: pending });
    expect(selectContinuationSteps(current.plan, [
      step({ id: "duplicate", command: " npm test " }),
      step({ id: "new", command: "npm run build" }),
      step({ id: "new-copy", command: "npm run build" }),
    ]).map((item) => item.id)).toEqual(["duplicate", "new", "new-copy"]);
  });

  it.each(["awaiting_input", "awaiting_approval", "running", "validating"] as const)(
    "waits for a %s step instead of executing a later pending step",
    (status) => {
      const waiting = step({ id: "waiting", status });
      const pending = step({ id: "next", status: "pending" });
      const current = task([step({ id: "done" }), waiting, pending]);
      const snapshot = JSON.stringify(current);

      expect(resolveTaskProgression(current)).toEqual({ kind: "wait", step: waiting });
      expect(JSON.stringify(current)).toBe(snapshot);
    },
  );

  it.each(["awaiting_input", "awaiting_approval", "running", "validating"] as const)(
    "does not complete or refine a plan with a %s step and no pending steps",
    (status) => {
      const waiting = step({ id: "waiting", status });
      const tools: ToolDefinition[] = [{
        id: "custom.discovery", implementation: "custom", name: "Custom", description: "Custom",
        usageInstructions: "Custom", inputSchema: {}, outputDescription: "Custom",
        completionMode: "refine", enabled: true, builtIn: false, version: 1, updatedAt: "now",
      }];
      const current = task([
        step({ id: "done", command: "opsark-tool custom.discovery {}" }), waiting,
      ]);

      expect(resolveTaskProgression(current, tools)).toEqual({ kind: "wait", step: waiting });
      tools[0].completionMode = "complete";
      expect(resolveTaskProgression(current, tools)).toEqual({ kind: "wait", step: waiting });
      expect(resolveTaskProgression(task([waiting]))).toEqual({ kind: "wait", step: waiting });
    },
  );

  it("does not start a pending step in an out-of-order plan with an active execution", () => {
    const pending = step({ id: "pending", status: "pending" });
    const active = step({ id: "active", status: "running" });

    expect(resolveTaskProgression(task([pending, active]))).toEqual({ kind: "wait", step: active });
  });

  it("routes completed user input to the joint next-stage decision", () => {
    const input = step({
      id: "input", status: "awaiting_input",
      command: 'opsark-tool user.request_input {"title":"目标确认","fields":[{"key":"TARGET","label":"目标","description":"本次操作的目标","type":"text","required":true}]}',
    });
    const current = task([input]);

    expect(resolveTaskProgression(current)).toEqual({ kind: "wait", step: input });
    input.status = "completed";
    expect(resolveTaskProgression(current)).toEqual({ kind: "complete" });
    expect(current.status).toBe("running");
  });

  it("keeps terminal failures and skips available for existing progression and goal review", () => {
    const failed = step({ id: "failed", status: "failed" });
    const skipped = step({ id: "skipped", status: "skipped" });
    const pending = step({ id: "pending", status: "pending" });
    const current = task([failed, skipped, pending]);

    expect(resolveTaskProgression(current)).toEqual({ kind: "execute-step", step: pending });
    current.plan = [failed, skipped];
    expect(resolveTaskProgression(current)).toEqual({ kind: "complete" });
  });

  it("preserves unchanged and validation-only adjustment proposals for hard checks", () => {
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
    ]).map((item) => item.id)).toEqual(["same-tool", "fixed-validation"]);
  });

  it("keeps a blocker after a successful mutation until its original contract is verified", () => {
    const blocker = step({
      id: "blocker",
      validation: "test -d /opt/app",
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
    expect(findUnresolvedBlockingStep(blockedTask, current)).toBe(blocker);
    blocker.attemptContext = "target-1";
    const verify = step({ id: "verify", kind: "observe", command: blocker.validation, validation: "",
      attemptContext: "target-1", recovery: { failedStepId: blocker.id, targetContext: "target-1", purpose: "verify" },
      result: { executionStatus: "success", observationStatus: "matched", exitCode: 0,
        facts: {}, warnings: [], evidenceIds: ["verification"] },
      evidence: [{ id: "verification", type: "command", source: "main", facts: {}, rawOutput: "ok", collectedAt: "now" }],
    });
    blockedTask.plan.splice(2, 0, verify);
    expect(findUnresolvedBlockingStep(blockedTask, current)).toBeUndefined();
  });
});
