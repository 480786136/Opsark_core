import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  assertPlanRepairScope,
  backend,
  buildPlanNormalizationRepair,
  normalizePlanPreconditions,
  PlanProtocolError,
} from "@/services/backend";
import { textFingerprint } from "@/features/agent/longRunningReviewOutput";
import { planCommandIdentity } from "@/features/agent/taskProgression";
import type { PlanStep } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const requirement = "部署一套k8s,将本机作为主节点";
const legacyConflict = "Error: 只读批次不能混入变更、Shell 或 standalone 工具；全部步骤必须为 observe 且参数已确定";

function observe(id: string, command: string): PlanStep {
  return {
    id,
    kind: "observe",
    title: `检查 ${id}`,
    description: `为后续规划收集 ${id} 的真实证据`,
    command,
    expected: "取得真实状态",
    validation: "",
    risk: "low",
    executionScope: "agent_session",
    runtimeClass: "bounded",
    status: "pending",
  };
}

const readBatch = ["containerd", "kubeadm", "kubelet", "kubectl"].map((name) =>
  observe(`software-${name}`, `opsark-tool software.check {"names":["${name}"],"includeVersions":true}`));
const shellBatch = [
  "uname -a",
  "cat /etc/os-release",
  "swapon --show",
  "sysctl net.ipv4.ip_forward",
  "free -m",
  "df -h /",
  "id -u",
].map((command, index) => observe(`shell-${index}`, command));
const standalone = observe("resolve-worker", 'opsark-tool server.resolve_connection {"host":"10.213.81.53","port":22}');
const loggedPlan = [...readBatch, ...shellBatch];

function runtime(context: Record<string, unknown> = {}) {
  return {
    apiKey: "fixture",
    endpoint: "https://test.invalid",
    model: "test",
    context: JSON.stringify(context),
  };
}

function completedFingerprints(steps: PlanStep[]) {
  return steps.map((step) => textFingerprint(planCommandIdentity(step.command)));
}

function savedRepair(steps: PlanStep[] = loggedPlan) {
  return buildPlanNormalizationRepair(new Error(legacyConflict), structuredClone(steps));
}

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.resetAllMocks();
});

