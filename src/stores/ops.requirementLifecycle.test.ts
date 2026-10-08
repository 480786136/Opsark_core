import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { useOpsStore } from "./ops";
import { modelTaskRequirementSnapshot } from "@/features/agent/taskGoal";
import { taskAttemptContext } from "@/features/agent/attemptState";
import { currentRequestCompleted } from "@/features/agent/taskDecisionResolution";
import type { NextStageDecision, RequirementProcessingResult, TaskRequirementUpdate } from "@/types";

const rootInstruction = "部署应用，只允许内网访问，端口使用 8080，并解决外部入口 502";
const portInstruction = "将端口改为 8081";
const firewallInstruction = "永久放行 8081，并确认重载后生效";

function response(
  content: string,
  rawContext: string,
  relation: "new_goal" | "supplement" | "replace_goal" | "continue",
  additions: TaskRequirementUpdate["additions"],
): RequirementProcessingResult {
  const { requirementSubmission } = JSON.parse(rawContext) as {
    requirementSubmission: { sourceMessageId: string; baseRevision: number; content: string };
  };
  expect(requirementSubmission.content).toBe(content);
  return {
    intent: "execute", relation,
    requirementUpdate: { baseRevision: requirementSubmission.baseRevision,
      sourceMessageId: requirementSubmission.sourceMessageId, additions, changes: [], focusIds: additions.map(item => item.id) },
    plan: [{ id: `read-${additions[0]?.id ?? "continue"}`, title: "读取当前状态", description: "只读准备检查", kind: "observe",
      command: "pwd", validation: "", expected: "返回当前目录", status: "pending", risk: "low" }],
  };
}

function initialResponse(content: string, context: string) {
  return response(content, context, "new_goal", [
    { id: "deploy", kind: "goal", content: "部署应用", sourceQuote: "部署应用", supersedes: [] },
    { id: "private", kind: "constraint", content: "只允许内网访问", sourceQuote: "只允许内网访问", supersedes: [] },
    { id: "port-8080", kind: "constraint", content: "端口使用 8080", sourceQuote: "端口使用 8080", supersedes: [] },
    { id: "entry", kind: "goal", content: "解决外部入口 502", sourceQuote: "解决外部入口 502", supersedes: [] },
  ]);
}

