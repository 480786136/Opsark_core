import { describe, expect, it, vi } from "vitest";
import { ModelInvocationError, type RuntimeModel } from "@/services/backend";
import type { ModelProfile, ModelServiceError, NextStageDecision, OpsTask, PlanStep } from "@/types";
import { decideTaskNextStage } from "./agentService";
import { StaleWorkflowError } from "./workflowLifetime";
import { recordExecutionUncertainty } from "./operationalRecovery";

type Decider = (requirement: string, runtime?: RuntimeModel) => Promise<NextStageDecision>;
const model: ModelProfile = { id: "model", name: "fixture", provider: "Remote", model: "fixture",
  endpoint: "https://fixture.invalid", enabled: true, hasApiKey: true };
const time = "2026-10-03T01:00:00.000Z";
const read = (id: string, command: string): PlanStep => ({ id, title: "只读检查", description: "取得服务事实",
  kind: "observe", command, action: { type: "shell", command }, expected: "取得检查结果",
  validation: "", risk: "low", status: "pending" });

function setup() {
  const task: OpsTask = { id: "task", serverId: "server", title: "确认服务可用", rootGoal: "确认服务可用",
    status: "needs_adjustment", permission: "safe", modelId: model.id, currentRoundId: "round",
    createdAt: time, updatedAt: time,
    messages: [{ id: "user", role: "user", kind: "message", content: "确认服务可用，只检查不要修改", createdAt: time }],
    executionConstraints: { changePolicy: "read_only", environmentPolicy: "preserve", failurePolicy: "strict",
      prohibitedActions: ["重启服务"], requiredConditions: [], userDirectives: ["只检查不要修改"] },
    plan: [{ ...read("done", "pwd"), status: "completed", output: "/opt/existing-deployment",
      result: { executionStatus: "success", observationStatus: "matched", exitCode: 0,
        facts: { workingDirectory: "/opt/existing-deployment" }, warnings: [], evidenceIds: ["directory-evidence"] } }],
  };
  const candidate: NextStageDecision = { decision: "continue", source: "model", reason: "继续检查监听状态",
    summary: "还缺少可用性证据", steps: [read("next", "ss -lntp")] };
  const input = { task, model, apiKey: "fixture", tools: [], secretMetadata: [], skills: [],
    generationSettings: { limitOutput: false, maxPlanSteps: 6, maxOutputTokens: 5000,
      maxTextChars: 200, maxCommandChars: 4000 } };
  return { task, candidate, input };
}