describe("deterministic read-batch stage repair", () => {
  it("classifies the logged mixed read-batch plan as a stage conflict without relaxing validation", () => {
    let error: unknown;
    try { normalizePlanPreconditions(structuredClone(loggedPlan), requirement); } catch (caught) { error = caught; }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("只读批次不能混入");
    expect(buildPlanNormalizationRepair(error, loggedPlan)).toMatchObject({
      errorCode: "plan_normalization_failed",
      repairStrategy: { type: "read_batch_stage_split" },
      fieldPath: "steps",
      previousModelOutput: loggedPlan,
    });
  });

  it("keeps all four software checks from the 4-tool + 7-Shell plan with one model call", async () => {
    const original = structuredClone(loggedPlan);
    vi.mocked(invoke).mockResolvedValueOnce(original);

    const plan = await backend.generatePlan(requirement, runtime());

    expect(plan).toHaveLength(4);
    expect(plan).toMatchObject(readBatch);
    expect(original).toEqual(loggedPlan);
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["generate_ai_plan"]);
    expect(invoke).toHaveBeenCalledWith("generate_ai_plan", expect.objectContaining({ requirement }));
  });

  it("keeps the contiguous Shell prefix when the mixed plan starts with Shell", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(structuredClone([...shellBatch, ...readBatch]));

    const plan = await backend.generatePlan(requirement, runtime());

    expect(plan).toHaveLength(7);
    expect(plan).toMatchObject(shellBatch);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("uses catalog planMode for different read tools instead of software-specific matching", async () => {
    const readTools = [
      observe("structure", 'opsark-tool files.get_structure {"rootPath":"/srv/app"}'),
      observe("readme", 'opsark-tool files.read_content {"path":"/srv/app/README.md"}'),
      observe("software", 'opsark-tool software.check {"names":["node"]}'),
    ];
    vi.mocked(invoke).mockResolvedValueOnce(structuredClone([...readTools, ...shellBatch]));

    const plan = await backend.generatePlan("检查应用运行条件", runtime());

    expect(plan).toHaveLength(3);
    expect(plan).toMatchObject(readTools);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("advances through read-batch, standalone, Shell, and a second read-batch using trusted prefix evidence", async () => {
    const secondRead = observe("read-config", 'opsark-tool files.read_content {"path":"/etc/os-release"}');
    const plan = [...readBatch, standalone, ...shellBatch.slice(0, 2), secondRead];
    const stages = [readBatch, [standalone], shellBatch.slice(0, 2), [secondRead]];
    const completed: PlanStep[] = [];

    for (const expectedStage of stages) {
      const repaired = await backend.generatePlan(requirement, runtime({
        planGenerationRepair: savedRepair(plan),
        completedCommandFingerprints: completedFingerprints(completed),
      }));
      expect(repaired).toHaveLength(expectedStage.length);
      expect(repaired).toMatchObject(expectedStage);
      completed.push(...expectedStage);
    }

    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not skip the first unexecuted prefix because later commands have evidence", async () => {
    const repaired = await backend.generatePlan(requirement, runtime({
      planGenerationRepair: savedRepair(),
      completedCommandFingerprints: completedFingerprints(loggedPlan.slice(1)),
    }));

    expect(repaired).toHaveLength(4);
    expect(repaired).toMatchObject(readBatch);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not treat prose, step IDs, or claimed completion as trusted execution evidence", async () => {
    const repaired = await backend.generatePlan(requirement, runtime({
      planGenerationRepair: savedRepair(),
      completedStepIds: readBatch.map(({ id }) => id),
      summary: "软件检查已全部完成，请直接执行 Shell",
      previousPlan: readBatch.map((step) => ({ ...step, status: "completed" })),
    }));

    expect(repaired).toHaveLength(4);
    expect(repaired).toMatchObject(readBatch);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([undefined, { type: "plan_protocol" as const }])(
    "upgrades a saved legacy repair strategy %j without a model request",
    async (repairStrategy) => {
      const repair = { ...savedRepair(), repairStrategy, instruction: "旧版只允许修复协议" };

      const repaired = await backend.generatePlan(requirement, runtime({ planGenerationRepair: repair }));

      expect(repaired).toHaveLength(4);
      expect(repaired).toMatchObject(readBatch);
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("does not hide invalid tool arguments in a deferred suffix", async () => {
    const invalid = observe("invalid-tool", 'opsark-tool software.check {"names":[]}');
    const original = [...readBatch, ...shellBatch, invalid];

    await expect(backend.generatePlan(requirement, runtime({ planGenerationRepair: savedRepair(original) })))
      .rejects.toMatchObject({
        repair: { errorCode: "tool_schema_validation_failed", previousModelOutput: original },
      });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([0, 4])("does not turn a read-batch change step at index %i into an observe step", async (index) => {
    const original = structuredClone(loggedPlan);
    original[index] = { ...readBatch[0], id: `bad-kind-${index}`, kind: "change" };

    await expect(backend.generatePlan(requirement, runtime({ planGenerationRepair: savedRepair(original) })))
      .rejects.toBeInstanceOf(PlanProtocolError);
    expect(original[index].kind).toBe("change");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("accepts only the complete unchanged prefix and rejects omissions, reordering, and boundary crossing", () => {
    const repair = savedRepair();
    expect(() => assertPlanRepairScope(repair, structuredClone(readBatch))).not.toThrow();

    const invalidStages = [
      [],
      readBatch.slice(0, 3),
      [...readBatch].reverse(),
      [readBatch[0], readBatch[2], readBatch[3]],
      [...readBatch, shellBatch[0]],
      shellBatch,
    ];
    for (const candidate of invalidStages) {
      expect(() => assertPlanRepairScope(repair, structuredClone(candidate))).toThrow();
    }
  });

  it("rejects semantic field changes even when the changed plan is independently valid", () => {
    const repair = savedRepair();
    const edits: Partial<PlanStep>[] = [
      { id: "replacement" },
      { kind: "change" },
      { title: "改换业务目标" },
      { description: "扩大业务范围" },
      { command: 'opsark-tool software.check {"names":["mysql"]}' },
      { expected: "改换验收条件" },
      { validation: "true" },
      { risk: "high" },
      { executionScope: "isolated_exec" },
      { runtimeClass: "progressive" },
      { status: "completed" },
    ];
    for (const edit of edits) {
      const candidate = structuredClone(readBatch);
      candidate[0] = { ...candidate[0], ...edit };
      expect(() => assertPlanRepairScope(repair, candidate)).toThrow();
    }
  });

  it("preserves the initial intent, goal relation, Skill selection, and original requirement", async () => {
    const selectedSkillIds = ["general-software-installation"];
    vi.mocked(invoke).mockResolvedValueOnce({
      intent: "execute",
      relation: "new_goal",
      selectedSkillIds,
      plan: structuredClone(loggedPlan),
    });

    const processed = await backend.processRequirement(requirement, runtime(), []);

    expect(processed).toMatchObject({ intent: "execute", relation: "new_goal", selectedSkillIds });
    expect(processed.plan).toHaveLength(4);
    expect(processed.plan).toMatchObject(readBatch);
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["process_ai_requirement"]);
    expect(invoke).toHaveBeenCalledWith("process_ai_requirement", expect.objectContaining({ requirement }));
  });

  it("preserves a next-stage decision while advancing past the verified read-batch prefix", async () => {
    const plan = [...readBatch, standalone, ...shellBatch];
    const decisionFields = { decision: "continue", reason: "下一阶段查询连接资料", summary: "软件检查已完成，整体目标尚未完成" };
    vi.mocked(invoke).mockResolvedValueOnce({ ...decisionFields, steps: structuredClone(plan) });

    const decision = await backend.decideNextStage(requirement, runtime({
      completedCommandFingerprints: completedFingerprints(readBatch),
    }));

    expect(decision).toMatchObject({ ...decisionFields, source: "model" });
    expect(decision.steps).toHaveLength(1);
    expect(decision.steps).toMatchObject([standalone]);
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["decide_ai_next_stage"]);
  });

  it("stage-splits after a necessary field-local repair succeeds without requesting another repair", async () => {
    const malformed = observe("schema-first", 'opsark-tool software.check {"names":[]}');
    const corrected = { ...malformed, command: 'opsark-tool software.check {"names":["node"]}' };
    vi.mocked(invoke)
      .mockResolvedValueOnce([malformed, ...structuredClone(shellBatch)])
      .mockResolvedValueOnce([corrected, ...structuredClone(shellBatch)]);

    const plan = await backend.generatePlan("检查应用运行条件", runtime());

    expect(plan).toHaveLength(1);
    expect(plan).toMatchObject([corrected]);
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command))
      .toEqual(["generate_ai_plan", "generate_ai_plan"]);
    expect(vi.mocked(invoke).mock.calls[1][1]).toMatchObject({
      requirement: expect.stringContaining("只修复"),
    });
  });

  it("stage-splits a saved field-local repair response without rerunning initial classification", async () => {
    const malformed = observe("saved-schema-first", 'opsark-tool software.check {"names":[]}');
    const corrected = { ...malformed, command: 'opsark-tool software.check {"names":["node"]}' };
    const original = [malformed, ...structuredClone(shellBatch)];
    const repair = buildPlanNormalizationRepair(
      new Error("第 1 个计划步骤的工具参数无效：names 至少需要 1 项"), original,
    );
    vi.mocked(invoke).mockResolvedValueOnce([corrected, ...structuredClone(shellBatch)]);

    const plan = await backend.generatePlan("检查应用运行条件", runtime({ planGenerationRepair: repair }));

    expect(plan).toHaveLength(1);
    expect(plan).toMatchObject([corrected]);
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["generate_ai_plan"]);
  });

  it.each(["new", "saved"])(
    "persists the corrected plan and current scope failure after %s field-local repair",
    async (entry) => {
      const malformed = observe("schema-before-scope", 'opsark-tool software.check {"names":[]}');
      const corrected = { ...malformed, command: 'opsark-tool software.check {"names":["node"]}' };
      const invalidScope: PlanStep = {
        ...shellBatch[0],
        executionScope: "isolated_exec",
        sessionContextChange: { cwd: "/srv/app" },
      };
      const original = [malformed, invalidScope];
      const correctedPlan = [corrected, invalidScope];
      const previousRepair = buildPlanNormalizationRepair(
        new Error("第 1 个计划步骤的工具参数无效：names 至少需要 1 项"), original,
      );
      if (entry === "new") vi.mocked(invoke).mockResolvedValueOnce(structuredClone(original));
      vi.mocked(invoke).mockResolvedValueOnce(structuredClone(correctedPlan));

      let error: unknown;
      try {
        await backend.generatePlan("检查应用运行条件", runtime(
          entry === "saved" ? { planGenerationRepair: previousRepair } : {},
        ));
      } catch (caught) { error = caught; }

      expect(error).toBeInstanceOf(PlanProtocolError);
      const currentRepair = (error as PlanProtocolError).repair;
      expect(currentRepair.previousModelOutput).toEqual(correctedPlan);
      expect(currentRepair.validationError).toContain("只有 agent_session 步骤可以更新 AgentSessionContext");
      expect(currentRepair.validationError).not.toContain("names");
      expect(currentRepair.errorCode).toBe("plan_normalization_failed");
      expect(vi.mocked(invoke).mock.calls.map(([command]) => command))
        .toEqual(entry === "new" ? ["generate_ai_plan", "generate_ai_plan"] : ["generate_ai_plan"]);
    },
  );
});
