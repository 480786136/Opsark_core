import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  assertPlanRepairScope,
  backend,
  buildPlanNormalizationRepair,
  normalizePlanPreconditions,
} from "@/services/backend";
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
const shellBatch = ["uname -a", "cat /etc/os-release"].map((command, index) => observe(`shell-${index}`, command));
const standalone = observe("resolve-worker", 'opsark-tool server.resolve_connection {"host":"10.213.81.53","port":22}');
const mixedPlan = [...readBatch, ...shellBatch];

function runtime(context: Record<string, unknown> = {}) {
  return {
    apiKey: "fixture",
    endpoint: "https://test.invalid",
    model: "test",
    context: JSON.stringify(context),
  };
}

function savedRepair(steps: PlanStep[] = mixedPlan) {
  return buildPlanNormalizationRepair(new Error(legacyConflict), structuredClone(steps));
}

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.resetAllMocks();
});

describe("ordered mixed plans and standalone boundaries", () => {
  it("preserves the entire mixed plan and its order", () => {
    const result = normalizePlanPreconditions(structuredClone(mixedPlan), requirement);
    expect(result.map(step => step.command)).toEqual(mixedPlan.map(step => step.command));
  });

  it("accepts the complete mixed plan instead of extracting its read_batch prefix", async () => {
    const original = structuredClone(mixedPlan);
    vi.mocked(invoke).mockResolvedValueOnce(original);

    expect((await backend.generatePlan(requirement, runtime())).map(step => step.command))
      .toEqual(mixedPlan.map(step => step.command));
    expect(original).toEqual(mixedPlan);
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["generate_ai_plan"]);
  });

  it("accepts a Shell prefix followed by read_batch tools", async () => {
    const original = [...shellBatch, ...readBatch];
    vi.mocked(invoke).mockResolvedValueOnce(structuredClone(original));

    expect((await backend.generatePlan(requirement, runtime())).map(step => step.command))
      .toEqual(original.map(step => step.command));
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("uses catalog planMode rather than software-specific matching", async () => {
    const readTools = [
      observe("structure", 'opsark-tool files.get_structure {"rootPath":"/srv/app"}'),
      observe("readme", 'opsark-tool files.read_content {"path":"/srv/app/README.md"}'),
    ];
    const original = [...readTools, ...shellBatch];
    vi.mocked(invoke).mockResolvedValueOnce(structuredClone(original));

    expect((await backend.generatePlan("检查应用运行条件", runtime())).map(step => step.command))
      .toEqual(original.map(step => step.command));
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("never deletes commands because completed fingerprints are present", async () => {
    const plan = [...readBatch, standalone, ...shellBatch];
    vi.mocked(invoke).mockResolvedValueOnce(structuredClone(plan));

    await expect(backend.generatePlan(requirement, runtime({
      completedCommandFingerprints: ["all", "commands", "claimed", "complete"],
    }))).rejects.toMatchObject({
      repairError: expect.stringContaining("PLAN_STAGE_CONFLICT"),
      repair: { previousModelOutput: plan },
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    { type: "plan_protocol" as const },
    { type: "read_batch_stage_split" as const },
  ])("atomically rejects saved legacy repair strategy %j without a model request", async (repairStrategy) => {
    const repair = { ...savedRepair(), repairStrategy, instruction: "旧版阶段修复" };

    await expect(backend.generatePlan(requirement, runtime({ planGenerationRepair: repair })))
      .rejects.toMatchObject({
        repairError: expect.stringContaining("PLAN_STAGE_CONFLICT"),
        repair: { previousModelOutput: mixedPlan, repairStrategy: { type: "plan_protocol" } },
      });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not accept any prefix or subset through repair-scope validation", () => {
    const repair = savedRepair();
    for (const candidate of [readBatch, readBatch.slice(0, 3), shellBatch, [], mixedPlan]) {
      expect(() => assertPlanRepairScope(repair, structuredClone(candidate)))
        .toThrow("PLAN_STAGE_CONFLICT");
    }
  });

  it("preserves requirement classification while accepting the entire mixed plan", async () => {
    const result = {
      intent: "execute" as const,
      relation: "new_goal" as const,
      selectedSkillIds: ["general-software-installation"],
      plan: structuredClone(mixedPlan),
    };
    vi.mocked(invoke).mockResolvedValueOnce(result);

    const processed = await backend.processRequirement(requirement, runtime(), []);
    expect(processed.intent).toBe("execute");
    expect(processed.plan?.map(step => step.command)).toEqual(mixedPlan.map(step => step.command));
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["process_ai_requirement"]);
  });

  it("preserves the next-stage decision while rejecting all of its conflicting steps", async () => {
    const plan = [...readBatch, standalone];
    const decision = { decision: "continue" as const, reason: "仍需检查", summary: "继续下一阶段", steps: plan };
    vi.mocked(invoke).mockResolvedValueOnce(structuredClone(decision));

    await expect(backend.decideNextStage(requirement, runtime({
      completedCommandFingerprints: ["claimed-complete"],
    }))).rejects.toMatchObject({
      repair: {
        previousModelOutput: plan,
        nextStageDecision: { decision: "continue", reason: decision.reason, summary: decision.summary },
      },
    });
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["decide_ai_next_stage"]);
  });

  it("keeps the full mixed plan after repairing one invalid tool argument", async () => {
    const malformed = observe("schema-first", 'opsark-tool software.check {"names":[]}');
    const corrected = { ...malformed, command: 'opsark-tool software.check {"names":["node"]}' };
    const correctedPlan = [corrected, ...structuredClone(shellBatch)];
    vi.mocked(invoke)
      .mockResolvedValueOnce([malformed, ...structuredClone(shellBatch)])
      .mockResolvedValueOnce(correctedPlan);

    expect((await backend.generatePlan("检查应用运行条件", runtime())).map(step => step.command))
      .toEqual(correctedPlan.map(step => step.command));
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command))
      .toEqual(["generate_ai_plan", "generate_ai_plan"]);
  });

  it("still accepts a complete homogeneous read_batch plan", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(structuredClone(readBatch));

    await expect(backend.generatePlan("检查软件", runtime())).resolves.toMatchObject(readBatch);
    expect(invoke).toHaveBeenCalledOnce();
  });
});