function modelError(overrides: Partial<ModelServiceError> = {}) {
  return new ModelInvocationError("model output rejected", undefined, {
    code: "MODEL_FORMAT_INVALID", message: "响应不是完整 JSON", retryable: false,
    origin: "core", stage: "json_parse", dispatchCertainty: "response_received", ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("stage output recovery uses a bounded full-candidate regeneration", () => {
  it.each([
    { code: "MODEL_FORMAT_INVALID", stage: "json_parse" },
    { code: "MODEL_OUTPUT_TRUNCATED", stage: "response_status" },
    { code: "MODEL_RECOVERY_SCOPE_REJECTED", stage: "format_repair_scope" },
  ])("regenerates after $code with the same budget, goal, authority and execution facts", async (diagnostic) => {
    const { task, candidate, input } = setup();
    const before = structuredClone(task);
    const decide = vi.fn<Decider>().mockRejectedValueOnce(modelError(diagnostic)).mockResolvedValueOnce(candidate);

    const result = await decideTaskNextStage(input, decide);

    expect(decide).toHaveBeenCalledTimes(2);
    const [initial, regenerated] = decide.mock.calls.map(([, runtime]) => JSON.parse(runtime!.context));
    expect(initial._modelOutputRecovery.strategy).toBe("initial");
    expect(regenerated._modelOutputRecovery.strategy).toBe("regenerate");
    expect(regenerated._modelRecovery).toEqual(initial._modelRecovery);
    expect(regenerated._modelRecovery.operationId).toEqual(expect.any(String));
    expect(decide.mock.calls[1][0]).toBe(decide.mock.calls[0][0]);
    expect(regenerated.taskGoal).toEqual(initial.taskGoal);
    expect(regenerated.executionConstraints).toEqual(task.executionConstraints);
    expect(regenerated.permission).toBe("safe");
    expect(regenerated.baseSnapshot).toEqual(initial.baseSnapshot);
    expect(regenerated.baseSnapshot.currentPlan.steps[0]).toMatchObject({ stepId: "done", status: "completed",
      output: { content: "/opt/existing-deployment" }, result: { facts: { workingDirectory: "/opt/existing-deployment" } } });
    expect(result.nextPlan).toHaveLength(1);
    expect(result.nextPlan[0].action).toEqual(candidate.steps[0].action);
    expect(task).toEqual(before);
  });

  it("stops after the regenerated candidate also fails format validation", async () => {
    const { task, input } = setup();
    const before = structuredClone(task);
    const error = modelError();
    const decide = vi.fn<Decider>().mockRejectedValue(error);

    await expect(decideTaskNextStage({ ...input, recoverProtocolFailures: true }, decide)).rejects.toBe(error);

    expect(decide).toHaveBeenCalledTimes(2);
    const contexts = decide.mock.calls.map(([, runtime]) => JSON.parse(runtime!.context));
    expect(contexts.map(context => context._modelOutputRecovery.strategy)).toEqual(["initial", "regenerate"]);
    expect(contexts[1]._modelRecovery).toEqual(contexts[0]._modelRecovery);
    expect(task).toEqual(before);
  });

  it.each<Partial<ModelServiceError>>([
    { code: "MODEL_AUTH_UNAVAILABLE", stage: "authentication", httpStatus: 401 },
    { code: "MODEL_DISPATCH_UNKNOWN", stage: "request_recovery", dispatchCertainty: "may_have_dispatched" },
    { code: "MODEL_RECOVERY_BUDGET_EXHAUSTED", stage: "recovery_budget", recoveryBudget: { recoveryBlocked: false } },
    { code: "MODEL_FORMAT_INVALID", stage: "json_parse", dispatchCertainty: "may_have_dispatched" },
    { code: "MODEL_FORMAT_INVALID", stage: "json_parse", recoveryBudget: { recoveryBlocked: true } },
    { code: "MODEL_FORMAT_INVALID", stage: "json_parse", origin: "provider" },
    { code: "MODEL_RECOVERY_SCOPE_REJECTED", stage: "authorization" },
  ])("does not regenerate nonrecoverable $code at $stage", async (diagnostic) => {
    const { task, input } = setup();
    const before = structuredClone(task);
    const error = modelError(diagnostic);
    const decide = vi.fn<Decider>().mockRejectedValue(error);

    await expect(decideTaskNextStage({ ...input, recoverProtocolFailures: true }, decide)).rejects.toBe(error);

    expect(decide).toHaveBeenCalledOnce();
    expect(task).toEqual(before);
  });

  it("drops temporary metadata-repair restrictions when regenerating a whole candidate", async () => {
    const { task, candidate, input } = setup();
    task.requirementLifecycle = { version: 1, revision: 8, focus: { roundId: "round", requirementIds: ["availability"] },
      items: [{ id: "availability", kind: "goal", content: "确认服务可用", status: "active", evidenceIds: [],
        source: { content: "确认服务可用", source: "user_message", relation: "new_goal", sourceMessageId: "user", createdAt: time } }] };
    const replacement: NextStageDecision = { ...candidate, steps: [read("replacement", "systemctl status core.service --no-pager")],
      requirementReview: { baseRevision: 8, roundId: "round", focusOutcome: "pending", overallOutcome: "pending",
        items: [{ requirementId: "availability", outcome: "unknown", reason: "需要核对服务状态", evidenceIds: [] }] } };
    const before = structuredClone(task);
    const decide = vi.fn<Decider>().mockResolvedValueOnce(candidate).mockRejectedValueOnce(modelError())
      .mockResolvedValueOnce(replacement);

    const result = await decideTaskNextStage(input, decide);

    expect(decide).toHaveBeenCalledTimes(3);
    const [initial, local, regenerated] = decide.mock.calls.map(([, runtime]) => JSON.parse(runtime!.context));
    expect(local.operationalRepair.rejectedProposal.responseMode).toBe("metadata_fields");
    expect(regenerated._modelOutputRecovery.strategy).toBe("regenerate");
    expect(regenerated._modelRecovery).toEqual(initial._modelRecovery);
    expect(regenerated.operationalRepair).toBeUndefined();
    expect(regenerated.protocolRepairBudget).toBeUndefined();
    expect(regenerated.baseSnapshot).toEqual(initial.baseSnapshot);
    expect(regenerated.executionConstraints).toEqual(task.executionConstraints);
    expect(result.nextPlan[0].action).toEqual(replacement.steps[0].action);
    expect(task).toEqual(before);
  });

  it("still rejects a regenerated action that expands read-only authorization", async () => {
    const { task, candidate, input } = setup();
    candidate.steps = [{ ...read("restart", "systemctl restart core.service"), kind: "change", risk: "medium" }];
    const before = structuredClone(task);
    const decide = vi.fn<Decider>().mockRejectedValueOnce(modelError()).mockResolvedValueOnce(candidate);

    await expect(decideTaskNextStage(input, decide)).rejects.toThrow("只读授权不允许执行变更步骤");

    expect(decide).toHaveBeenCalledTimes(2);
    expect(task).toEqual(before);
  });

  it.each([
    { code: "MODEL_FORMAT_INVALID", stage: "json_parse" },
    { code: "MODEL_OUTPUT_REPAIR_EXHAUSTED", stage: "output_recovery" },
  ])("keeps execution reconciliation scoped even when its correction fails with $code", async diagnostic => {
    const { task, candidate, input } = setup();
    task.plan = [{ ...read("write", "npm run build"), kind: "change", status: "failed" }];
    recordExecutionUncertainty(task, task.plan[0], "连接中断，执行结果未知");
    candidate.steps = [{ ...read("replay", "npm run build"), kind: "change" }];
    const original = structuredClone(task);
    const error = modelError(diagnostic);
    const decide = vi.fn<Decider>().mockResolvedValueOnce(candidate).mockRejectedValueOnce(error);
    const onCandidateRegeneration = vi.fn();
    await expect(decideTaskNextStage({ ...input, onCandidateRegeneration }, decide)).rejects.toBe(error);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(JSON.parse(decide.mock.calls[1][1]!.context)._modelOutputRecovery.strategy).toBe("field_repair");
    expect(onCandidateRegeneration).not.toHaveBeenCalled();
    expect(task).toEqual(original);
  });

  it.each(["cancel", "round", "permission", "target"])("does not regenerate when %s occurs before the initial rejection arrives", async (change) => {
    const { task, input } = setup();
    const before = structuredClone(task.plan);
    const waiting = deferred<NextStageDecision>();
    const decide = vi.fn<Decider>().mockReturnValueOnce(waiting.promise);
    const result = decideTaskNextStage(input, decide).then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());

    if (change === "cancel") task.cancelRequested = true;
    else if (change === "round") task.currentRoundId = "new-round";
    else if (change === "permission") task.permission = "managed";
    else task.serverId = "different-server";
    waiting.reject(modelError());

    expect(await result).toMatchObject({ error: expect.any(StaleWorkflowError) });
    expect(decide).toHaveBeenCalledOnce();
    expect(task.plan).toEqual(before);
  });

  it.each(["cancel", "round"])("discards the regenerated result when %s occurs while it is pending", async (change) => {
    const { task, candidate, input } = setup();
    const before = structuredClone(task.plan);
    const waiting = deferred<NextStageDecision>();
    const decide = vi.fn<Decider>().mockRejectedValueOnce(modelError()).mockReturnValueOnce(waiting.promise);
    const result = decideTaskNextStage(input, decide).then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2));

    if (change === "cancel") task.cancelRequested = true;
    else task.currentRoundId = "new-round";
    waiting.resolve(candidate);

    expect(await result).toMatchObject({ error: expect.any(StaleWorkflowError) });
    expect(decide).toHaveBeenCalledTimes(2);
    expect(task.plan).toEqual(before);
    expect(task.requirementLifecycle).toBeUndefined();
  });
});
