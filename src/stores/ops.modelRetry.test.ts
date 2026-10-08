import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend, ModelInvocationError } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { resetExecutionLedgerForTests } from "@/services/executionLedger";
import type { ModelServiceError, NextStageDecision, PlanStep, ServerProfile } from "@/types";
import { useOpsStore } from "./ops";

const server: ServerProfile = { id: "server", host: "fixture.invalid", port: 22, username: "fixture", name: "test",
  group: "test", status: "offline", environment: [], createdAt: "2026-10-02T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
const formatError = (): ModelServiceError => ({ code: "MODEL_FORMAT_INVALID", origin: "core", stage: "json_parse",
  message: "响应不是合法 JSON", retryable: false, rawStatus: "stop" });
const declined = (error = formatError()) => new ModelInvocationError(error.message, undefined, error);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const read = (): PlanStep => ({ id: "new-read", title: "核对服务状态", description: "只读检查", kind: "observe",
  action: { type: "shell", command: "systemctl show core-case-static.service -p MainPID" },
  command: "systemctl show core-case-static.service -p MainPID", validation: "", expected: "真实PID", risk: "low", status: "pending" });
const next = (): NextStageDecision => ({ decision: "continue", source: "model", reason: "补只读证据", summary: "保持部署目标", steps: [read()] });

describe("explicit model planning retry", () => {
  beforeEach(async () => {
    vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
    const store = useOpsStore(); store.servers = [structuredClone(server)];
    store.models = [{ id: "model", name: "test", provider: "Test", model: "test", endpoint: "https://fixture.invalid", enabled: true, hasApiKey: true }];
    store.modelApiKeys.model = "fixture";
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue();
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue();
    vi.spyOn(backend, "configureTaskCapabilities").mockResolvedValue();
    vi.spyOn(backend, "executeCommand").mockResolvedValue({ success: true, simulated: true, exitCode: 0, output: "unused" });
    vi.spyOn(backend, "generatePlan").mockResolvedValue([]);
    vi.spyOn(backend, "processRequirement").mockResolvedValue({ intent: "execute", relation: "continue", plan: [] });
    await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: "fixture" });
  });
  afterEach(() => {
    const store = useOpsStore();
    for (const task of store.tasks) task.cancelRequested = true;
    store.stopConnectionMonitor(); store.persist(true); store.$dispose();
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  });

  function setup(permission: "safe" | "managed" = "safe", error = formatError()) {
    const store = useOpsStore();
    const task = store.createTask(server.id, permission, "model");
    task.status = "needs_adjustment"; task.rootGoal = "部署站点并给出访问地址"; task.currentInstruction = task.rootGoal; task.currentRoundId = "round";
    task.executionConstraints = { changePolicy: "requested_changes_only", environmentPolicy: "unspecified", failurePolicy: "unspecified",
      prohibitedActions: ["不得终止其他站点"], requiredConditions: [], userDirectives: [] };
    task.plan = [{ id: "built", title: "已完成构建", description: "原构建", kind: "change", command: "npm run build", expected: "构建产物",
      action: { type: "shell", command: "npm run build" }, validation: "test -s /app/dist/index.html", risk: "medium", status: "completed",
      output: "dist/index.html built", result: { executionStatus: "success", observationStatus: "matched", exitCode: 0,
        facts: { validationPassed: true }, warnings: [], evidenceIds: ["build-proof"] },
      evidence: [{ id: "build-proof", type: "command-output", source: "main", rawOutput: "dist/index.html built", facts: {}, collectedAt: "2026-10-02T03:15:00Z" }] }];
    store.recordModelPlanningBlocker(task, error);
    return { store, task };
  }

  it.each(["MODEL_FORMAT_INVALID", "MODEL_RECOVERY_SCOPE_REJECTED"])("blocks unchanged automatic requests but permits one explicit regeneration without replaying completed work: %s", async code => {
    const { store, task } = setup("safe", { ...formatError(), code,
      stage: code === "MODEL_RECOVERY_SCOPE_REJECTED" ? "format_repair_scope" : "json_parse" });
    const originalPlan = clone(task.plan), originalGoal = task.rootGoal, originalConstraints = clone(task.executionConstraints);
    const conditions = store.modelPlanningConditions(task);
    const decide = vi.spyOn(backend, "decideNextStage").mockResolvedValue(next());
    expect(store.stopBlockedModelPlanning(task)).toBe(true);
    await store.requestAdjustment(task.id, true);
    expect(decide).not.toHaveBeenCalled();
    await store.retryModelPlanning(task.id);
    expect(decide).toHaveBeenCalledOnce();
    expect(task.status, task.pauseReason).toBe("awaiting_plan_approval");
    expect(task.rootGoal).toBe(originalGoal);
    expect(task.currentRoundId).toBe("round");
    expect(task.executionConstraints).toEqual(originalConstraints);
    expect(task.phaseHistory?.flatMap(phase => phase.plan).find(step => step.id === "built")).toEqual(originalPlan[0]);
    expect(task.plan[0].id).toBe("new-read");
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.processRequirement).not.toHaveBeenCalled();
    expect(task.modelPlanningBlocker).toBeUndefined();
    const context = JSON.parse(decide.mock.calls[0][1]!.context);
    expect(context._modelRecovery).toMatchObject({ operationId: expect.any(String), startedAtMs: expect.any(Number) });
    expect(context.taskGoal.rootGoal).toBe(originalGoal);
    expect(conditions).toBeTypeOf("string");
  });

  it("coalesces concurrent explicit clicks and re-blocks automatic planning after another format failure", async () => {
    const { store, task } = setup("managed");
    const originalPlan = clone(task.plan), originalConditions = store.modelPlanningConditions(task);
    let reject!: (error: unknown) => void;
    const decide = vi.spyOn(backend, "decideNextStage").mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const first = store.retryModelPlanning(task.id);
    const duplicate = store.retryModelPlanning(task.id);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
    await store.retryModelPlanning(task.id);
    expect(decide).toHaveBeenCalledOnce();
    reject(declined());
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
    const firstContext = JSON.parse(decide.mock.calls[0][1]!.context);
    const secondContext = JSON.parse(decide.mock.calls[1][1]!.context);
    expect(secondContext._modelRecovery).toEqual(firstContext._modelRecovery);
    expect(secondContext._modelOutputRecovery.strategy).toBe("regenerate");
    await store.retryModelPlanning(task.id);
    expect(decide).toHaveBeenCalledTimes(2);
    reject(declined());
    await Promise.all([first, duplicate]);
    expect(task.modelPlanningBlocker?.error.code).toBe("MODEL_FORMAT_INVALID");
    expect(task.modelPlanningBlocker?.conditionsFingerprint).toBe(originalConditions);
    expect(task.plan).toEqual(originalPlan);
    expect(store.stopBlockedModelPlanning(task)).toBe(true);
    await store.requestAdjustment(task.id, true);
    await store.queueManagedAdjustment(task.id, 0);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(task.autoAdjustmentSeconds).toBeUndefined();
  });

  it("a cancelled retry cannot block a new round or release that round's newer retry owner", async () => {
    const { store, task } = setup();
    let finishOld!: () => void, finishNew!: () => void;
    const adjustment = vi.spyOn(store, "requestAdjustment")
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    const first = store.retryModelPlanning(task.id);
    expect(adjustment).toHaveBeenCalledOnce();
    task.cancelRequested = true;
    task.workflowEpoch = (task.workflowEpoch ?? 0) + 1;
    task.currentRoundId = "new-round";
    task.cancelRequested = false;
    store.recordModelPlanningBlocker(task, formatError());
    const second = store.retryModelPlanning(task.id);
    expect(adjustment).toHaveBeenCalledTimes(2);
    finishOld();
    await first;
    store.recordModelPlanningBlocker(task, formatError());
    await store.retryModelPlanning(task.id);
    expect(adjustment).toHaveBeenCalledTimes(2);
    finishNew();
    await second;
    expect(task.currentRoundId).toBe("new-round");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it.each(["INSUFFICIENT_CREDITS", "MODEL_AUTH_UNAVAILABLE", "MODEL_HTTP_ERROR", "MODEL_OUTPUT_TRUNCATED", "MODEL_RECOVERY_BUDGET_EXHAUSTED"])(
    "does not use the explicit format retry path for %s", async code => {
      const { store, task } = setup("managed", { code, message: "fixture refusal", retryable: false,
        ...(code === "MODEL_HTTP_ERROR" ? { httpStatus: 401 } : {}) });
      const blocker = clone(task.modelPlanningBlocker), original = clone(task.plan);
      const decide = vi.spyOn(backend, "decideNextStage").mockResolvedValue(next());
      await store.retryModelPlanning(task.id);
      expect(task.modelPlanningBlocker).toEqual(blocker);
      expect(task.plan).toEqual(original);
      expect(decide).not.toHaveBeenCalled();
      expect(backend.processRequirement).not.toHaveBeenCalled();
      expect(backend.executeCommand).not.toHaveBeenCalled();
    });

  it.each(["cancelled", "waiting-input", "already-planning"])("does not clear the blocker while %s", async mode => {
    const { store, task } = setup();
    if (mode === "cancelled") task.cancelRequested = true;
    if (mode === "waiting-input") task.plan.push({ ...read(), status: "awaiting_input" });
    if (mode === "already-planning") task.adjustmentInProgress = true;
    const blocker = clone(task.modelPlanningBlocker);
    const decide = vi.spyOn(backend, "decideNextStage").mockResolvedValue(next());
    await store.retryModelPlanning(task.id);
    expect(task.modelPlanningBlocker).toEqual(blocker);
    expect(decide).not.toHaveBeenCalled();
  });

  it("retries an initial planning failure in the same task without reclassifying or adding a user round", async () => {
    const { store, task } = setup();
    task.status = "planning_failed"; task.plan = [];
    store.recordModelPlanningBlocker(task, formatError());
    const submit = vi.spyOn(store, "submitRequirement").mockResolvedValue();
    const adjust = vi.spyOn(store, "requestAdjustment").mockResolvedValue();
    const taskCount = store.tasks.length;
    const userMessages = task.messages.filter(message => message.role === "user");
    await Promise.all([store.retryModelPlanning(task.id), store.retryModelPlanning(task.id)]);
    expect(submit).not.toHaveBeenCalled();
    expect(adjust).toHaveBeenCalledOnce();
    expect(adjust).toHaveBeenCalledWith(task.id);
    expect(task.status).toBe("needs_adjustment");
    expect(task.currentRoundId).toBe("round");
    expect(store.tasks).toHaveLength(taskCount);
    expect(task.messages.filter(message => message.role === "user")).toEqual(userMessages);
    expect(backend.processRequirement).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("does not treat an unexecuted early classification failure as completed without a requirement review", async () => {
    const { store, task } = setup();
    task.status = "planning_failed"; task.plan = []; task.requirementLifecycle = undefined;
    store.recordModelPlanningBlocker(task, formatError());
    const decide = vi.spyOn(backend, "decideNextStage").mockResolvedValue({ decision: "complete", reason: "没有剩余步骤", summary: "完成",
      source: "model", steps: [] });
    await store.retryModelPlanning(task.id);
    expect(decide).toHaveBeenCalled();
    expect(task.status).not.toBe("completed");
    expect(task.currentRoundId).toBe("round");
    expect(backend.processRequirement).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("can regenerate a read plan for the original unexecuted goal using its pending lifecycle", async () => {
    const { store, task } = setup();
    task.status = "planning_failed"; task.plan = []; task.requirementLifecycle = undefined;
    store.recordModelPlanningBlocker(task, formatError());
    const originalGoal = task.rootGoal;
    const decide = vi.spyOn(backend, "decideNextStage").mockImplementation(async (_requirement, model) => {
      const lifecycle = JSON.parse(model!.context).taskGoal.lifecycle;
      return { ...next(), requirementReview: { baseRevision: lifecycle.revision, roundId: "round",
        focusOutcome: "pending", overallOutcome: "pending", items: lifecycle.items.map((item: { id: string }) => ({
          requirementId: item.id, outcome: "unknown", evidenceIds: [], reason: "尚未执行，先读取当前状态",
        })) } };
    });
    await store.retryModelPlanning(task.id);
    expect(decide).toHaveBeenCalledOnce();
    expect(task.status, task.pauseReason).toBe("awaiting_plan_approval");
    expect(task.rootGoal).toBe(originalGoal);
    expect(store.tasks.find(item => item.id === task.id)?.requirementLifecycle?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: originalGoal, status: "active", evidenceIds: [] }),
    ]));
    expect(task.plan[0].action).toEqual(read().action);
    expect(backend.processRequirement).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it.each(["INSUFFICIENT_CREDITS", "MODEL_AUTH_UNAVAILABLE"])("a format retry that encounters %s stays blocked under the new cause", async code => {
    const { store, task } = setup("managed");
    const error: ModelServiceError = { code, message: "fixture refusal", retryable: false,
      ...(code === "MODEL_AUTH_UNAVAILABLE" ? { origin: "core", stage: "request_auth" } as const : {}) };
    const decide = vi.spyOn(backend, "decideNextStage").mockRejectedValue(declined(error));
    await store.retryModelPlanning(task.id);
    expect(task.modelPlanningBlocker?.error.code).toBe(code);
    await store.retryModelPlanning(task.id);
    await store.queueManagedAdjustment(task.id, 0);
    expect(decide).toHaveBeenCalledOnce();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });
});