describe("requirement lifecycle through task submission and restart", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    localStorage.clear();
    localStorage.setItem("opsark.servers", JSON.stringify([{ id: "server", name: "Fixture", host: "example.invalid",
      port: 22, username: "fixture", group: "test", status: "offline", environment: [], createdAt: "2026-09-29",
      info: { os: "Test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } }]));
    localStorage.setItem("opsark.models", JSON.stringify([{ id: "model", name: "Fixture", provider: "Test", model: "test-model",
      endpoint: "https://model.example.invalid", enabled: true, hasApiKey: true }]));
    setActivePinia(createPinia());
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue(undefined);
    vi.spyOn(backend, "configureTaskCapabilities").mockResolvedValue();
    vi.spyOn(backend, "executeCommand").mockRejectedValue(new Error("This lifecycle test must never dispatch a remote command"));
    vi.spyOn(backend, "processRequirement").mockImplementation(async (content, runtime) => initialResponse(content, runtime.context ?? "{}"));
    useOpsStore().modelApiKeys.model = "fixture-key";
    await useConnectionStore().connect("server", { host: "example.invalid", port: 22, username: "fixture", password: "fixture-password" });
  });

  afterEach(() => {
    for (const task of useOpsStore().tasks) task.cancelRequested = true;
    useOpsStore().$dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function submitInitial() {
    const store = useOpsStore();
    await store.submitRequirement("server", rootInstruction, "safe", "model");
    const task = store.activeTask!;
    expect(task.status, task.pauseReason).toBe("awaiting_plan_approval");
    expect(task.requirementLifecycle?.revision).toBe(1);
    return { store, task };
  }

  async function completedFirewallObservation() {
    const { store, task } = await submitInitial();
    vi.mocked(backend.processRequirement).mockImplementationOnce(async (content, runtime) => response(content, runtime.context ?? "{}", "supplement", [
      { id: "firewall", kind: "goal", content: firewallInstruction, sourceQuote: firewallInstruction, supersedes: [] },
    ]));
    await store.submitRequirement("server", firewallInstruction, "safe", "model", "", task.id);
    const collectedAt = new Date(Date.now() + 1000).toISOString();
    const output = "PERMANENT_8081=yes\nRUNTIME_8081=yes\nLISTEN=10.0.0.1:8080";
    task.plan = [{ id: "verify-firewall", title: "核对防火墙与监听范围", description: "只读验收永久规则、运行规则和当前监听地址",
      kind: "observe", command: "firewall-cmd --permanent --query-port=8081/tcp && firewall-cmd --query-port=8081/tcp && ss -ltnp",
      validation: "", expected: "永久和运行规则均存在，服务仍在内网地址的 8080 端口监听", risk: "low", status: "completed",
      attemptContext: taskAttemptContext(task), startedAt: new Date(Date.now()).toISOString(), output,
      result: { executionStatus: "success", observationStatus: "matched", exitCode: 0, facts: { commandDispatched: true },
        warnings: [], evidenceIds: ["firewall-proof"] },
      evidence: [{ id: "firewall-proof", type: "command-output", source: "main", facts: {
        permanent8081: true, runtime8081: true, listenAddress: "10.0.0.1:8080",
      }, rawOutput: output, collectedAt, scope: { targetId: "server", scope: "isolated_exec", persistence: "host", doesNotProve: [] } }],
    }];
    task.status = "running";
    return { store, task };
  }

  it("keeps the root and private-access constraint while successive supplements replace the port and move the focus", async () => {
    const { store, task } = await submitInitial();
    vi.mocked(backend.processRequirement).mockImplementationOnce(async (content, runtime) => response(content, runtime.context ?? "{}", "supplement", [
      { id: "port-8081", kind: "constraint", content: portInstruction, sourceQuote: portInstruction, supersedes: ["port-8080"] },
    ]));
    await store.submitRequirement("server", portInstruction, "safe", "model", "", task.id);
    expect(task.status, task.pauseReason).toBe("awaiting_plan_approval");
    expect(task.requirementLifecycle?.items.find(item => item.id === "port-8080"))
      .toMatchObject({ status: "superseded", supersededBy: "port-8081" });
    expect(task.requirementLifecycle?.focus.requirementIds).toEqual(["port-8081"]);
    const secondRound = task.currentRoundId;

    vi.mocked(backend.processRequirement).mockImplementationOnce(async (content, runtime) => response(content, runtime.context ?? "{}", "supplement", [
      { id: "firewall", kind: "goal", content: firewallInstruction, sourceQuote: firewallInstruction, supersedes: [] },
    ]));
    await store.submitRequirement("server", firewallInstruction, "safe", "model", "", task.id);
    expect(task.status, task.pauseReason).toBe("awaiting_plan_approval");
    expect(task.rootGoal).toBe(rootInstruction);
    expect(task.currentInstruction).toBe(firewallInstruction);
    expect(task.currentRoundId).not.toBe(secondRound);
    expect(task.requirementLifecycle?.focus).toMatchObject({ roundId: task.currentRoundId, requirementIds: ["firewall"] });
    expect(task.requirementLifecycle?.items.find(item => item.id === "private"))
      .toMatchObject({ content: "只允许内网访问", status: "active", source: { content: rootInstruction } });
    expect(task.requirementLifecycle?.items.find(item => item.id === "entry")?.status).toBe("active");
    expect(modelTaskRequirementSnapshot(task).requirementContext.activeConstraints.map(item => item.id)).toEqual(["private", "port-8081"]);
    expect(task.requirementLifecycle?.revision).toBe(3);
    expect(store.tasks).toHaveLength(1);
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("retires an explicitly replaced port from execution constraints while preserving private access and policy gates", async () => {
    vi.mocked(backend.processRequirement).mockImplementationOnce(async (content, runtime) => ({
      ...initialResponse(content, runtime.context ?? "{}"),
      constraints: { changePolicy: "requested_changes_only", environmentPolicy: "preserve", failurePolicy: "strict",
        requiredConditions: ["端口使用 8080", "只允许内网访问"], prohibitedActions: ["只允许内网访问"], userDirectives: ["端口使用 8080"] },
    }));
    const { store, task } = await submitInitial();
    vi.mocked(backend.processRequirement).mockImplementationOnce(async (content, runtime) => ({
      ...response(content, runtime.context ?? "{}", "supplement", [
        { id: "port-8081", kind: "constraint", content: portInstruction, sourceQuote: portInstruction, supersedes: ["port-8080"] },
      ]),
      constraints: { changePolicy: "requested_changes_only", environmentPolicy: "unspecified", failurePolicy: "unspecified",
        requiredConditions: [portInstruction], prohibitedActions: [], userDirectives: [portInstruction] },
    }));
    await store.submitRequirement("server", portInstruction, "safe", "model", "", task.id);
    expect(task.status, task.pauseReason).toBe("awaiting_plan_approval");
    expect(task.executionConstraints).toMatchObject({ changePolicy: "requested_changes_only", environmentPolicy: "preserve", failurePolicy: "strict" });
    expect(task.executionConstraints?.requiredConditions).toEqual(["只允许内网访问", portInstruction]);
    expect(task.executionConstraints?.prohibitedActions).toEqual(["只允许内网访问"]);
    expect(task.executionConstraints?.userDirectives).toEqual([portInstruction]);
    expect(JSON.stringify(task.executionConstraints)).not.toContain("8080");
    expect(task.requirementLifecycle?.items.find(item => item.id === "port-8080")?.status).toBe("superseded");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("restores exact requirement sources, replacements and focus after visible messages are compacted", async () => {
    const { store, task } = await submitInitial();
    const longInstruction = `${firewallInstruction}；保持以下范围原文：${"/internal-only-path ".repeat(1200)}`;
    vi.mocked(backend.processRequirement).mockImplementationOnce(async (content, runtime) => response(content, runtime.context ?? "{}", "supplement", [
      { id: "firewall", kind: "goal", content: longInstruction, sourceQuote: longInstruction, supersedes: [] },
    ]));
    await store.submitRequirement("server", longInstruction, "safe", "model", "", task.id);
    const retained = JSON.parse(JSON.stringify(task.requirementLifecycle));
    const sourceMessageId = task.requirementLifecycle!.items.find(item => item.id === "firewall")!.source.sourceMessageId;
    task.messages.push(...Array.from({ length: 250 }, (_, index) => ({ id: `event-${index}`, role: "system" as const,
      kind: "event" as const, content: "已记录检查过程", createdAt: "2026-09-29T03:00:00Z" })));
    store.persist(true);
    const cached = JSON.parse(localStorage.getItem("opsark.tasks")!)[0];
    expect(cached.messages.some((message: { id: string }) => message.id === sourceMessageId)).toBe(false);
    store.$dispose();
    setActivePinia(createPinia());
    const restored = useOpsStore().tasks.find(item => item.id === task.id)!;
    expect(restored.requirementLifecycle).toEqual(retained);
    expect(restored.requirementLifecycle?.items.find(item => item.id === "firewall")?.source.content).toBe(longInstruction);
    expect(restored.requirementLifecycle?.items.find(item => item.id === "private")?.status).toBe("active");
    expect(restored.requirementLifecycle?.focus.requirementIds).toEqual(["firewall"]);
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("ignores a delayed requirement update after a newer workflow epoch has committed", async () => {
    const { store, task } = await submitInitial();
    let releaseOld!: (value: RequirementProcessingResult) => void;
    let staleResponse!: RequirementProcessingResult;
    vi.mocked(backend.processRequirement).mockImplementationOnce((content, runtime) => {
      staleResponse = response(content, runtime.context ?? "{}", "supplement", [
        { id: "port-8081", kind: "constraint", content: portInstruction, sourceQuote: portInstruction, supersedes: ["port-8080"] },
      ]);
      return new Promise(resolve => { releaseOld = resolve; });
    });
    const oldSubmission = store.submitRequirement("server", portInstruction, "safe", "model", "", task.id);
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf("function"));
    const oldEpoch = task.workflowEpoch;
    store.rejectTask(task.id);
    const latestInstruction = "将端口改为 9090";
    vi.mocked(backend.processRequirement).mockImplementationOnce(async (content, runtime) => response(content, runtime.context ?? "{}", "supplement", [
      { id: "port-9090", kind: "constraint", content: latestInstruction, sourceQuote: latestInstruction, supersedes: ["port-8080"] },
    ]));
    await store.submitRequirement("server", latestInstruction, "safe", "model", "", task.id);
    expect(task.workflowEpoch).toBeGreaterThan(oldEpoch!);
    expect(task.status, task.pauseReason).toBe("awaiting_plan_approval");
    const currentState = JSON.parse(JSON.stringify(task.requirementLifecycle));
    const currentRound = task.currentRoundId;
    releaseOld(staleResponse);
    await oldSubmission;
    expect(task.requirementLifecycle).toEqual(currentState);
    expect(task.currentRoundId).toBe(currentRound);
    expect(task.requirementLifecycle?.focus.requirementIds).toEqual(["port-9090"]);
    expect(task.requirementLifecycle?.items.some(item => item.id === "port-8081")).toBe(false);
    expect(task.plan[0].id).toBe("read-port-9090");
    expect(task.requirementProcessing).toBe(false);
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it.each(["new_goal", "replace_goal"] as const)("keeps original message identity when %s starts a separate goal", async relation => {
    const { store, task: original } = await submitInitial();
    const newInstruction = "检查 Redis 内存使用情况";
    let submissionMessageId = "";
    vi.mocked(backend.processRequirement).mockImplementationOnce(async (content, runtime) => {
      const result = response(content, runtime.context ?? "{}", relation, [
        { id: "redis", kind: "goal", content: newInstruction, sourceQuote: newInstruction, supersedes: [] },
      ]);
      submissionMessageId = result.requirementUpdate!.sourceMessageId;
      return result;
    });
    await store.submitRequirement("server", newInstruction, "safe", "model", "", original.id);
    const child = store.activeTask!;
    expect(child.id).not.toBe(original.id);
    expect(child.status, child.pauseReason).toBe("awaiting_plan_approval");
    expect(child.conversationId).toBe(original.conversationId ?? original.id);
    expect(child.rootGoal).toBe(newInstruction);
    expect(child.requirementLifecycle?.items.map(item => item.id)).toEqual(["redis"]);
    expect(child.requirementLifecycle?.items[0].source.sourceMessageId).toBe(submissionMessageId);
    expect(child.messages.find(message => message.role === "user" && message.content === newInstruction)?.id).toBe(submissionMessageId);
    expect(original.messages.some(message => message.id === submissionMessageId)).toBe(false);
    expect(original.rootGoal).toBe(rootInstruction);
    expect(original.requirementLifecycle?.items.find(item => item.id === "private")?.status).toBe("active");
    expect(original.status).toBe(relation === "replace_goal" ? "cancelled" : "awaiting_plan_approval");
    if (relation === "replace_goal") expect(original.goalCancellation?.reason).toBe("replaced");
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("continues with a changed focus without inventing a new business requirement or round", async () => {
    const { store, task } = await submitInitial();
    const originalItems = JSON.parse(JSON.stringify(task.requirementLifecycle!.items));
    const originalRound = task.currentRoundId;
    vi.mocked(backend.processRequirement).mockImplementationOnce(async (content, runtime) => {
      const result = response(content, runtime.context ?? "{}", "continue", []);
      result.requirementUpdate!.focusIds = ["entry"];
      return result;
    });
    await store.submitRequirement("server", "继续", "safe", "model", "", task.id);
    expect(task.status, task.pauseReason).toBe("awaiting_plan_approval");
    expect(task.currentRoundId).toBe(originalRound);
    expect(task.currentInstruction).toBe(rootInstruction);
    expect(task.lastRequirementRelation).toBe("continue");
    expect(task.requirementLifecycle?.items).toEqual(originalItems);
    expect(task.requirementLifecycle?.focus.requirementIds).toEqual(["entry"]);
    const continued = task.messages.find(message => message.role === "user" && message.content === "继续")!;
    expect(continued.requirementRelation).toBe("continue");
    expect(task.requirementLifecycle?.focus.sourceMessageId).toBe(continued.id);
    expect(modelTaskRequirementSnapshot(task).requirements.some(requirement => requirement.content === "继续")).toBe(false);
    expect(task.requirementLifecycle?.items.some(item => item.content === "继续")).toBe(false);
    expect(store.tasks).toHaveLength(1);
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("rejects a continue classification that attempts to cancel a binding requirement", async () => {
    const { store, task } = await submitInitial();
    const originalItems = JSON.parse(JSON.stringify(task.requirementLifecycle!.items));
    const diagnostics = vi.spyOn(store, "addDeveloperLog");
    vi.mocked(backend.processRequirement).mockImplementationOnce(async (content, runtime) => {
      const result = response(content, runtime.context ?? "{}", "continue", []);
      result.requirementUpdate!.focusIds = ["entry"];
      result.requirementUpdate!.changes = [{ id: "private", status: "cancelled", sourceQuote: "继续", reason: "错误地把继续当成撤销约束" }];
      return result;
    });
    await store.submitRequirement("server", "继续", "safe", "model", "", task.id);
    expect(task.status).toBe("planning_failed");
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ operation: "requirement_planning",
      summary: expect.stringContaining("不能新增、取消或修改要求") }));
    expect(task.requirementLifecycle?.items).toEqual(originalItems);
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it.each([false, true])("delivers a completed current request, retains pending goals and survives restart (repair complete: %s)", async repairComplete => {
    const { store, task } = await completedFirewallObservation();
    task.permission = "managed";
    const accepted: NextStageDecision = { decision: "adjust", reason: "本轮防火墙要求已有验收证据，旧外部入口问题仍待处理",
      summary: "8081 永久规则与运行规则已确认生效；原访问入口 502 尚未验收。", source: "model", steps: [],
      requirementReview: { baseRevision: task.requirementLifecycle!.revision, roundId: task.currentRoundId!,
        focusOutcome: "completed", overallOutcome: "pending", items: [
          { requirementId: "firewall", outcome: "satisfied", evidenceIds: ["firewall-proof"], reason: "永久与运行规则查询均成功" },
          { requirementId: "private", outcome: "satisfied", evidenceIds: ["firewall-proof"], reason: "服务保持内网地址监听" },
          { requirementId: "port-8080", outcome: "satisfied", evidenceIds: ["firewall-proof"], reason: "原服务仍在要求的 8080 端口监听" },
        ] } };
    const decide = vi.spyOn(backend, "decideNextStage").mockResolvedValue(accepted);
    if (repairComplete) decide.mockResolvedValueOnce({ ...accepted, decision: "complete" });
    await store.advanceTask(task.id);
    expect(task.status, task.pauseReason).toBe("awaiting_continuation");
    expect(task.currentRequestReview).toMatchObject({ roundId: task.currentRoundId, requirementRevision: 3,
      completed: true, remainingRequirementIds: ["deploy", "entry"] });
    expect(currentRequestCompleted(task)).toBe(true);
    expect(task.managedStopReason).toBe("request_completed");
    expect(task.managedAdjustmentPhase).toBe("manual_required");
    expect(task.messages.some(message => message.content.startsWith("本轮需求已完成"))).toBe(true);
    expect(task.messages.some(message => message.content.includes("后续流程暂不可用"))).toBe(false);
    expect(task.requirementLifecycle?.items.find(item => item.id === "entry")?.status).toBe("active");
    await store.queueManagedAdjustment(task.id, 0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backend.decideNextStage).toHaveBeenCalledTimes(repairComplete ? 2 : 1);
    if (repairComplete) {
      const repairContext = JSON.parse(decide.mock.calls[1][1]!.context!);
      expect(repairContext.operationalRepair.rejectedProposal.decision).toBe("complete");
      expect(repairContext.operationalRepair.reason).toContain("decision=adjust");
      expect(repairContext.protocolRepairBudget.remainingModelCalls).toBe(1);
    }
    expect(task.autoAdjustmentSeconds).toBeUndefined();
    store.persist(true);
    store.$dispose();
    setActivePinia(createPinia());
    const restored = useOpsStore().tasks.find(item => item.id === task.id)!;
    expect(restored.status).toBe("awaiting_continuation");
    expect(restored.managedStopReason).toBe("request_completed");
    expect(restored.currentRequestReview).toEqual(task.currentRequestReview);
    expect(currentRequestCompleted(restored)).toBe(true);
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });

  it("reuses the staged next plan after a requirement review increments the lifecycle revision", async () => {
    const { store, task } = await completedFirewallObservation();
    vi.spyOn(backend, "decideNextStage").mockResolvedValue({ decision: "continue", reason: "永久规则存在，本轮还需独立核对运行状态",
      summary: "继续执行本轮独立只读验收。", source: "model",
      steps: [{ id: "cached-next-check", title: "独立核对运行规则", description: "继续完成本轮只读验收",
        kind: "observe", command: "firewall-cmd --query-port=8081/tcp", validation: "", expected: "返回 yes",
        risk: "low", status: "pending" }],
      requirementReview: { baseRevision: task.requirementLifecycle!.revision, roundId: task.currentRoundId!,
        focusOutcome: "pending", overallOutcome: "pending", items: [
          { requirementId: "firewall", outcome: "unknown", evidenceIds: ["firewall-proof"], reason: "等待本轮独立验收" },
        ] } });
    await store.advanceTask(task.id);
    expect(task.status, task.pauseReason).toBe("awaiting_continuation");
    expect(task.requirementLifecycle?.revision).toBe(3);
    expect(task.latestGoalReview?.nextPlan?.map(step => step.id)).toEqual(["cached-next-check"]);
    expect(task.latestGoalReview?.policyFingerprint).toBeTruthy();
    await store.requestAdjustment(task.id);
    expect(task.status, task.pauseReason).toBe("awaiting_plan_approval");
    expect(task.plan.map(step => step.id)).toEqual(["cached-next-check"]);
    expect(backend.decideNextStage).toHaveBeenCalledOnce();
    expect(task.requirementLifecycle?.revision).toBe(3);
    expect(task.messages.some(message => message.content.includes("正在采用整体目标判断时已生成的下一阶段计划"))).toBe(true);
    expect(backend.executeCommand).not.toHaveBeenCalled();
  });
});
