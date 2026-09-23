import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { confirmedInputScope } from "@/features/agent/confirmedUserInputs";
import { backend, PlanProtocolError, type PlanNormalizationRepair } from "@/services/backend";
import type { NextStageDecision, OpsTask, PermissionLevel, PlanStep, ServerProfile } from "@/types";
import { useOpsStore } from "./ops";
import missingSteps from "@/services/fixtures/next-stage-missing-steps.json";

const server: ServerProfile = {
  id: "protocol-server", name: "协议重规划测试", host: "protocol.example.invalid", port: 22,
  username: "tester", group: "test", status: "offline", environment: [], createdAt: "2026-09-16T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" },
};

const step = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  id: "replacement-check", title: "复核转发配置", description: "读取实际生效的内核转发状态",
  kind: "observe", command: "sysctl -n net.ipv4.ip_forward", validation: "", expected: "转发已启用",
  risk: "low", status: "pending", executionScope: "isolated_exec", ...overrides,
});

const change = (risk: PlanStep["risk"] = "medium") => step({
  id: "replacement-change", title: "启用内核转发", description: "按授权调整转发参数并独立验证",
  kind: "change", command: "sysctl -w net.ipv4.ip_forward=1",
  validation: "test \"$(sysctl -n net.ipv4.ip_forward)\" = 1", risk,
});

