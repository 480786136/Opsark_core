import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { assertPlanRepairScope, backend, buildPlanNormalizationRepair, normalizePlanPreconditions, PlanProtocolError } from "@/services/backend";
import { textFingerprint } from "@/features/agent/longRunningReviewOutput";
import { planCommandIdentity } from "@/features/agent/taskProgression";
import { buildContinuationContext } from "@/features/agent/agentContext";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import type { OpsTask, PlanStep } from "@/types";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.resetAllMocks(); });

const malformedStep: PlanStep = {
  id: "request-git-credential",
  kind: "observe",
  title: "收集 Git 凭据",
  description: "仅在匿名探测证明需要认证后收集",
  command: "opsark-tool user.request_input {}",
  expected: "获得凭据引用",
  validation: "true",
  risk: "low",
  status: "pending",
};

const standaloneStagePlan: PlanStep[] = [
  {
    id: "inspect-local",
    kind: "observe",
    title: "检查本机环境",
    description: "确认本机基础状态",
    command: "uname -a",
    expected: "返回本机系统信息",
    validation: "",
    risk: "low",
    status: "pending",
  },
  {
    id: "inspect-software",
    kind: "observe",
    title: "检查本机软件",
    description: "确认本机容器与 Kubernetes 工具状态",
    command: "command -v containerd kubeadm kubelet kubectl",
    expected: "返回本机相关工具路径",
    validation: "",
    risk: "low",
    status: "pending",
  },
  {
    id: "inspect-kernel",
    kind: "observe",
    title: "检查内核条件",
    description: "确认本机内核和交换分区状态",
    command: "swapon --show; sysctl net.ipv4.ip_forward",
    expected: "返回内核和交换分区证据",
    validation: "",
    risk: "low",
    status: "pending",
  },
  {
    id: "probe-worker",
    kind: "observe",
    title: "检查工作节点可达性",
    description: "确认工作节点 SSH 端口可达",
    command: "nc -z -w 3 10.213.81.53 22",
    expected: "工作节点 SSH 端口可达",
    validation: "",
    risk: "low",
    status: "pending",
  },
  {
    id: "resolve-worker",
    kind: "observe",
    title: "查询工作节点连接资料",
    description: "查询目标工作节点的受管连接引用",
    command: 'opsark-tool server.resolve_connection {"host":"10.213.81.53","port":22}',
    expected: "返回连接资料查询结果",
    validation: "true",
    risk: "low",
    status: "pending",
  },
  {
    id: "prepare-cluster",
    kind: "change",
    title: "准备集群",
    description: "执行已授权的后续集群准备",
    command: "touch /tmp/opsark-cluster-ready",
    expected: "准备标记存在",
    validation: "test -f /tmp/opsark-cluster-ready",
    risk: "medium",
    status: "pending",
  },
];

function buildStandaloneStageRepair(plan = standaloneStagePlan) {
  let error: unknown;
  try { normalizePlanPreconditions(plan, "部署 k8s 集群"); } catch (caught) { error = caught; }
  if (!error) throw new Error("测试计划未触发 standalone 协议错误");
  return buildPlanNormalizationRepair(error, plan);
}

