import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { backend, buildPlanNormalizationRepair, PlanProtocolError } from "@/services/backend";
import type { OpsTask, PlanStep, ServerProfile } from "@/types";
import { useOpsStore } from "./ops";

const server: ServerProfile = {
  id: "clarification-server", host: "clarification.example.invalid", port: 22,
  username: "tester", name: "澄清流程测试", group: "test", status: "offline",
  environment: [], createdAt: "2026-09-14T00:00:00Z",
  info: { os: "Test OS", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" },
};

const step = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  id: "next-step", title: "读取目标信息", description: "只读获取目标信息",
  command: "printf 'READY\\n'", validation: "true", expected: "READY",
  kind: "observe", risk: "low", status: "pending", executionScope: "isolated_exec",
  ...overrides,
});

function inputStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return step({
    id: "clarification-step", title: "确认本次目标",
    description: "需要用户明确本次操作对象，不做任何环境变更",
    command: `opsark-tool user.request_input ${JSON.stringify({
      title: "确认目标", description: "目标信息不足，请先明确本次操作对象。",
      fields: [{ key: "TARGET", label: "目标", description: "本次操作的具体目标", type: "text", required: true }],
    })}`,
    expected: "用户明确目标", ...overrides,
  });
}

function selectionStep(options = [{ value: "target-a", label: "目标甲" }, { value: "target-b", label: "目标乙" }], required = true) {
  return inputStep({ command: `opsark-tool user.request_input ${JSON.stringify({
    title: "选择目标并确认范围", fields: [
      { key: "TARGET", label: "目标", description: "选择已发现的目标", type: "select", required, options },
      { key: "CONFIRMATION", label: "操作确认", description: "明确本次允许的操作范围", type: "text", required: true },
    ],
  })}` });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function createTask(): { store: ReturnType<typeof useOpsStore>; task: OpsTask } {
  const store = useOpsStore();
  const task = store.createTask(server.id, "safe", "clarification-model");
  task.status = "running";
  task.rootGoal = "检查指定目标的信息";
  task.currentRoundId = `round-${task.id}`;
  task.workflowEpoch = 1;
  store.pushMessage(task, { role: "user", kind: "message", content: task.rootGoal });
  return { store, task };
}

async function awaitingInputTask() {
  const context = createTask();
  context.task.plan = [inputStep()];
  await context.store.runStep(context.task.id, "clarification-step");
  expect(context.task.status).toBe("awaiting_input");
  const request = context.store.pendingUserInputs.find(item => item.taskId === context.task.id)!;
  expect(request).toBeDefined();
  return { ...context, request };
}

describe("通用澄清与审批的单次恢复", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    setActivePinia(createPinia());
    const store = useOpsStore();
    store.servers = [structuredClone(server)];
    store.models = [{
      id: "clarification-model", name: "测试模型", provider: "Test", model: "test-model",
      endpoint: "https://model.example.invalid", enabled: true, hasApiKey: true,
    }];
    store.modelApiKeys["clarification-model"] = "fixture-model-key";
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue(undefined);
    vi.spyOn(backend, "deleteCredential").mockResolvedValue(undefined);
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue(undefined);
    vi.spyOn(backend, "generatePlan").mockResolvedValue([step()]);
    vi.spyOn(backend, "processRequirement").mockResolvedValue({ intent: "execute", plan: [inputStep()] });
    vi.spyOn(backend, "executeCommand").mockResolvedValue({ success: true, simulated: true, output: "READY", exitCode: 0 });
    vi.spyOn(backend, "validateStep").mockResolvedValue({ passed: true, detail: "校验通过" });
    vi.spyOn(backend, "reviewStep").mockResolvedValue({ decision: "continue", reason: "证据一致", summary: "已确认", source: "model" });
    vi.spyOn(backend, "reviewGoal").mockResolvedValue({ decision: "complete", reason: "已有证据", summary: "已完成", source: "model" });
    vi.spyOn(backend, "decideNextStage").mockResolvedValue({ decision: "complete", reason: "已有证据", summary: "已完成", source: "model", steps: [] });
    await useConnectionStore().connect(server.id, {
      host: server.host, port: server.port, username: server.username, password: "fixture-ssh-password",
    });
  });

  afterEach(() => {
    useOpsStore().stopConnectionMonitor();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("托管模式不能无依据切换免密账号；等待用户批准后只执行一次", async () => {
    const { store, task } = createTask();
    task.permission = "managed";
    store.secretMetadata = [{ key: "DB_PASSWORD", serverId: server.id, scope: "server", description: "已存数据库凭据",
      credentialKind: "database", credentialRole: "secret", credentialTarget: "db.internal:3306" }];
    task.plan = [step({ command: 'mysql --socket=/run/mysql.sock -u root -e "SHOW DATABASES;"', validation: "" })];
    await store.runStep(task.id, "next-step");
    expect(task.status).toBe("awaiting_step_approval");
    expect(task.pauseReason).toContain("免密");
    expect(backend.executeCommand).not.toHaveBeenCalled();
    await store.advanceTask(task.id);
    await store.queueManagedAdjustment(task.id, 0);
    expect(backend.executeCommand).not.toHaveBeenCalled();
    await store.approveStep(task.id, "next-step");
    expect(backend.executeCommand).toHaveBeenCalledOnce();
    expect(task.authenticationEvidence?.[0].outcome).toBe("authenticated");
    expect(task.plan[0].authenticationGate).toBeUndefined();
  });

  it("复合认证命令不伪造认证证据，已有凭据时须确认", async () => {
    const { store, task } = createTask();
    task.permission = "managed";
    store.secretMetadata = [{ key: "DB_PASSWORD", serverId: server.id, scope: "server", description: "数据库凭据",
      credentialKind: "database", credentialRole: "secret", credentialTarget: "db.internal:3306" }];
    task.plan = [step({ command: 'mysql -Nse "SHOW DATABASES;" && echo done', validation: "" })];
    await store.runStep(task.id, "next-step");
    expect(task.status).toBe("awaiting_step_approval");
    expect(task.pauseReason).toContain("无法可靠解析");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("协议失败保留原始计划和两次错误，不触发自动业务调整", async () => {
    const { store, task } = createTask();
    const original = inputStep();
    const repair = buildPlanNormalizationRepair(new Error("第 1 个计划步骤的工具参数无效：字段错误"), [original]);
    const protocolError = new PlanProtocolError(repair, "不得改写 description");
    protocolError.processed = { intent: "execute", relation: "new_goal", plan: [original],
      selectedSkillIds: ["database-inspection-operations"] };
    vi.mocked(backend.processRequirement).mockRejectedValueOnce(protocolError);
    task.status = "draft";
    await store.submitRequirement(server.id, "检查目标信息", "managed", "clarification-model", task.id);
    const failed = store.tasks.find(item => item.protocolRepair);
    expect(failed).toBeDefined();
    expect(failed!.protocolRepair!.repair.previousModelOutput).toEqual([original]);
    expect(failed!.rootGoal).toBe("检查目标信息");
    expect(failed!.activeSkillIds).toContain("database-inspection-operations");
    expect(failed!.pauseReason).toContain("字段错误");
    expect(failed!.pauseReason).toContain("description");
    await store.queueManagedAdjustment(failed!.id, 0);
    await store.routeAutomaticAdjustment(failed!.id);
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(failed!.autoAdjustmentSeconds).toBeUndefined();
  });

  it.each(["awaiting_input", "awaiting_approval"] as const)(
    "%s 阻止推进、托管调整和直接执行残留的后续步骤",
    async (status) => {
      const { store, task } = createTask();
      task.permission = "managed";
      task.status = status === "awaiting_input" ? "awaiting_input" : "awaiting_step_approval";
      task.plan = [inputStep({ status }), step()];
      const before = JSON.stringify(task.plan);

      await store.advanceTask(task.id);
      await store.queueManagedAdjustment(task.id, 0);
      await store.runStep(task.id, "next-step");

      expect(task.status).toBe(status === "awaiting_input" ? "awaiting_input" : "awaiting_step_approval");
      expect(JSON.stringify(task.plan)).toBe(before);
      expect(backend.executeCommand).not.toHaveBeenCalled();
      expect(backend.generatePlan).not.toHaveBeenCalled();
      expect(backend.decideNextStage).not.toHaveBeenCalled();
      expect(backend.reviewGoal).not.toHaveBeenCalled();
    },
  );

  it.each(["awaiting_input", "awaiting_approval"] as const)(
    "任务错误地保留 running 时，也不能越过 %s 步骤",
    async (status) => {
      const { store, task } = createTask();
      task.plan = [inputStep({ status }), step()];

      await store.advanceTask(task.id);
      await store.runStep(task.id, "next-step");

      expect(task.plan.map(item => item.status)).toEqual([status, "pending"]);
      expect(backend.executeCommand).not.toHaveBeenCalled();
      expect(backend.generatePlan).not.toHaveBeenCalled();
      expect(backend.decideNextStage).not.toHaveBeenCalled();
    },
  );

  it("合法步骤批准并发点击只派发一次实际命令", async () => {
    const { store, task } = createTask();
    task.status = "awaiting_step_approval";
    task.plan = [step({ id: "approval-step", risk: "high", status: "awaiting_approval" })];
    const execution = deferred<Awaited<ReturnType<typeof backend.executeCommand>>>();
    vi.mocked(backend.executeCommand).mockReturnValueOnce(execution.promise);

    const first = store.approveStep(task.id, "approval-step");
    const repeated = store.approveStep(task.id, "approval-step");
    await vi.waitFor(() => expect(backend.executeCommand).toHaveBeenCalledTimes(1));
    execution.resolve({ success: true, simulated: true, output: "READY", exitCode: 0 });
    await Promise.all([first, repeated]);

    expect(backend.executeCommand).toHaveBeenCalledTimes(1);
    expect(task.plan[0].status).toBe("completed");
    expect(task.status).toBe("completed");
  });

  it("阶段验证中残留的审批按钮不能重新启动步骤", async () => {
    const { store, task } = createTask();
    task.status = "validating";
    task.plan = [step({ id: "old-approval", risk: "high", status: "awaiting_approval" })];

    await store.approveStep(task.id, "old-approval");

    expect(task.status).toBe("validating");
    expect(task.plan[0].status).toBe("awaiting_approval");
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.decideNextStage).not.toHaveBeenCalled();
  });

  it("同一个澄清请求重复提交只保存一份回答并生成一次后续计划", async () => {
    const { store, task, request } = await awaitingInputTask();
    const nextPlan = deferred<PlanStep[]>();
    vi.mocked(backend.generatePlan).mockReturnValueOnce(nextPlan.promise);

    const first = store.provideUserInput(task.id, { TARGET: "target-a" }, request.callId);
    const repeated = store.provideUserInput(task.id, { TARGET: "target-b" }, request.callId);
    await vi.waitFor(() => expect(backend.generatePlan).toHaveBeenCalledTimes(1));
    expect(task.submittedInputs?.TARGET.value).toBe("target-a");
    nextPlan.resolve([step({ id: "after-confirmation" })]);
    const results = await Promise.all([first, repeated]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(backend.generatePlan).toHaveBeenCalledTimes(1);
    expect(task.plan.find(item => item.id === "clarification-step")?.evidence).toHaveLength(1);
    expect(task.messages.filter(item => item.role === "user" && item.content.startsWith("已提交参数："))).toHaveLength(1);
    expect(store.pendingUserInputs.some(item => item.taskId === task.id)).toBe(false);
    expect(task.status).toBe("awaiting_plan_approval");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("错误 callId 不能消费当前的澄清表单", async () => {
    const { store, task, request } = await awaitingInputTask();

    expect(await store.provideUserInput(task.id, { TARGET: "wrong-target" }, "old-call")).toBe(false);

    expect(task.status).toBe("awaiting_input");
    expect(task.submittedInputs?.TARGET).toBeUndefined();
    expect(store.pendingUserInputs.find(item => item.taskId === task.id)?.callId).toBe(request.callId);
    expect(backend.generatePlan).not.toHaveBeenCalled();
  });

  it("敏感输入保存尚未结束时重复提交，也只能消费一次确认请求", async () => {
    const { store, task } = createTask();
    task.plan = [inputStep({ command: `opsark-tool user.request_input ${JSON.stringify({
      title: "补充访问参数", fields: [
        { key: "TARGET", label: "目标", description: "本次访问的目标", type: "text", required: true },
        { key: "ACCESS_TOKEN", label: "访问令牌", description: "本次目标访问所需的令牌", type: "password", required: true },
      ],
    })}` })];
    await store.runStep(task.id, "clarification-step");
    const request = store.pendingUserInputs.find(item => item.taskId === task.id)!;
    const saving = deferred<void>();
    const nextPlan = deferred<PlanStep[]>();
    vi.mocked(backend.saveCredential).mockReturnValueOnce(saving.promise);
    vi.mocked(backend.generatePlan).mockReturnValueOnce(nextPlan.promise);

    const first = store.provideUserInput(task.id, { TARGET: "target-a", ACCESS_TOKEN: "fixture-first-token" }, request.callId);
    await vi.waitFor(() => expect(backend.saveCredential).toHaveBeenCalledTimes(1));
    const repeated = store.provideUserInput(task.id, { TARGET: "target-b", ACCESS_TOKEN: "fixture-second-token" }, request.callId);
    const submissions = Promise.allSettled([first, repeated]);
    saving.resolve();
    await vi.waitFor(() => expect(backend.generatePlan).toHaveBeenCalledTimes(1));
    nextPlan.resolve([step({ id: "after-protected-input" })]);
    const results = await submissions;

    expect(results.every(result => result.status === "fulfilled")).toBe(true);
    expect(results.filter(result => result.status === "fulfilled" && result.value)).toHaveLength(1);
    expect(backend.saveCredential).toHaveBeenCalledTimes(1);
    expect(backend.generatePlan).toHaveBeenCalledTimes(1);
    expect(task.submittedInputs?.TARGET.value).toBe("target-a");
    expect(task.plan.find(item => item.id === "clarification-step")?.evidence).toHaveLength(1);
    expect(JSON.stringify(task.messages)).not.toContain("fixture-first-token");
    expect(JSON.stringify(task.messages)).not.toContain("fixture-second-token");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it.each(["round", "epoch"] as const)("旧 %s 的表单不能恢复当前任务", async (changed) => {
    const { store, task, request } = await awaitingInputTask();
    if (changed === "round") task.currentRoundId = "replacement-round";
    else task.workflowEpoch = (task.workflowEpoch ?? 0) + 1;

    expect(await store.provideUserInput(task.id, { TARGET: "stale-target" }, request.callId)).toBe(false);

    expect(task.status).toBe("awaiting_input");
    expect(task.submittedInputs?.TARGET).toBeUndefined();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it.each(["complete", "continue"] as const)("旧阶段的 %s 响应不能覆盖新一代的澄清等待", async (decision) => {
    const { store, task } = createTask();
    task.plan = [step({ status: "completed", output: "READY", result: {
      executionStatus: "success", observationStatus: "matched", exitCode: 0,
      facts: { found: true }, warnings: [], evidenceIds: [],
    } })];
    const response = deferred<Awaited<ReturnType<typeof backend.decideNextStage>>>();
    vi.mocked(backend.decideNextStage).mockReturnValueOnce(response.promise);
    const advancing = store.advanceTask(task.id);
    await vi.waitFor(() => expect(backend.decideNextStage).toHaveBeenCalledTimes(1));

    task.workflowEpoch = (task.workflowEpoch ?? 0) + 1;
    task.status = "running";
    task.plan = [inputStep({ id: "new-clarification" })];
    await store.runStep(task.id, "new-clarification");
    expect(task.status).toBe("awaiting_input");
    const pending = JSON.stringify(store.pendingUserInputs);
    response.resolve({
      decision, reason: "旧决策", summary: "旧结果", source: "model",
      steps: decision === "complete" ? [] : [step({ id: "old-next" })],
    });
    await advancing;

    expect(task.status).toBe("awaiting_input");
    expect(task.plan.map(item => item.id)).toEqual(["new-clarification"]);
    expect(JSON.stringify(store.pendingUserInputs)).toBe(pending);
    expect(task.summary).toBeUndefined();
    expect(task.latestGoalReview).toBeUndefined();
    expect(task.autoAdjustmentSeconds).toBeUndefined();
    expect(backend.reviewGoal).not.toHaveBeenCalled();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("新需求返回唯一澄清步骤时直接显示表单，不再要求先批准提问计划", async () => {
    const store = useOpsStore();

    await store.submitRequirement(server.id, "检查指定目标的信息", "safe", "clarification-model");

    const task = store.activeTask!;
    expect(task.status).toBe("awaiting_input");
    expect(store.pendingUserInputs.find(item => item.taskId === task.id)?.title).toBe("确认目标");
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.decideNextStage).not.toHaveBeenCalled();
  });

  it("遗留等待步骤不会因任务误处调整状态而触发重新规划", async () => {
    const { store, task, request } = await awaitingInputTask();
    task.permission = "managed";
    task.status = "needs_adjustment";
    await store.requestAdjustment(task.id);
    await store.beginAdjustment(task.id);
    await store.routeAutomaticAdjustment(task.id);
    await store.queueManagedAdjustment(task.id, 0);
    expect(store.pendingUserInputs[0].callId).toBe(request.callId);
    expect(task.autoAdjustmentSeconds).toBeUndefined();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("阶段复核返回澄清时直接等待，不进入自动调整计数", async () => {
    const { store, task } = createTask();
    task.permission = "managed";
    task.plan = [step({ status: "completed", output: "READY", result: {
      executionStatus: "success", observationStatus: "matched", exitCode: 0,
      facts: { found: true }, warnings: [], evidenceIds: [],
    } })];
    vi.mocked(backend.decideNextStage).mockResolvedValueOnce({
      decision: "adjust", reason: "需要用户决定操作对象", summary: "等待选择目标",
      source: "model", steps: [inputStep()],
    });
    await store.advanceTask(task.id);
    expect(task.status).toBe("awaiting_input");
    expect(store.pendingUserInputs).toHaveLength(1);
    expect(task.latestGoalReview).toBeUndefined();
    expect(task.adjustmentIncident).toBeUndefined();
    expect(task.autoAdjustmentSeconds).toBeUndefined();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("保存输入期间取消任务，不应用迟到的回答或恢复执行", async () => {
    const { store, task } = createTask();
    task.plan = [inputStep({ command: `opsark-tool user.request_input ${JSON.stringify({
      title: "补充访问参数", fields: [
        { key: "TARGET", label: "目标", description: "本次目标", type: "text", required: true },
        { key: "ACCESS_TOKEN", label: "令牌", description: "用于访问目标", type: "password", required: true },
      ],
    })}` })];
    store.presentTaskUserInput(task.id);
    const request = store.pendingUserInputs[0];
    const saving = deferred<void>();
    vi.mocked(backend.saveCredential).mockReturnValueOnce(saving.promise);
    const submitting = store.provideUserInput(task.id, { TARGET: "old-target", ACCESS_TOKEN: "fixture-token" }, request.callId);
    await vi.waitFor(() => expect(backend.saveCredential).toHaveBeenCalledOnce());
    store.rejectTask(task.id);
    saving.resolve();
    expect(await submitting).toBe(false);
    expect(task.status).toBe("cancelled");
    expect(task.submittedInputs?.TARGET).toBeUndefined();
    expect(task.submittedSecretBindings?.ACCESS_TOKEN).toBeUndefined();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("只读任务回答后继续生成只读计划，不把回答当执行批准", async () => {
    const { store, task, request } = await awaitingInputTask();
    task.refinementCount = 8;
    task.executionConstraints = { changePolicy: "read_only", environmentPolicy: "preserve", failurePolicy: "strict",
      prohibitedActions: [], requiredConditions: [], userDirectives: [] };
    expect(await store.provideUserInput(task.id, { TARGET: "target-a" }, request.callId)).toBe(true);
    expect(task.executionConstraints.changePolicy).toBe("read_only");
    expect(task.refinementCount).toBe(8);
    expect(task.status).toBe("awaiting_plan_approval");
    expect(task.plan[task.plan.length - 1]?.kind).toBe("observe");
    expect(backend.generatePlan).toHaveBeenCalledOnce();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("旧轮次凭据保存及回滚完成后才写新回答，不会删除新轮次凭据", async () => {
    const { store, task } = createTask();
    const protectedStep = (id: string) => inputStep({ id, command: `opsark-tool user.request_input ${JSON.stringify({
      title: "补充访问参数", fields: [
        { key: "TARGET", label: "目标", description: "本次目标", type: "text", required: true },
        { key: "ACCESS_TOKEN", label: "令牌", description: "用于访问目标", type: "password", required: true },
      ],
    })}` });
    task.plan = [protectedStep("old-input")];
    store.presentTaskUserInput(task.id);
    const oldRequest = store.pendingUserInputs[0];
    const saving = deferred<void>();
    let persisted: string | undefined;
    vi.mocked(backend.saveCredential).mockImplementation(async (_kind, _id, value) => {
      if (value === "old-fixture-token") await saving.promise;
      persisted = value;
    });
    vi.mocked(backend.deleteCredential).mockImplementation(async () => { persisted = undefined; });
    const oldSubmission = store.provideUserInput(task.id, { TARGET: "old-target", ACCESS_TOKEN: "old-fixture-token" }, oldRequest.callId);
    await vi.waitFor(() => expect(backend.saveCredential).toHaveBeenCalledOnce());

    task.currentRoundId = "replacement-round";
    task.status = "planning";
    task.plan = [protectedStep("new-input")];
    store.presentTaskUserInput(task.id);
    const newRequest = store.pendingUserInputs[0];
    const newSubmission = store.provideUserInput(task.id, { TARGET: "new-target", ACCESS_TOKEN: "new-fixture-token" }, newRequest.callId);
    expect(backend.saveCredential).toHaveBeenCalledOnce();
    saving.resolve();
    expect(await oldSubmission).toBe(false);
    expect(await newSubmission).toBe(true);
    expect(persisted).toBe("new-fixture-token");
    expect(task.submittedInputs?.TARGET.value).toBe("new-target");
    expect(task.plan[0].evidence).toHaveLength(1);
    expect(backend.generatePlan).toHaveBeenCalledOnce();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("回答后仍有新的必要问题，直接展示新表单且不执行或循环规划", async () => {
    const { store, task, request } = await awaitingInputTask();
    vi.mocked(backend.generatePlan).mockResolvedValueOnce([inputStep({
      id: "second-question", command: `opsark-tool user.request_input ${JSON.stringify({
        title: "确认影响范围", fields: [{ key: "SCOPE", label: "范围", description: "允许影响哪些对象", type: "text", required: true }],
      })}`,
    })]);
    expect(await store.provideUserInput(task.id, { TARGET: "target-a" }, request.callId)).toBe(true);
    expect(task.status).toBe("awaiting_input");
    expect(store.pendingUserInputs).toHaveLength(1);
    expect(store.pendingUserInputs[0].title).toBe("确认影响范围");
    expect(store.pendingUserInputs[0].callId).not.toBe(request.callId);
    await store.advanceTask(task.id);
    await store.queueManagedAdjustment(task.id, 0);
    expect(backend.generatePlan).toHaveBeenCalledOnce();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("重新打开应用恢复未回答表单，不恢复输入值也不调用模型", async () => {
    const { store, task, request } = await awaitingInputTask();
    store.persist(true);
    setActivePinia(createPinia());
    const restored = useOpsStore();
    const pending = restored.pendingUserInputs.find(item => item.taskId === task.id);
    expect(restored.tasks.find(item => item.id === task.id)?.status).toBe("awaiting_input");
    expect(pending).toMatchObject({ stepId: request.stepId, title: request.title, roundId: task.currentRoundId });
    expect(pending?.callId).not.toBe(request.callId);
    expect(pending).not.toHaveProperty("values");
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("选择器没有默认答案，空选或伪造选项均不能提交", async () => {
    const { store, task } = createTask();
    task.plan = [selectionStep()];
    expect(store.presentTaskUserInput(task.id)).toBe(true);
    const request = store.pendingUserInputs[0];
    expect(task.submittedInputs?.TARGET).toBeUndefined();
    expect(await store.provideUserInput(task.id, { TARGET: "", CONFIRMATION: "只读检查" }, request.callId)).toBe(false);
    expect(request.error).toContain("请选择");
    for (const value of ["unknown-target", "目标甲", " target-a "]) {
      expect(await store.provideUserInput(task.id, { TARGET: value, CONFIRMATION: "只读检查" }, request.callId)).toBe(false);
      expect(request.error).toContain("候选项");
    }
    expect(task.status).toBe("awaiting_input");
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.saveCredential).not.toHaveBeenCalled();
  });

  it("选择对象不能代替独立操作确认，合法选择按真实值保存并恢复", async () => {
    const { store, task } = createTask();
    task.plan = [selectionStep()];
    store.presentTaskUserInput(task.id);
    const request = store.pendingUserInputs[0];
    expect(await store.provideUserInput(task.id, { TARGET: "target-b", CONFIRMATION: "" }, request.callId)).toBe(false);
    expect(task.status).toBe("awaiting_input");
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(await store.provideUserInput(task.id, { TARGET: "target-b", CONFIRMATION: "只读检查" }, request.callId)).toBe(true);
    expect(task.submittedInputs?.TARGET).toMatchObject({ type: "select", value: "target-b" });
    expect(task.plan[0].output).toContain("target-b");
    expect(task.plan[0].evidence).toHaveLength(1);
    expect(backend.generatePlan).toHaveBeenCalledOnce();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    store.persist(true);
    setActivePinia(createPinia());
    expect(useOpsStore().tasks.find(item => item.id === task.id)?.submittedInputs?.TARGET)
      .toMatchObject({ type: "select", value: "target-b" });
  });

  it("选择值按候选身份精确保留，不在保存时去除字符", async () => {
    const { store, task } = createTask();
    task.plan = [selectionStep([{ value: " target with spaces ", label: "包含空格的目标标识" }])];
    store.presentTaskUserInput(task.id);
    const request = store.pendingUserInputs[0];
    expect(await store.provideUserInput(task.id, {
      TARGET: " target with spaces ", CONFIRMATION: "只读检查",
    }, request.callId)).toBe(true);
    expect(task.submittedInputs?.TARGET.value).toBe(" target with spaces ");
    expect(task.plan[0].output).toContain(" target with spaces ");
    expect(backend.saveCredential).not.toHaveBeenCalled();
  });

  it("可选选择清空后按未填写提交，不回退到第一个候选", async () => {
    const { store, task } = createTask();
    task.plan = [selectionStep(undefined, false)];
    task.submittedInputs = {
      TARGET: { type: "select", value: "target-a", label: "目标", description: "此前选择",
        groupId: "old-question", groupTitle: "历史问题", submittedAt: "2026-09-14T00:00:00Z" },
    };
    store.presentTaskUserInput(task.id);
    const request = store.pendingUserInputs[0];
    expect(await store.provideUserInput(task.id, {
      TARGET: "", CONFIRMATION: "暂不选择目标，不执行命令",
    }, request.callId)).toBe(true);
    expect(task.submittedInputs?.TARGET).toMatchObject({ type: "select", value: "" });
    expect(task.plan[0].output).not.toContain("target-a");
    expect(backend.generatePlan).toHaveBeenCalledOnce();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });
});