const nextStage = (
  steps: PlanStep[] = [change(), step()],
  overrides: Partial<NextStageDecision> = {},
): NextStageDecision => ({
  decision: "adjust",
  source: "model",
  steps,
  reason: "整体目标尚未完成，需要进入下一阶段",
  summary: "根据现有证据调整后续执行方案",
  ...overrides,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fixture(permission: PermissionLevel = "safe"): { store: ReturnType<typeof useOpsStore>; task: OpsTask } {
  const store = useOpsStore();
  const task = store.createTask(server.id, permission, "protocol-model");
  task.rootGoal = "部署 Kubernetes 并完成控制平面验收";
  task.currentInstruction = "根据检查证据继续部署";
  task.currentRoundId = "protocol-round";
  task.status = "needs_adjustment";
  task.pauseReason = "OBSERVE_COMMAND_MUTATION；PROTOCOL_REPAIR_NO_PROGRESS";
  task.plan = [step({
    id: "completed-inspection", command: "uname -a", status: "completed", output: "Linux fixture 6.12.0",
    result: { executionStatus: "success", observationStatus: "matched", exitCode: 0,
      facts: { kernel: "6.12.0" }, warnings: [], evidenceIds: ["inspection-evidence"] },
    evidence: [{ id: "inspection-evidence", type: "command-output", source: "main",
      rawOutput: "Linux fixture 6.12.0", facts: { kernel: "6.12.0" }, collectedAt: "2026-09-16T00:00:00Z" }],
  })];
  const repair: PlanNormalizationRepair = {
    errorCode: "plan_normalization_failed", repairStrategy: { type: "plan_protocol" },
    fieldPath: "steps[0].command", expected: "observe 主命令必须只读",
    validationError: "OBSERVE_COMMAND_MUTATION / steps[0].command / matchedToken=kubeadm",
    previousModelOutput: [step({ id: "rejected-dry-run", command: "kubeadm init --dry-run --kubernetes-version v1.31.14" })],
    instruction: "仅修复命令表达，不得扩大原计划业务范围",
    diagnostic: { code: "OBSERVE_COMMAND_MUTATION", stepIndex: 0, stepId: "rejected-dry-run",
      fieldPath: "steps[0].command", matchedToken: "kubeadm", expected: "observe 主命令必须只读",
      allowedRepairPaths: ["steps[0].command"], ruleVersion: 1 },
    progress: { scopeFingerprint: "original-scope", attemptedFingerprints: ["original-attempt"],
      seenPlans: ["original-plan"], attemptCount: 1, stopCode: "PROTOCOL_REPAIR_NO_PROGRESS" },
  };
  task.protocolRepair = { roundId: task.currentRoundId, serverId: task.serverId,
    repair, repairError: "PROTOCOL_REPAIR_NO_PROGRESS" };
  task.submittedInputs = {
    k8s_version: { value: "1.31", type: "text", label: "Kubernetes 版本", description: "沿用现有组件",
      groupId: "deployment-scope", groupTitle: "部署范围", submittedAt: "2026-09-16T00:00:00Z",
      scope: confirmedInputScope(task, "completed-input") },
  };
  store.pushMessage(task, { role: "user", kind: "message", content: task.rootGoal });
  return { store, task };
}

function generatedContext(index = 0) {
  const call = vi.mocked(backend.decideNextStage).mock.calls[index];
  return JSON.parse(call?.[1]?.context || "{}");
}

function completedPhaseFixture(permission: PermissionLevel = "safe") {
  const current = fixture(permission);
  const repair = clone(current.task.protocolRepair!.repair);
  current.task.protocolRepair = undefined;
  current.task.protocolRepairHistory = undefined;
  current.task.status = "running";
  current.task.pauseReason = undefined;
  current.task.discoveryRefined = false;
  current.task.refinementCount = 0;
  current.task.executionConstraints = {
    changePolicy: "allow_necessary_changes",
    environmentPolicy: "preserve",
    failurePolicy: "strict",
    prohibitedActions: [],
    requiredConditions: [],
    userDirectives: ["依据检查证据继续完成目标"],
  };
  return { ...current, repair };
}

describe("协议阻断后的人工业务重规划与重新审批", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    setActivePinia(createPinia());
    const store = useOpsStore();
    store.servers = [clone(server)];
    store.models = [{ id: "protocol-model", name: "测试模型", provider: "Test", model: "test-model",
      endpoint: "https://model.example.invalid", enabled: true, hasApiKey: true }];
    store.modelApiKeys["protocol-model"] = "fixture-api-key";
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue(undefined);
    vi.spyOn(backend, "deleteCredential").mockResolvedValue(undefined);
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue(undefined);
    vi.spyOn(backend, "generatePlan").mockResolvedValue([change(), step()]);
    vi.spyOn(backend, "decideNextStage").mockResolvedValue(nextStage());
    vi.spyOn(backend, "executeCommand").mockRejectedValue(new Error("unexpected command dispatch"));
    vi.spyOn(backend, "executeAgentCommand").mockRejectedValue(new Error("unexpected Agent command dispatch"));
    await useConnectionStore().connect(server.id, {
      host: server.host, port: server.port, username: server.username, password: "fixture-password",
    });
  });

  afterEach(() => {
    useOpsStore().tasks.forEach(task => { task.cancelRequested = true; });
    vi.restoreAllMocks();
  });

  it("普通调整首次遇到退出码协议错误时自动重规划并保留证据与审批", async () => {
    const { store, task, repair } = completedPhaseFixture();
    task.status = "needs_adjustment";
    const completed = clone(task.plan[0]);
    const rejected = { ...repair, diagnostic: undefined,
      validationError: "PIPELINE_STATUS_LOST / steps[0].command",
      previousModelOutput: [step({ command: "git ls-remote https://example.invalid/app.git | head -n 20" })],
    };
    vi.mocked(backend.decideNextStage).mockRejectedValueOnce(new PlanProtocolError(rejected, "PROTOCOL_REPAIR_SCOPE_UNKNOWN"));

    await store.beginAdjustment(task.id, true);

    expect(backend.decideNextStage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(generatedContext(1).protocolReplan)).toContain("PIPELINE_STATUS_LOST");
    expect(task.status).toBe("awaiting_plan_approval");
    expect(task.phaseHistory?.flatMap(phase => phase.plan)).toContainEqual(completed);
    expect(task.plan.map(item => item.command)).not.toContain(rejected.previousModelOutput[0].command);
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("人工调整创建新的变更与验证步骤，保留原轮次、目标、输入及已完成证据并等待计划审批", async () => {
    const { store, task } = fixture();
    const originalRepair = clone(task.protocolRepair);
    const completed = clone(task.plan[0]);
    const rootGoal = task.rootGoal;

    await store.requestAdjustment(task.id);

    expect(backend.decideNextStage).toHaveBeenCalledTimes(1);
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(task.status).toBe("awaiting_plan_approval");
    expect(task.currentRoundId).toBe("protocol-round");
    expect(task.rootGoal).toBe(rootGoal);
    expect(task.plan.map(item => item.kind)).toEqual(["change", "observe"]);
    expect(task.plan.every(item => item.id.startsWith("replan-step-"))).toBe(true);
    expect(new Set(task.plan.map(item => item.id)).size).toBe(2);
    expect(task.phaseHistory?.flatMap(phase => phase.plan)).toContainEqual(completed);
    expect(task.phaseHistory?.flatMap(phase => phase.plan).some(item => item.id === "rejected-dry-run")).toBe(false);
    expect(task.protocolRepair).toBeUndefined();
    expect(task.protocolRepairHistory).toHaveLength(1);
    expect(task.protocolRepairHistory?.[0]).toMatchObject({
      ...originalRepair, status: "accepted", requestedAt: expect.any(String),
      replacementStepIds: task.plan.map(item => item.id),
    });
    const context = generatedContext();
    expect(context.workflowPhase).toBe("decide_after_protocol_failure");
    expect(context.protocolReplan).toMatchObject({ rejectedPlanExecuted: false });
    expect(context.baseSnapshot).toBeDefined();
    expect(context.taskGoal.rootGoal).toBe(rootGoal);
    expect(context.confirmedUserInputs.items).toContainEqual(expect.objectContaining({ key: "k8s_version", value: "1.31" }));
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("协议事故后的联合决策允许直接判定目标完成，不再强制生成替代步骤", async () => {
    const { store, task } = fixture();
    const originalPlan = clone(task.plan);
    vi.mocked(backend.decideNextStage).mockResolvedValueOnce(nextStage([], {
      decision: "complete",
      reason: "既有执行证据已经满足整体目标",
      summary: "控制平面已经完成验收，无需执行额外步骤。",
    }));

    await store.requestAdjustment(task.id);

    expect(task.status).toBe("completed");
    expect(task.summary).toBe("控制平面已经完成验收，无需执行额外步骤。");
    expect(task.plan).toEqual(originalPlan);
    expect(task.protocolRepair).toBeUndefined();
    expect(task.protocolRepairHistory?.[0]).toMatchObject({
      status: "accepted",
      replacementStepIds: [],
      outcome: "控制平面已经完成验收，无需执行额外步骤。",
    });
    expect(backend.decideNextStage).toHaveBeenCalledOnce();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("协议事故后的 adjust 加空步骤进入 blocked/no_action，不循环要求生成计划", async () => {
    const { store, task } = fixture("managed");
    const originalPlan = clone(task.plan);
    vi.mocked(backend.decideNextStage).mockResolvedValueOnce(nextStage([], {
      reason: "当前缺少继续操作所需的用户授权",
      summary: "没有可执行的安全动作，等待用户补充授权。",
    }));

    await store.requestAdjustment(task.id);

    expect(task.status).toBe("awaiting_continuation");
    expect(task.pauseReason).toBe("没有可执行的安全动作，等待用户补充授权。");
    expect(task.plan).toEqual(originalPlan);
    expect(task.protocolRepair).toBeUndefined();
    expect(task.latestGoalReview).toMatchObject({
      decision: { decision: "adjust", source: "model" },
      nextPlan: [],
    });
    expect(task.protocolRepairHistory?.[0]).toMatchObject({
      status: "accepted",
      replacementStepIds: [],
      outcome: "blocked/no_action: 没有可执行的安全动作，等待用户补充授权。",
    });
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(task.managedStopReason).toBe("no_action");
    expect(task.autoAdjustmentSeconds).toBeUndefined();
    expect(backend.decideNextStage).toHaveBeenCalledOnce();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("托管模式按新步骤的高风险等待逐步审批，不继承旧 observe 的低风险", async () => {
    const { store, task } = fixture("managed");
    vi.mocked(backend.decideNextStage).mockResolvedValueOnce(nextStage([change("high"), step()]));

    await store.requestAdjustment(task.id);

    expect(task.status, task.pauseReason ?? JSON.stringify(task.messages)).toBe("awaiting_step_approval");
    expect(task.plan[0]).toMatchObject({ kind: "change", risk: "high", status: "awaiting_approval" });
    expect(task.protocolRepair).toBeUndefined();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("原查询执行成功但配置未达标时，新变更后保留相同查询作复验", async () => {
    const { store, task } = fixture();
    task.plan[0].command = step().command;
    task.plan[0].output = "0";
    const original = clone(task.plan[0]);

    await store.requestAdjustment(task.id);

    expect(task.status).toBe("awaiting_plan_approval");
    expect(task.plan.map(item => item.command)).toEqual([change().command, step().command]);
    expect(task.phaseHistory?.flatMap(phase => phase.plan)).toContainEqual(original);
    expect(task.plan[1].status).toBe("pending");
    expect(task.plan[1].result).toBeUndefined();
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("模型夹带的旧完成证据、身份和审批快照不会成为新步骤的运行状态", async () => {
    const { store, task } = fixture();
    const candidate = change("high");
    const approval = { command: candidate.command, validation: candidate.validation, risk: candidate.risk,
      executionScope: candidate.executionScope };
    vi.mocked(backend.decideNextStage).mockResolvedValueOnce(nextStage([{
      ...candidate, id: "completed-inspection", status: "completed", output: "model claimed success",
      result: clone(task.plan[0].result), evidence: clone(task.plan[0].evidence),
      attemptContext: "old-context", startedAt: "2026-09-15T00:00:00Z", elapsedSeconds: 300,
      approvedSafetySnapshot: approval, safetyApprovalSnapshot: approval,
      authenticationGate: { fingerprint: "old-authentication", reason: "old permission", approved: true },
    }]));

    await store.requestAdjustment(task.id);

    expect(task.status).toBe("awaiting_plan_approval");
    const replacement = task.plan[0];
    expect(replacement.id).not.toBe("completed-inspection");
    expect(replacement.status).toBe("pending");
    for (const key of ["output", "result", "evidence", "attemptContext", "startedAt", "elapsedSeconds",
      "approvedSafetySnapshot", "safetyApprovalSnapshot", "authenticationGate"] as const) {
      expect(replacement[key], key).toBeUndefined();
    }
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("已确认输入包含拒绝系统变更时，托管低风险新变更也要针对具体操作复核授权", async () => {
    const { store, task } = fixture("managed");
    task.submittedInputs!.prerequisite_mode = {
      value: "no-system-changes", type: "select", label: "系统前置调整授权", description: "暂不授权系统变更，仅报告现状",
      groupId: "deployment-scope", groupTitle: "部署范围", submittedAt: "2026-09-16T00:00:00Z",
      scope: confirmedInputScope(task, "completed-input"),
    };
    vi.mocked(backend.decideNextStage).mockResolvedValueOnce(nextStage([change("low")]));

    await store.requestAdjustment(task.id);

    expect(task.status, task.pauseReason ?? JSON.stringify(task.messages)).toBe("awaiting_step_approval");
    expect(task.plan[0].risk).toBe("low");
    expect(task.plan[0].protocolReplanApproval?.decisionSummary).toContain("no-system-changes");
    expect(task.messages.some(message => message.content.includes("no-system-changes"))).toBe(true);
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("新计划即便标为低风险也不能覆盖明确的 read_only 授权", async () => {
    const { store, task } = fixture("managed");
    const originalPlan = clone(task.plan);
    const originalRepair = clone(task.protocolRepair);
    task.executionConstraints = { changePolicy: "read_only", environmentPolicy: "preserve", failurePolicy: "strict",
      prohibitedActions: ["不得修改系统配置"], requiredConditions: [], userDirectives: ["仅检查现状"] };
    vi.mocked(backend.decideNextStage).mockResolvedValueOnce(nextStage([change("low")]));

    await store.requestAdjustment(task.id);

    expect(backend.decideNextStage).toHaveBeenCalledTimes(1);
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(generatedContext().executionConstraints.changePolicy).toBe("read_only");
    expect(task.status).toBe("needs_adjustment");
    expect(task.pauseReason).toContain("只读授权");
    expect(task.plan).toEqual(originalPlan);
    expect(task.protocolRepair).toEqual(originalRepair);
    expect(task.protocolRepairHistory?.[0].status).toBe("failed");
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("自动调整不将同一协议事故扩展为无限业务重规划", async () => {
    const { store, task } = fixture("managed");
    const originalRepair = clone(task.protocolRepair);

    await store.requestAdjustment(task.id, true);
    await store.beginAdjustment(task.id, true);
    await store.queueManagedAdjustment(task.id);

    expect(backend.decideNextStage).not.toHaveBeenCalled();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(task.protocolRepair).toEqual(originalRepair);
    expect(task.protocolRepairHistory ?? []).toHaveLength(0);
    expect(task.status).toBe("needs_adjustment");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("普通观察阶段结束后尊重模型无行动决定，不因旧 discovery 标记自动编造下一步", async () => {
    const { store, task } = completedPhaseFixture("managed");
    const originalPlan = clone(task.plan);
    vi.mocked(backend.decideNextStage).mockResolvedValueOnce(nextStage([], {
      reason: "缺少继续执行所需的事实或用户决定",
      summary: "当前没有可执行的后续步骤，保留证据等待补充",
    }));
    const runStep = vi.spyOn(store, "runStep");

    await store.advanceTask(task.id);
    await store.advanceTask(task.id);

    expect(backend.decideNextStage).toHaveBeenCalledOnce();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(task.status).toBe("awaiting_continuation");
    expect(task.latestGoalReview?.decision).toMatchObject({ decision: "adjust", source: "model" });
    expect(task.latestGoalReview?.nextPlan).toEqual([]);
    expect(task.plan).toEqual(originalPlan);
    expect(task.protocolRepair).toBeUndefined();
    expect(task.protocolRepairHistory ?? []).toHaveLength(0);
    expect(runStep).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("联合决策服务失败时保留执行记录并暂停，不自动生成替代业务行动", async () => {
    const { store, task } = completedPhaseFixture("managed");
    const originalPlan = clone(task.plan);
    vi.mocked(backend.decideNextStage).mockRejectedValueOnce(new Error("next-stage service unavailable"));
    const runStep = vi.spyOn(store, "runStep");

    await store.advanceTask(task.id);
    await store.advanceTask(task.id);

    expect(backend.decideNextStage).toHaveBeenCalledOnce();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(task.status).toBe("needs_adjustment");
    expect(task.plan).toEqual(originalPlan);
    expect(task.protocolRepair).toBeUndefined();
    expect(task.protocolRepairHistory ?? []).toHaveLength(0);
    expect(runStep).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("真实缺 steps 响应自动进入恢复，生成提问后等待用户且不执行远程命令", async () => {
    const { store, task } = completedPhaseFixture("safe");
    const completed = clone(task.plan[0]);
    const error = new PlanProtocolError({
      errorCode: "next_stage_response_invalid", validationError: "阶段联合决策结构解析失败：missing field steps",
      previousModelOutput: [], rawModelResponse: JSON.stringify(missingSteps), instruction: "返回完整联合决策",
    }, "响应无法解析");
    const question = step({ command: 'opsark-tool user.request_input {"title":"部署方式","description":"确认部署方式","fields":[{"key":"deployment","label":"部署方式","description":"请选择部署方式","type":"select","required":true,"options":[{"value":"host","label":"主机服务"},{"value":"container","label":"容器"}]}]}',
      validation: "true" });
    vi.mocked(backend.decideNextStage).mockRejectedValueOnce(error).mockResolvedValueOnce(nextStage([question]));

    await store.advanceTask(task.id);

    expect(backend.decideNextStage).toHaveBeenCalledTimes(2);
    expect(task.status).toBe("awaiting_input");
    expect(task.plan[0].status).toBe("awaiting_input");
    expect(task.phaseHistory?.flatMap(phase => phase.plan)).toContainEqual(completed);
    expect(task.protocolRepairHistory?.[0]).toMatchObject({
      status: "accepted", repair: { rawModelResponse: JSON.stringify(missingSteps) },
    });
    expect(generatedContext(1).protocolReplan.rejectedResponse.content).toContain("本轮仅提交一个提问步骤");
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("重复缺步骤响应有界暂停并保留原阶段证据，不降级为虚假的空计划", async () => {
    const { store, task } = completedPhaseFixture("managed");
    const original = clone(task.plan);
    const error = new PlanProtocolError({
      errorCode: "next_stage_response_invalid", validationError: "阶段联合决策结构解析失败：missing field steps",
      previousModelOutput: [], rawModelResponse: JSON.stringify(missingSteps), instruction: "返回完整联合决策",
    }, "响应无法解析");
    vi.mocked(backend.decideNextStage).mockRejectedValue(error);
    await store.advanceTask(task.id);
    await store.advanceTask(task.id);
    expect(backend.decideNextStage).toHaveBeenCalledTimes(2);
    expect(task.status).toBe("needs_adjustment");
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(task.pauseReason).toContain("响应格式不完整或不正确");
    expect(task.plan).toEqual(original);
    expect(task.protocolRepair?.repair.rawModelResponse).toBe(JSON.stringify(missingSteps));
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("阶段联合决策协议失败后由系统自动重规划，safe 低风险步骤直接衔接且不展示技术错误", async () => {
    const { store, task, repair } = completedPhaseFixture("safe");
    task.submittedInputs = undefined;
    const protocolError = new PlanProtocolError(repair, "PROTOCOL_REPAIR_SCOPE_VIOLATION: fixture detail");
    const replacement = change("low");
    vi.mocked(backend.decideNextStage)
      .mockRejectedValueOnce(protocolError)
      .mockResolvedValueOnce(nextStage([replacement]));
    const runStep = vi.spyOn(store, "runStep").mockResolvedValue(undefined);

    await store.advanceTask(task.id);

    expect(backend.decideNextStage).toHaveBeenCalledTimes(2);
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(task.protocolRepair).toBeUndefined();
    expect(task.protocolRepairHistory).toHaveLength(1);
    expect(task.protocolRepairHistory?.[0]).toMatchObject({
      status: "accepted",
      replacementStepIds: [task.plan[0].id],
    });
    expect(task.status).toBe("running");
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(runStep).toHaveBeenCalledWith(task.id, task.plan[0].id);
    expect(runStep).not.toHaveBeenCalledWith(task.id, "completed-inspection");
    expect(store.needsApproval("safe", task.plan[0])).toBe(false);
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();

    const visible = task.messages.map(message => message.content).join("\n");
    expect(visible).toContain("系统已按原任务授权自动衔接");
    expect(visible).not.toContain("完全托管模式已自动批准");
    expect(visible).not.toContain(repair.validationError);
    expect(visible).not.toContain("PROTOCOL_REPAIR_SCOPE_VIOLATION");
    expect(visible).not.toContain("PlanProtocolError");
    expect(store.logs).toContainEqual(expect.objectContaining({
      title: "系统从协议阻断自动转入业务重新规划",
      detail: expect.stringContaining('"triggerSource":"system_continuation"'),
    }));
    expect(store.developerLogs).toContainEqual(expect.objectContaining({
      operation: "workflow_progression",
      error: expect.stringContaining("PROTOCOL_REPAIR_SCOPE_VIOLATION"),
    }));
  });

  it("系统协议重规划在 managed 高风险步骤前停下等待具体步骤确认", async () => {
    const { store, task, repair } = completedPhaseFixture("managed");
    const protocolError = new PlanProtocolError(repair, "PROTOCOL_REPAIR_SCOPE_VIOLATION: fixture detail");
    vi.mocked(backend.decideNextStage)
      .mockRejectedValueOnce(protocolError)
      .mockResolvedValueOnce(nextStage([change("high")]));
    const runStep = vi.spyOn(store, "runStep");

    await store.advanceTask(task.id);

    expect(backend.decideNextStage).toHaveBeenCalledTimes(2);
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(task.status, task.pauseReason ?? JSON.stringify(task.messages)).toBe("awaiting_step_approval");
    expect(task.plan[0]).toMatchObject({ kind: "change", risk: "high", status: "awaiting_approval" });
    expect(store.needsApproval("managed", task.plan[0])).toBe(true);
    expect(runStep).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
    expect(task.messages.some(message => message.content.includes("系统已按原任务授权自动衔接"))).toBe(true);
    expect(task.messages.some(message => message.content.includes("完全托管模式已自动批准"))).toBe(false);
  });

  it("整体目标复核产生的后续方案协议阻断也会自动重新整理", async () => {
    const { store, task, repair } = completedPhaseFixture("safe");
    task.discoveryRefined = true;
    task.refinementCount = 1;
    const protocolError = new PlanProtocolError(repair, "PROTOCOL_REPAIR_SCOPE_VIOLATION: next-stage fixture");
    vi.mocked(backend.decideNextStage)
      .mockRejectedValueOnce(protocolError)
      .mockResolvedValueOnce(nextStage([step({
        id: "next-stage-replacement",
        command: "cat /proc/sys/net/ipv4/ip_forward",
      })]));
    const runStep = vi.spyOn(store, "runStep").mockResolvedValue(undefined);

    await store.advanceTask(task.id);

    expect(backend.decideNextStage).toHaveBeenCalledTimes(2);
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(task.status).toBe("running");
    expect(task.protocolRepair).toBeUndefined();
    expect(task.protocolRepairHistory?.[0]).toMatchObject({ status: "accepted" });
    expect(runStep).toHaveBeenCalledOnce();
    expect(store.developerLogs).toContainEqual(expect.objectContaining({
      operation: "workflow_progression",
      error: expect.stringContaining("next-stage fixture"),
    }));
    const visible = task.messages.map(message => message.content).join("\n");
    expect(visible).not.toContain(repair.validationError);
    expect(visible).not.toContain("next-stage fixture");
  });

  it("连续两个阶段联合决策的协议阻断不会被上一轮调整锁吞掉", async () => {
    const { store, task, repair } = completedPhaseFixture("managed");
    const secondRepair: PlanNormalizationRepair = {
      ...clone(repair),
      validationError: "OBSERVE_COMMAND_MUTATION / steps[1].command / matchedToken=redirect",
      previousModelOutput: [step({ id: "second-rejected", command: "printf data >/tmp/second-rejected" })],
    };
    vi.mocked(backend.decideNextStage)
      .mockRejectedValueOnce(new PlanProtocolError(repair, "first next-stage protocol stop"))
      .mockResolvedValueOnce(nextStage([step({ id: "phase-one", command: "cat /proc/version" })]))
      .mockRejectedValueOnce(new PlanProtocolError(secondRepair, "second next-stage protocol stop"))
      .mockResolvedValueOnce(nextStage([step({ id: "phase-two", command: "cat /proc/uptime" })]));
    const runStep = vi.spyOn(store, "runStep").mockImplementation(async (_taskId, stepId) => {
      if (runStep.mock.calls.length !== 1) return;
      const completed = task.plan.find(candidate => candidate.id === stepId)!;
      completed.status = "completed";
      completed.result = {
        executionStatus: "success",
        observationStatus: "matched",
        exitCode: 0,
        facts: { observed: true },
        warnings: [],
        evidenceIds: [],
      };
      task.status = "running";
      task.discoveryRefined = false;
      await store.advanceTask(task.id);
    });

    await store.advanceTask(task.id);

    expect(backend.decideNextStage).toHaveBeenCalledTimes(4);
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(task.protocolRepair).toBeUndefined();
    expect(task.protocolRepairHistory?.map(record => record.status)).toEqual(["accepted", "accepted"]);
    expect(task.status).toBe("running");
    expect(task.adjustmentInProgress).toBe(false);
    expect(task.managedAdjustmentPhase).toBeUndefined();
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("系统业务重规划再次违反协议时有界停止，拒绝计划与旧计划都不会远程执行", async () => {
    const { store, task, repair } = completedPhaseFixture("safe");
    const nextStageError = new PlanProtocolError(repair, "first protocol repair rejected");
    const rejectedAgain = {
      ...repair,
      validationError: "OBSERVE_COMMAND_MUTATION / steps[2].command / matchedToken=redirect",
      previousModelOutput: [change("low")],
    };
    const replanError = new PlanProtocolError(rejectedAgain, "PROTOCOL_REPAIR_SCOPE_VIOLATION: bounded stop");
    vi.mocked(backend.decideNextStage)
      .mockRejectedValueOnce(nextStageError)
      .mockRejectedValue(replanError);
    const runStep = vi.spyOn(store, "runStep");

    await store.advanceTask(task.id);

    expect(backend.decideNextStage).toHaveBeenCalledTimes(3);
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(task.status).toBe("needs_adjustment");
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(task.protocolRepair?.repair.validationError).toBe(rejectedAgain.validationError);
    expect(task.protocolRepairHistory).toHaveLength(1);
    expect(task.protocolRepairHistory?.[0]).toMatchObject({ status: "failed" });
    expect(runStep).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
    expect(store.developerLogs).toContainEqual(expect.objectContaining({
      operation: "protocol_business_replan",
      error: expect.stringContaining("bounded stop"),
    }));
    const visible = task.messages.map(message => message.content).join("\n");
    expect(visible).not.toContain(rejectedAgain.validationError);
    expect(visible).not.toContain("bounded stop");
    expect(visible).not.toContain("PlanProtocolError");
  });

  it("模型请求失败不丢失旧方案和协议事故，人工重试仍进入新计划而不是局部修复", async () => {
    const { store, task } = fixture();
    const originalPlan = clone(task.plan);
    const originalRepair = clone(task.protocolRepair);
    vi.mocked(backend.decideNextStage).mockRejectedValueOnce(new Error("fixture planner unavailable"));

    await store.requestAdjustment(task.id);

    expect(task.status).toBe("needs_adjustment");
    expect(task.plan).toEqual(originalPlan);
    expect(task.protocolRepair).toEqual(originalRepair);
    expect(task.protocolRepairHistory?.[0]).toMatchObject({ status: "failed", repair: originalRepair?.repair });
    expect(task.adjustmentInProgress).toBe(false);

    await store.requestAdjustment(task.id);

    expect(backend.decideNextStage).toHaveBeenCalledTimes(2);
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(generatedContext(1).workflowPhase).toBe("decide_after_protocol_failure");
    expect(task.status).toBe("awaiting_plan_approval");
    expect(task.protocolRepair).toBeUndefined();
    expect(task.protocolRepairHistory?.map(item => item.status)).toEqual(["failed", "accepted"]);
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("人工重复点击只产生一个在途新计划和一条协议审计记录", async () => {
    const { store, task } = fixture();
    let finish!: (decision: NextStageDecision) => void;
    vi.mocked(backend.decideNextStage).mockImplementationOnce(
      () => new Promise<NextStageDecision>(resolve => { finish = resolve; }),
    );
    const first = store.requestAdjustment(task.id);
    await vi.waitFor(() => expect(backend.decideNextStage).toHaveBeenCalledTimes(1));
    expect(task.protocolRepairHistory?.[0].status).toBe("planning");

    await store.requestAdjustment(task.id);
    finish(nextStage());
    await first;

    expect(backend.decideNextStage).toHaveBeenCalledTimes(1);
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(task.protocolRepairHistory).toHaveLength(1);
    expect(task.protocolRepairHistory?.[0].status).toBe("accepted");
    expect(task.status).toBe("awaiting_plan_approval");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("模型生成期间用户修改已确认输入，迟到的新计划不能覆盖旧计划或取得新授权", async () => {
    const { store, task } = fixture();
    const originalPlan = clone(task.plan);
    const originalRepair = clone(task.protocolRepair);
    let finish!: (decision: NextStageDecision) => void;
    vi.mocked(backend.decideNextStage).mockImplementationOnce(
      () => new Promise<NextStageDecision>(resolve => { finish = resolve; }),
    );
    const pending = store.requestAdjustment(task.id);
    await vi.waitFor(() => expect(backend.decideNextStage).toHaveBeenCalledTimes(1));

    task.submittedInputs!.k8s_version.value = "1.32";
    finish(nextStage());
    await pending;

    expect(task.status).toBe("needs_adjustment");
    expect(task.pauseReason).toContain("已确认输入发生变化");
    expect(task.plan).toEqual(originalPlan);
    expect(task.protocolRepair).toEqual(originalRepair);
    expect(task.protocolRepairHistory?.[0].status).toBe("failed");
    expect(task.protocolRepairHistory?.[0].replacementStepIds).toBeUndefined();
    expect(task.submittedInputs!.k8s_version.value).toBe("1.32");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("模型生成期间切换执行目标，迟到的协议错误不能绑定新服务器或覆盖原事故", async () => {
    const { store, task } = fixture();
    const originalPlan = clone(task.plan);
    const originalRepair = clone(task.protocolRepair)!;
    let reject!: (reason: unknown) => void;
    vi.mocked(backend.decideNextStage).mockImplementationOnce(
      () => new Promise<NextStageDecision>((_resolve, no) => { reject = no; }),
    );
    const pending = store.requestAdjustment(task.id);
    await vi.waitFor(() => expect(backend.decideNextStage).toHaveBeenCalledTimes(1));

    task.executionTargetServerId = "different-server";
    reject(new PlanProtocolError({ ...originalRepair.repair, validationError: "new response from old target" }, "late failure"));
    await pending;

    expect(task.status).toBe("needs_adjustment");
    expect(task.pauseReason).toContain("原协议事故保持原目标绑定");
    expect(task.executionTargetServerId).toBe("different-server");
    expect(task.plan).toEqual(originalPlan);
    expect(task.protocolRepair).toEqual(originalRepair);
    expect(task.protocolRepair?.serverId).toBe(server.id);
    expect(task.protocolRepairHistory?.[0]).toMatchObject({ serverId: server.id, status: "failed" });
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });

  it("重启时中断的协议业务重规划恢复为人工可重试，不保留无人处理的生成状态", () => {
    const { store, task } = fixture("managed");
    const originalPlan = clone(task.plan);
    const originalRepair = clone(task.protocolRepair)!;
    task.status = "planning";
    task.adjustmentInProgress = true;
    task.managedAdjustmentPhase = "generating";
    task.autoAdjustmentSeconds = 3;
    task.protocolRepairHistory = [{ ...originalRepair, requestedAt: "2026-09-16T00:01:00Z", status: "planning" }];
    store.persist(true);

    setActivePinia(createPinia());
    const restored = useOpsStore().tasks.find(item => item.id === task.id)!;

    expect(restored.status).toBe("needs_adjustment");
    expect(restored.managedAdjustmentPhase).toBe("manual_required");
    expect(restored.adjustmentInProgress).toBe(false);
    expect(restored.autoAdjustmentSeconds).toBeUndefined();
    expect(restored.pauseReason).toContain("重启中断");
    expect(restored.plan).toHaveLength(1);
    expect(restored.plan[0]).toMatchObject(originalPlan[0]);
    expect(restored.protocolRepair).toEqual(originalRepair);
    expect(restored.protocolRepairHistory?.[0]).toMatchObject({
      ...originalRepair, status: "failed", outcome: expect.stringContaining("应用重启中断规划"),
    });
    expect(backend.decideNextStage).not.toHaveBeenCalled();
    expect(backend.generatePlan).not.toHaveBeenCalled();
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.executeAgentCommand).not.toHaveBeenCalled();
  });
});