describe("plan normalization repair feedback", () => {
  it("classifies a standalone conflict as a whole-plan stage split", () => {
    const repair = buildStandaloneStageRepair();

    expect(repair).toMatchObject({
      errorCode: "plan_normalization_failed",
      repairStrategy: {
        type: "standalone_stage_split",
        standaloneStepIndex: 4,
        toolId: "server.resolve_connection",
      },
      fieldPath: "steps",
      previousModelOutput: standaloneStagePlan,
    });
    expect(repair.instruction).toContain("确定性缩小当前执行阶段");
    expect(repair.instruction).toContain("不是删除整体目标");
  });

  it("accepts only an unchanged safe stage subset and rejects edits or additions", () => {
    const repair = buildStandaloneStageRepair();
    const prefix = structuredClone(standaloneStagePlan.slice(0, 4));
    const standalone = [structuredClone(standaloneStagePlan[4])];

    expect(() => assertPlanRepairScope(repair, prefix)).not.toThrow();
    expect(() => assertPlanRepairScope(repair, standalone)).not.toThrow();
    expect(() => assertPlanRepairScope(repair, [{ ...prefix[0], description: "改写业务说明" }]))
      .toThrow("不得新增、重排或改写");
    expect(() => assertPlanRepairScope(repair, [
      ...prefix,
      { ...prefix[0], id: "added-step", title: "新增操作", command: "whoami" },
    ])).toThrow("不得新增、重排或改写");
    expect(() => assertPlanRepairScope(repair, [{
      ...standalone[0],
      command: 'opsark-tool user.request_input {"title":"改换工具","fields":[]}',
    }])).toThrow("工具和命令");
    expect(() => assertPlanRepairScope(repair, structuredClone(standaloneStagePlan.slice(0, 5))))
      .toThrow("仍将 standalone 工具与其他待执行步骤混排");
  });

  it("deterministically splits the first generated plan without a second model call", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const runtime = { apiKey: "fixture", endpoint: "https://test.invalid", model: "test", context: "{}" };
    vi.mocked(invoke).mockResolvedValueOnce(structuredClone(standaloneStagePlan));

    const repaired = await backend.generatePlan("部署 k8s 集群", runtime);

    expect(repaired).toHaveLength(4);
    expect(repaired.map(({ command }) => command))
      .toEqual(standaloneStagePlan.slice(0, 4).map(({ command }) => command));
    expect(invoke).toHaveBeenCalledOnce();
    expect(vi.mocked(invoke).mock.calls[0][0]).toBe("generate_ai_plan");
  });

  it("advances a repeated plan from its completed prefix to the standalone step", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const completedCommandFingerprints = standaloneStagePlan.slice(0, 4)
      .map((step) => textFingerprint(planCommandIdentity(step.command)));
    vi.mocked(invoke).mockResolvedValueOnce(structuredClone(standaloneStagePlan));

    const repaired = await backend.generatePlan("部署 k8s 集群", {
      apiKey: "fixture",
      endpoint: "https://test.invalid",
      model: "test",
      context: JSON.stringify({ workflowPhase: "continue_after_discovery", completedCommandFingerprints }),
    });

    expect(repaired).toHaveLength(1);
    expect(repaired[0].command).toBe(standaloneStagePlan[4].command);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("advances a repeated plan past its completed standalone step to the suffix", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const completedCommandFingerprints = standaloneStagePlan.slice(0, 5)
      .map((step) => textFingerprint(planCommandIdentity(step.command)));
    vi.mocked(invoke).mockResolvedValueOnce(structuredClone(standaloneStagePlan));

    const repaired = await backend.generatePlan("部署 k8s 集群", {
      apiKey: "fixture",
      endpoint: "https://test.invalid",
      model: "test",
      context: JSON.stringify({ workflowPhase: "continue_after_discovery", completedCommandFingerprints }),
    });

    expect(repaired).toHaveLength(1);
    expect(repaired[0].command).toBe(standaloneStagePlan[5].command);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("advances to the suffix using the real archived-prefix continuation context", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const completed = (step: PlanStep): PlanStep => ({ ...structuredClone(step), status: "completed" });
    const task: OpsTask = {
      id: "task-stage-split",
      serverId: "server-local",
      title: "部署 k8s 集群",
      rootGoal: "部署 k8s 集群",
      status: "running",
      permission: "managed",
      modelId: "model-test",
      messages: [],
      currentRoundId: "round-stage-split",
      phaseHistory: [{
        id: "phase-prefix",
        roundId: "round-stage-split",
        requirement: "部署 k8s 集群",
        reason: "replan",
        plan: standaloneStagePlan.slice(0, 4).map(completed),
        createdAt: "2026-09-15T00:00:00.000Z",
        completedAt: "2026-09-15T00:01:00.000Z",
      }],
      plan: [completed(standaloneStagePlan[4])],
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:01:00.000Z",
    };
    const context = buildContinuationContext({ task, tools: defaultToolCatalog, secretMetadata: [] });
    vi.mocked(invoke).mockResolvedValueOnce(structuredClone(standaloneStagePlan));

    const repaired = await backend.generatePlan("部署 k8s 集群", {
      apiKey: "fixture",
      endpoint: "https://test.invalid",
      model: "test",
      context: JSON.stringify(context),
    });

    expect(repaired).toHaveLength(1);
    expect(repaired[0].command).toBe(standaloneStagePlan[5].command);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("uses completed command fingerprints when stage splitting a next-stage decision", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    vi.mocked(invoke).mockResolvedValueOnce({
      decision: "continue",
      reason: "还需要连接资料",
      summary: "继续下一阶段",
      steps: structuredClone(standaloneStagePlan),
    });
    const runtime = {
      apiKey: "fixture",
      endpoint: "https://test.invalid",
      model: "test",
      context: JSON.stringify({
        completedCommandFingerprints: standaloneStagePlan.slice(0, 4)
          .map((step) => textFingerprint(planCommandIdentity(step.command))),
      }),
    };

    const decision = await backend.decideNextStage("部署 k8s 集群", runtime);

    expect(decision.steps).toHaveLength(1);
    expect(decision.steps[0].command).toBe(standaloneStagePlan[4].command);
    expect(invoke).toHaveBeenCalledOnce();
    expect(vi.mocked(invoke).mock.calls[0][0]).toBe("decide_ai_next_stage");
  });

  it("preserves initial requirement classification while stage-splitting its invalid plan", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const runtime = { apiKey: "fixture", endpoint: "https://test.invalid", model: "test", context: "{}" };
    const result = {
      intent: "execute",
      relation: "new_goal",
      selectedSkillIds: [],
      plan: structuredClone(standaloneStagePlan),
    };
    vi.mocked(invoke).mockResolvedValueOnce(result);

    const processed = await backend.processRequirement("部署 k8s 集群", runtime, []);

    expect(processed).toMatchObject({ intent: "execute", relation: "new_goal", selectedSkillIds: [] });
    expect(processed.plan).toHaveLength(4);
    expect(processed.plan.map(({ command }) => command))
      .toEqual(standaloneStagePlan.slice(0, 4).map(({ command }) => command));
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command))
      .toEqual(["process_ai_requirement"]);
  });

  it("upgrades and deterministically splits a saved legacy standalone repair", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const current = buildStandaloneStageRepair();
    const legacyRepair = {
      ...current,
      repairStrategy: undefined,
      fieldPath: "steps[4]",
      instruction: "旧版通用修复指令",
    };
    const repaired = await backend.generatePlan("部署 k8s 集群", {
      apiKey: "fixture",
      endpoint: "https://test.invalid",
      model: "test",
      context: JSON.stringify({ planGenerationRepair: legacyRepair }),
    });

    expect(repaired).toHaveLength(4);
    expect(repaired.map(({ command }) => command))
      .toEqual(standaloneStagePlan.slice(0, 4).map(({ command }) => command));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("isolates a standalone first step and defers its following steps", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const plan = structuredClone(standaloneStagePlan.slice(4));
    const repair = buildStandaloneStageRepair(plan);
    const repaired = await backend.generatePlan("部署 k8s 集群", {
      apiKey: "fixture",
      endpoint: "https://test.invalid",
      model: "test",
      context: JSON.stringify({ planGenerationRepair: repair }),
    });

    expect(repaired).toHaveLength(1);
    expect(repaired[0].command).toBe(plan[0].command);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("accepts normalized standalone tool syntax in a persisted repair", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const plan = structuredClone(standaloneStagePlan);
    plan[4].command = '  opsark-tool --server.resolve_connection {"host":"10.213.81.53","port":22}';
    const repair = buildStandaloneStageRepair(plan);

    const repaired = await backend.generatePlan("部署 k8s 集群", {
      apiKey: "fixture",
      endpoint: "https://test.invalid",
      model: "test",
      context: JSON.stringify({ planGenerationRepair: repair }),
    });

    expect(repaired).toHaveLength(4);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("initial requirement and next-stage repair never rerun requirement classification", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const runtime = { apiKey: "fixture", endpoint: "https://test.invalid", model: "test", context: "{}" };
    const result = { intent: "execute", relation: "new_goal", selectedSkillIds: ["database-inspection-operations"], plan: [malformedStep] };
    vi.mocked(invoke).mockResolvedValueOnce(result).mockResolvedValueOnce([{ ...malformedStep, description: "业务被改写" }]);
    let error: unknown;
    try { await backend.processRequirement("查询数据库", runtime, []); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(PlanProtocolError);
    expect((error as PlanProtocolError).processed).toEqual(result);
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["process_ai_requirement", "generate_ai_plan"]);
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce({ decision: "continue", reason: "继续", summary: "只读", steps: [malformedStep] })
      .mockResolvedValueOnce([{ ...malformedStep, description: "业务被改写" }]);
    await expect(backend.decideNextStage("查询数据库", runtime)).rejects.toBeInstanceOf(PlanProtocolError);
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["decide_ai_next_stage", "generate_ai_plan"]);
  });
  it("rejects business edits, tool replacement, unrelated commands and unrelated arguments", () => {
    const original = { ...malformedStep, command: 'opsark-tool user.request_input {"title":"确认","fields":[{"key":"USER","type":"text"}]}' };
    const repair = buildPlanNormalizationRepair(new Error("第 1 个计划步骤的工具参数无效：凭据参数 USER 必须使用 password 类型"), [original]);
    const repaired = { ...original, command: original.command.replace('"text"', '"password"') };
    expect(() => assertPlanRepairScope(repair, [repaired])).not.toThrow();
    expect(() => assertPlanRepairScope(repair, [{ ...repaired, description: "换账号试试" }])).toThrow("description");
    expect(() => assertPlanRepairScope(repair, [{ ...repaired, command: "echo ok" }])).toThrow("替换工具");
    expect(() => assertPlanRepairScope(repair, [{ ...repaired, command: repaired.command.replace("确认", "更换目标") }])).toThrow("其他工具参数");
    const withShell = { ...repair, previousModelOutput: [original, { ...malformedStep, command: "pwd" }] };
    expect(() => assertPlanRepairScope(withShell, [repaired, { ...malformedStep, command: "whoami" }])).toThrow("无关命令");
  });
  it("upgrades a legacy tool repair from the original validator and still rejects business edits", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const repair = buildPlanNormalizationRepair(new Error("第 1 个计划步骤的工具参数无效：格式错误"), [malformedStep]);
    vi.mocked(invoke).mockResolvedValue([{ ...malformedStep, description: "重写业务" }]);
    let error: unknown;
    try {
      await backend.generatePlan("不要重新生成业务", { apiKey: "fixture", endpoint: "https://test.invalid", model: "test",
        context: JSON.stringify({ planGenerationRepair: repair }) });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(PlanProtocolError);
    expect((error as PlanProtocolError).repair.previousModelOutput).toEqual(repair.previousModelOutput);
    expect((error as PlanProtocolError).repair.diagnostic).toMatchObject({ code: "TOOL_ARGUMENT_INVALID",
      fieldPath: "steps[0].command.arguments.title" });
    expect((error as PlanProtocolError).repair.progress?.attemptCount).toBe(1);
    expect((error as Error).message).toContain("description");
    expect((error as PlanProtocolError).userMessage).toContain("未执行任何新的服务器操作");
    expect((error as PlanProtocolError).userMessage).not.toContain("description");
    expect((error as PlanProtocolError).developerMessage).toContain("description");
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("generate_ai_plan", expect.objectContaining({ requirement: expect.stringContaining("只修复") }));
  });
  it("normalizes the logged database username mismatch before a model repair is needed", () => {
    const fields = [
      { key: "mysql_user", label: "数据库用户名", description: "目标实例账户", type: "text", required: true,
        credential: { group: "db", kind: "database", role: "username", target: "db.internal:3306" } },
      { key: "MYSQL_PASSWORD", label: "数据库密码", description: "目标实例密码", type: "password", required: true,
        credential: { group: "db", kind: "database", role: "secret", target: "db.internal:3306" } },
    ];
    const original = { ...malformedStep, command: `opsark-tool user.request_input ${JSON.stringify({ title: "数据库认证", fields })}` };
    const normalized = normalizePlanPreconditions([original], "检查当前mysql有哪些库")[0];
    const args = JSON.parse(normalized.command.slice("opsark-tool user.request_input ".length));
    expect(args.fields[0].type).toBe("password");
    expect(normalized.description).toBe(original.description);
    expect(normalized.kind).toBe(original.kind);
    expect(original.command).toContain('"type":"text"');
  });
  it("returns a field-local credential type error with the prior model output", () => {
    const repair = buildPlanNormalizationRepair(
      new Error("第 1 个计划步骤的工具参数无效：凭据参数 username 必须使用 password 类型"),
      [malformedStep],
    );

    expect(repair).toMatchObject({
      errorCode: "tool_schema_validation_failed",
      fieldPath: "steps[0].command.arguments.fields[key=username].type",
      expected: "password",
      previousModelOutput: [malformedStep],
    });
    expect(repair.instruction).toContain("只修复");
    expect(repair.instruction).toContain("业务目的");
  });
});

describe("disk log queries", () => {
  it("keeps browser mode on the in-memory log fallback", async () => {
    await expect(backend.queryTaskLogs({ stream: "developer-events", limit: 50 })).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes the complete query envelope to the desktop command", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const result = {
      items: [{ id: "dev-1" }],
      nextCursor: "cursor-2",
      hasMore: true,
      total: 201,
      malformedLines: 2,
      oversizedLines: 1,
    };
    vi.mocked(invoke).mockResolvedValueOnce(result);
    const query = {
      stream: "developer-events" as const,
      taskId: "task-1",
      serverId: "server-1",
      operation: "model_call",
      event: "request_failed",
      level: "error",
      search: "timeout",
      cursor: "cursor-1",
      limit: 100,
    };

    await expect(backend.queryTaskLogs(query)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith("query_task_logs", { query });
  });
});
