import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { PlanStep } from "@/types";
import { backend, buildPlanNormalizationRepair, assertPlanRepairScope, PlanProtocolError } from "./backend";
import { normalizePlanPreconditions } from "@/features/agent/planNormalizer";
import { compactProtocolRepairContext, planSemanticFingerprint } from "./planProtocolRepair";
import { RecoveryProtocolError, RECOVERY_RULE_VERSION } from "./recoveryRules";
import incident from "./fixtures/recovery-20260915.json";
import missingSteps from "./fixtures/next-stage-missing-steps.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function diagnose(command = 'TMPD=$(mktemp -d)\nrm -rf "$TMPD"'): PlanStep {
  return { id: "generated-1", kind: "observe", title: "诊断预检", description: "查询环境事实",
    command, expected: "取得实际资源状态", validation: "", risk: "high", status: "pending",
    executionScope: "agent_session", validationScope: "isolated_exec", runtimeClass: "bounded",
    recovery: { failedStepId: "real-failed-step", targetContext: '["host","round","session",1,0]', purpose: "diagnose" } };
}

function repairOf(steps = [diagnose()]) {
  try { normalizePlanPreconditions(steps); } catch (error) { return buildPlanNormalizationRepair(error, steps); }
  throw new Error("fixture must be rejected");
}

function runtime(extra: Record<string, unknown> = {}) {
  return { apiKey: "fixture", endpoint: "https://test.invalid", model: "fixture",
    context: JSON.stringify({ taskGoal: { rootGoal: "部署应用" }, permission: "safe",
      executionConstraints: { changePolicy: "read_only" },
      recovery: { currentTargetContext: '["host","round","session",1,0]', failedAttempts: [] }, ...extra }) };
}

beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.resetAllMocks(); });

describe("bounded protocol repair", () => {
  it.each([JSON.stringify(missingSteps), '{"decision":"adjust","steps":{}}', '{"decision":'])(
    "preserves an unparsed next-stage response without manufacturing a no-action decision: %s", async rawResponse => {
      vi.mocked(invoke).mockRejectedValueOnce("OPSARK_MODEL_TRACE_V1:" + JSON.stringify({
        message: JSON.stringify({ kind: "next_stage_response_invalid",
          validationError: "阶段联合决策结构解析失败：missing field steps", rawResponse, rejectedPlanExecuted: false }),
        developerTrace: { attempts: [] },
      }));
      const error = await backend.decideNextStage("继续部署", runtime()).catch(error => error);
      expect(error).toBeInstanceOf(PlanProtocolError);
      expect(error.repair).toMatchObject({
        errorCode: "next_stage_response_invalid", rawModelResponse: rawResponse, previousModelOutput: [],
      });
      expect(error.repair.nextStageDecision).toBeUndefined();
      expect(error.userMessage).toContain("响应格式不完整或不正确");
      expect(error.userMessage).not.toContain("证据校验未通过");
      expect(error.developerTrace).toEqual({ attempts: [] });
      // Business replanning owns the bounded retry, not field-local generation.
      expect(invoke).toHaveBeenCalledOnce();
    },
  );

  it("classifies a backend capability rejection as recoverable planning feedback, not a service outage", async () => {
    const steps = [{ ...diagnose("opsark-tool hidden.read {}"), recovery: undefined }];
    const decision = { decision: "continue", reason: "缺少声明原文", summary: "补读已有证据" };
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({
      message: JSON.stringify({ kind: "plan_protocol_failure", steps,
        validationError: "第 1 个计划步骤调用了当前规划上下文未开放工具 hidden.read；只能使用 context.tools 中明确提供的工具或 Shell 流程",
        nextStageDecision: decision, rejectedPlanExecuted: false }),
      developerTrace: { attempts: [] },
    })}`);

    const error = await backend.decideNextStage("继续部署", runtime()).catch(error => error);
    expect(error).toBeInstanceOf(PlanProtocolError);
    expect(error.repair.previousModelOutput).toEqual(steps);
    expect(error.repair.nextStageDecision).toEqual(decision);
    expect(error.userMessage).toContain("未开放的工具 hidden.read");
    expect(error.userMessage).not.toContain("稍后重试");
    expect(error.developerTrace).toEqual({ attempts: [] });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("revalidates a persisted retired acceptance-copy rejection without calling the model", async () => {
    const candidate = { ...diagnose("test -s /opt/report/build/report.zip"),
      expected: "实际构建产物存在且非空", recovery: { ...diagnose().recovery!, purpose: "verify" as const } };
    const repair = buildPlanNormalizationRepair(new RecoveryProtocolError({
      code: "RECOVERY_ACCEPTANCE_MISMATCH", stepIndex: 0, fieldPath: "steps[0].recovery",
      expected: "旧版本要求逐字复制失败步骤的验收", allowedRepairPaths: [], ruleVersion: RECOVERY_RULE_VERSION,
    }), [candidate]);
    repair.progress = { scopeFingerprint: "legacy", attemptedFingerprints: [], seenPlans: [],
      attemptCount: 1, stopCode: "PROTOCOL_REPAIR_SCOPE_UNKNOWN" };
    const original = structuredClone(repair);

    const result = await backend.generatePlan("继续验收构建结果", runtime({ planGenerationRepair: repair }));

    expect(result).toEqual(normalizePlanPreconditions([candidate]));
    expect(result[0].status).toBe("pending");
    expect(result[0].result).toBeUndefined();
    expect(repair).toEqual(original);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("retired acceptance-copy feedback still rechecks current recovery metadata", async () => {
    const candidate = { ...diagnose("uname -a"), recovery: { ...diagnose().recovery!, failedStepId: "" } };
    const repair = buildPlanNormalizationRepair(new RecoveryProtocolError({
      code: "RECOVERY_ACCEPTANCE_MISMATCH", stepIndex: 0, fieldPath: "steps[0].recovery",
      expected: "旧版本验收错误", allowedRepairPaths: [], ruleVersion: RECOVERY_RULE_VERSION,
    }), [candidate]);

    await expect(backend.generatePlan("继续", runtime({ planGenerationRepair: repair })))
      .rejects.toThrow("PROTOCOL_REPAIR_SCOPE_UNKNOWN");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not resend the preserved next-stage decision with a rejected field", () => {
    const repair = { ...repairOf(), nextStageDecision: {
      reason: "OLD_DECISION".repeat(5_000), steps: [diagnose()],
    } };
    const compact = compactProtocolRepairContext(runtime().context, repair);
    const parsed = JSON.parse(compact);
    expect(parsed.planGenerationRepair.nextStageDecision).toBeUndefined();
    expect(compact).not.toContain("OLD_DECISION");
    expect(parsed.planGenerationRepair.previousModelOutput).toHaveLength(1);
    expect(parsed.planGenerationRepair.diagnostic).toEqual(repair.diagnostic);
    expect(parsed.taskGoal.rootGoal).toBe("部署应用");
    expect(parsed.permission).toBe("safe");
    expect(repair.nextStageDecision.reason).toContain("OLD_DECISION");
  });
  it("cannot delete an invalid array tail while claiming to repair only its value", () => {
    const step = { ...diagnose(), recovery: undefined, command: 'opsark-tool software.check {"names":["git",3]}' };
    const repair = repairOf([step]);
    expect(repair.fieldPath).toBe("steps[0].command.arguments.names[1]");
    expect(() => assertPlanRepairScope(repair, [{ ...step,
      command: 'opsark-tool software.check {"names":["git","node"]}' }])).not.toThrow();
    expect(() => assertPlanRepairScope(repair, [{ ...step,
      command: 'opsark-tool software.check {"names":["git"]}' }])).toThrow("删除报错数组元素");
  });

  it("finishes an obsolete saved tool repair locally when the complete preserved plan is now valid", async () => {
    const step = { ...diagnose(), recovery: undefined, command: 'opsark-tool software.check {"names":["git"]}' };
    const repair = buildPlanNormalizationRepair(new Error("第 1 个计划步骤的工具参数无效：旧版规则"), [step]);
    const result = await backend.generatePlan("继续", runtime({ planGenerationRepair: repair }));
    expect(result).toEqual(normalizePlanPreconditions([step]));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("repairs only the validator-identified tool argument and preserves every sibling", async () => {
    const step = { ...diagnose(), recovery: undefined,
      command: 'opsark-tool software.check {"names":[],"includeVersions":true}' };
    const repair = repairOf([step]);
    expect(repair).toMatchObject({ errorCode: "tool_schema_validation_failed",
      diagnostic: { code: "TOOL_ARGUMENT_INVALID", fieldPath: "steps[0].command.arguments.names",
        allowedRepairPaths: ["steps[0].command.arguments.names"] } });
    const valid = { ...step, command: 'opsark-tool software.check {"names":["kubeadm"],"includeVersions":true}' };
    expect(() => assertPlanRepairScope(repair, [valid])).not.toThrow();
    expect(() => assertPlanRepairScope(repair, [{ ...valid,
      command: valid.command.replace('"includeVersions":true', '"includeVersions":false') }]))
      .toThrow("其他工具参数");
    vi.mocked(invoke).mockResolvedValueOnce([valid]);
    const result = await backend.generatePlan("仅修复参数", runtime({ planGenerationRepair: repair }));
    expect(result[0].command).toContain('"kubeadm"');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("a duplicate option repair cannot reorder siblings, delete the field or change its title", () => {
    const args = { title: "选择安装方式", fields: [{ key: "MODE", label: "安装方式", description: "请选择安装来源", type: "select", required: true,
      options: [{ label: "A", value: "same" }, { label: "B", value: "same" }] }] };
    const step = { ...diagnose(), recovery: undefined, command: `opsark-tool user.request_input ${JSON.stringify(args)}` };
    const repair = repairOf([step]);
    expect(repair.fieldPath).toBe("steps[0].command.arguments.fields[0].options[1].value");
    const good = structuredClone(args);
    good.fields[0].options[1].value = "different";
    const candidate = (value: unknown) => [{ ...step, command: `opsark-tool user.request_input ${JSON.stringify(value)}` }];
    expect(() => assertPlanRepairScope(repair, candidate(good))).not.toThrow();
    expect(() => assertPlanRepairScope(repair, candidate({ ...good, title: "换目标" }))).toThrow("其他工具参数");
    expect(() => assertPlanRepairScope(repair, candidate({ ...good, fields: [] }))).toThrow("父结构");
    good.fields[0].options.reverse();
    expect(() => assertPlanRepairScope(repair, candidate(good))).toThrow("其他工具参数");
  });

  it("replays the actual incident without executing its command or repeating identical repairs", async () => {
    const steps = incident.sourceStepIds.map(id => ({ ...diagnose(incident.command), id }));
    const fingerprints = steps.map(step => planSemanticFingerprint([step]));
    expect(new Set(fingerprints).size).toBe(1);
    expect(repairOf([steps[0]]).diagnostic).toMatchObject({ code: "RECOVERY_DIAGNOSE_MUTATION", matchedToken: "mktemp" });
    expect(() => normalizePlanPreconditions([{ ...steps[0], command: incident.command.replace('rm -rf "$TMPD"', "") }]))
      .toThrow("RECOVERY_DIAGNOSE_MUTATION");
    vi.mocked(invoke).mockResolvedValueOnce([steps[0]]).mockResolvedValueOnce([steps[1]]);
    let failure: PlanProtocolError | undefined;
    try { await backend.generatePlan("复验原事故", runtime()); } catch (error) { failure = error as PlanProtocolError; }
    expect(failure!.repair.progress?.stopCode).toBe("PROTOCOL_REPAIR_NO_PROGRESS");
    for (const _step of steps.slice(2)) {
      await expect(backend.generatePlan("重试协议修复", runtime({ planGenerationRepair: failure!.repair })))
        .rejects.toThrow("PROTOCOL_REPAIR_NO_PROGRESS");
    }
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual(["generate_ai_plan", "generate_ai_plan"]);
  });

  it("reports the actual mutation and its command path instead of missing recovery fields", () => {
    const repair = repairOf();
    expect(repair.diagnostic).toMatchObject({ code: "RECOVERY_DIAGNOSE_MUTATION", stepIndex: 0,
      fieldPath: "steps[0].command", allowedRepairPaths: ["steps[0].command"] });
    expect(repair.validationError).toContain("matchedToken=");
    expect(repair.instruction).toContain("无落盘诊断");
  });

  it("ignores generated IDs and prose but preserves command, verification and target semantics", () => {
    const original = diagnose();
    expect(planSemanticFingerprint([original])).toBe(planSemanticFingerprint([
      { ...original, id: "generated-later", title: "新标题", description: "新描述" },
    ]));
    for (const changed of [
      { ...original, command: original.command + "\necho changed" },
      { ...original, expected: "改弱验收" },
      { ...original, recovery: { ...original.recovery!, failedStepId: "another-failure" } },
    ]) expect(planSemanticFingerprint([changed])).not.toBe(planSemanticFingerprint([original]));
    expect(planSemanticFingerprint([diagnose('printf "a b"')]))
      .not.toBe(planSemanticFingerprint([diagnose('printf "ab"')]));
  });

  it("rejects a no-change repair once and sends no request on repeated or restored retry", async () => {
    const invalid = diagnose();
    vi.mocked(invoke).mockResolvedValueOnce([invalid]).mockResolvedValueOnce([{ ...invalid, id: "generated-2" }]);
    let failure: PlanProtocolError | undefined;
    try { await backend.generatePlan("部署应用", runtime()); } catch (error) { failure = error as PlanProtocolError; }
    expect(failure).toBeInstanceOf(PlanProtocolError);
    expect(failure!.repair.progress).toMatchObject({ attemptCount: 1, stopCode: "PROTOCOL_REPAIR_NO_PROGRESS" });
    expect(invoke).toHaveBeenCalledTimes(2);
    const persisted = JSON.parse(JSON.stringify(failure!.repair));
    await expect(backend.generatePlan("继续修复", runtime({ planGenerationRepair: persisted })))
      .rejects.toThrow("PROTOCOL_REPAIR_NO_PROGRESS");
    await expect(backend.generatePlan("再次修复", runtime({ planGenerationRepair: persisted })))
      .rejects.toThrow("PROTOCOL_REPAIR_NO_PROGRESS");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("merges a single repaired step at its original position without asking the model to rewrite other steps", async () => {
    const previous = { ...diagnose("uname -a"), id: "preceding", recovery: undefined };
    const invalid = diagnose();
    vi.mocked(invoke).mockResolvedValueOnce([previous, invalid]).mockResolvedValueOnce([
      { ...invalid, id: "new-id", command: "getconf _NPROCESSORS_ONLN\nfree -m" },
    ]);
    const result = await backend.generatePlan("部署应用", runtime({ baseSnapshot: { output: "history".repeat(20000) } }));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(normalizePlanPreconditions([previous])[0]);
    expect(result[1]).toMatchObject({ id: invalid.id, command: "getconf _NPROCESSORS_ONLN\nfree -m" });
    const payload = JSON.parse(String((vi.mocked(invoke).mock.calls[1][1] as { context: string }).context));
    expect(payload.baseSnapshot).toBeUndefined();
    expect(payload.planGenerationRepair.previousModelOutput).toHaveLength(1);
    expect(payload.planGenerationRepair.originalStepIndices).toEqual([1]);
    expect(payload.protocolRepairBudget.remainingModelCalls).toBe(1);
    expect(payload.permission).toBe("safe");
  });

  it("enforces local scope for generic protocol repairs, including recovery and execution settings", () => {
    const repair = repairOf();
    const valid = { ...diagnose(), command: "uname -a" };
    expect(() => assertPlanRepairScope(repair, [valid])).not.toThrow();
    for (const candidate of [
      { ...valid, expected: "weaker" }, { ...valid, kind: "change" as const },
      { ...valid, recovery: { ...valid.recovery!, purpose: "repair" as const } },
      { ...valid, executionScope: "isolated_exec" as const },
      { ...valid, command: 'opsark-tool software.check {"names":["node"]}' },
    ]) expect(() => assertPlanRepairScope(repair, [candidate])).toThrow();
    expect(() => assertPlanRepairScope(repair, [valid, valid])).toThrow("步骤数量");
  });

  it("accepts omitted Rust Option defaults without accepting an actual scope change", () => {
    const original = { ...diagnose(), executionScope: undefined, validationScope: undefined, runtimeClass: undefined,
      sessionContextChange: null } as unknown as PlanStep;
    const repair = repairOf([original]);
    const response = { ...diagnose("uname -a"), sessionContextChange: undefined };
    expect(() => assertPlanRepairScope(repair, [response])).not.toThrow();
    expect(() => assertPlanRepairScope(repair, [{ ...response, validationScope: "fresh_login_shell" }]))
      .toThrow("validationScope");
  });

  it("keeps protocol context independent of history size while retaining the referenced failed attempt", () => {
    const repair = repairOf();
    const make = (history: string) => compactProtocolRepairContext(JSON.stringify({
      baseSnapshot: { task: { permission: "safe" }, executionConstraints: { changePolicy: "read_only" }, rootGoal: "部署应用", output: history },
      conversationHistory: [{ role: "assistant", content: history }], previousExecution: { output: history },
      recovery: { failedAttempts: [{ failedStepId: "real-failed-step", verification: { command: "test -s /status" } },
        { failedStepId: "unrelated", output: history }] },
      tools: [{ id: "software.check", inputSchema: { large: history } }],
    }), repair);
    const short = make("old"); const long = make("history".repeat(100000));
    expect(long).toBe(short);
    const projected = JSON.parse(long);
    expect(projected.permission).toBe("safe");
    expect(projected.executionConstraints.changePolicy).toBe("read_only");
    expect(projected.taskGoal.rootGoal).toBe("部署应用");
    expect(projected.recovery.failedAttempts).toHaveLength(1);
    expect(projected.recovery.failedAttempts[0].verification.command).toBe("test -s /status");
    expect(projected.tools).toEqual([]);
  });

  it("maps legacy recovery blockers to failedAttempts without restoring a blocker gate", () => {
    const projected = JSON.parse(compactProtocolRepairContext(JSON.stringify({
      recovery: { blockers: [
        { failedStepId: "real-failed-step", output: "legacy evidence" },
        { failedStepId: "unrelated", output: "ignore" },
      ] },
    }), repairOf()));

    expect(projected.recovery.blockers).toBeUndefined();
    expect(projected.recovery.failedAttempts).toEqual([
      { failedStepId: "real-failed-step", output: "legacy evidence" },
    ]);
  });

  it("does not call the model when no field-local repair scope is known", async () => {
    const invalid = { ...diagnose("uname -a"), recovery: { ...diagnose().recovery!, failedStepId: "" } };
    vi.mocked(invoke).mockResolvedValueOnce([invalid]);
    await expect(backend.generatePlan("部署应用", runtime())).rejects.toThrow("PROTOCOL_REPAIR_SCOPE_UNKNOWN");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("preserves a stopped Rust repair and its budget through a traced error and restart", async () => {
    const original = diagnose();
    const envelope = { issue: repairOf().diagnostic, steps: [original], repairAttempted: true,
      repairStopCode: "PROTOCOL_REPAIR_NO_PROGRESS", modelCalls: 2, focusedRepairCalls: 1 };
    const trace = { attempts: [], normalizations: [] };
    vi.mocked(invoke).mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({ message: JSON.stringify(envelope), developerTrace: trace })}`);
    let failure: PlanProtocolError | undefined;
    try { await backend.generatePlan("部署应用", runtime()); } catch (error) { failure = error as PlanProtocolError; }
    expect(failure).toBeInstanceOf(PlanProtocolError);
    expect(failure!.repair.previousModelOutput).toEqual([original]);
    expect(failure!.repair.progress?.stopCode).toBe("PROTOCOL_REPAIR_NO_PROGRESS");
    expect(failure!.developerTrace).toEqual(trace);
    await expect(backend.generatePlan("重试", runtime({ planGenerationRepair: JSON.parse(JSON.stringify(failure!.repair)) })))
      .rejects.toThrow("PROTOCOL_REPAIR_NO_PROGRESS");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each([
    ["PROTOCOL_REPAIR_SCOPE_VIOLATION", "修复改变了字段白名单之外的步骤内容"],
    ["PROTOCOL_REPAIR_BUDGET_EXHAUSTED", "达到局部针对性修复硬上限"],
    ["PROTOCOL_REPAIR_SCOPE_UNKNOWN", "缺少权威字段范围"],
    ["PROTOCOL_REPAIR_NEW_RUNTIME_STOP", "新版本运行时的真实停止原因"],
  ])("preserves %s and its original reason across the Rust boundary and a restored retry", async (code, reason) => {
    const envelope = { issue: repairOf().diagnostic, steps: [diagnose()], repairAttempted: true,
      repairStopCode: code, reason, modelCalls: 2, focusedRepairCalls: 1 };
    vi.mocked(invoke).mockRejectedValueOnce(JSON.stringify(envelope));
    let failure: PlanProtocolError | undefined;
    try { await backend.generatePlan("部署应用", runtime()); } catch (error) { failure = error as PlanProtocolError; }
    expect(failure).toBeInstanceOf(PlanProtocolError);
    expect(failure!.repair.progress).toMatchObject({ stopCode: code, stopReason: reason, attemptCount: 1 });
    expect(failure!.repairError).toBe(`${code}：${reason}`);
    expect(failure!.message).not.toContain("PROTOCOL_REPAIR_NO_PROGRESS");
    expect(failure!.message).not.toContain("不得重规划业务");
    const persisted = JSON.parse(JSON.stringify(failure!.repair));
    await expect(backend.generatePlan("重试协议修复", runtime({ planGenerationRepair: persisted })))
      .rejects.toMatchObject({ repairError: `${code}：${reason}` });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("does not invent no-progress evidence when an older Rust error omitted its stop code", async () => {
    const envelope = { issue: repairOf().diagnostic, steps: [diagnose()], repairAttempted: true,
      reason: "修复响应解析失败", focusedRepairCalls: 1 };
    vi.mocked(invoke).mockRejectedValueOnce(JSON.stringify(envelope));
    await expect(backend.generatePlan("部署应用", runtime())).rejects.toMatchObject({
      repairError: "PROTOCOL_REPAIR_FAILED：修复响应解析失败",
      repair: { progress: { stopCode: "PROTOCOL_REPAIR_FAILED", stopReason: "修复响应解析失败" } },
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("retains a scope violation from a compact Rust repair instead of replacing it with no-progress", async () => {
    const invalid = diagnose();
    const previous = { ...diagnose("uname -a"), id: "preceding", recovery: undefined };
    const reason = "修复改变了字段白名单之外的步骤内容";
    const envelope = { issue: repairOf().diagnostic, steps: [invalid], repairAttempted: true,
      repairStopCode: "PROTOCOL_REPAIR_SCOPE_VIOLATION", reason, focusedRepairCalls: 1 };
    const trace = { attempts: [], normalizations: [] };
    vi.mocked(invoke).mockResolvedValueOnce([previous, invalid])
      .mockRejectedValueOnce(`OPSARK_MODEL_TRACE_V1:${JSON.stringify({ message: JSON.stringify(envelope), developerTrace: trace })}`);
    let failure: PlanProtocolError | undefined;
    try { await backend.generatePlan("部署应用", runtime()); } catch (error) { failure = error as PlanProtocolError; }
    expect(failure!.repair.previousModelOutput).toEqual([previous, invalid]);
    expect(failure!.repair.diagnostic?.fieldPath).toBe("steps[1].command");
    expect(failure!.repair.progress).toMatchObject({ stopCode: "PROTOCOL_REPAIR_SCOPE_VIOLATION", stopReason: reason });
    expect(failure!.repairError).toBe(`PROTOCOL_REPAIR_SCOPE_VIOLATION：${reason}`);
    expect(failure!.developerTrace).toEqual(trace);
    await expect(backend.generatePlan("重试", runtime({ planGenerationRepair: JSON.parse(JSON.stringify(failure!.repair)) })))
      .rejects.toMatchObject({ repairError: `PROTOCOL_REPAIR_SCOPE_VIOLATION：${reason}` });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("classifies a frontend field-scope violation before a retry can disguise it as no-progress", async () => {
    const invalid = diagnose();
    vi.mocked(invoke).mockResolvedValueOnce([invalid]).mockResolvedValueOnce([
      { ...invalid, command: "uname -a", description: "擅自改变的业务说明" },
    ]);
    let failure: PlanProtocolError | undefined;
    try { await backend.generatePlan("部署应用", runtime()); } catch (error) { failure = error as PlanProtocolError; }
    expect(failure!.repair.previousModelOutput).toEqual([invalid]);
    expect(failure!.repair.progress).toMatchObject({ stopCode: "PROTOCOL_REPAIR_SCOPE_VIOLATION",
      stopReason: "协议修复不得改写 steps[0].description" });
    const persisted = JSON.parse(JSON.stringify(failure!.repair));
    await expect(backend.generatePlan("重试", runtime({ planGenerationRepair: persisted })))
      .rejects.toMatchObject({ repairError: "PROTOCOL_REPAIR_SCOPE_VIOLATION：协议修复不得改写 steps[0].description" });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("uses the persisted stop code's own explanation when legacy records have no reason", async () => {
    const invalid = diagnose();
    vi.mocked(invoke).mockResolvedValueOnce([invalid]).mockResolvedValueOnce([invalid]);
    let failure: PlanProtocolError | undefined;
    try { await backend.generatePlan("部署应用", runtime()); } catch (error) { failure = error as PlanProtocolError; }
    const persisted = JSON.parse(JSON.stringify(failure!.repair));
    persisted.progress.stopCode = "PROTOCOL_REPAIR_SCOPE_VIOLATION";
    await expect(backend.generatePlan("重试", runtime({ planGenerationRepair: persisted })))
      .rejects.toMatchObject({ repairError: "PROTOCOL_REPAIR_SCOPE_VIOLATION：修复改变了允许字段之外的步骤内容，需要生成业务调整方案并重新审批" });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("retains requirement classification when Rust returns a protocol failure inside planError", async () => {
    const envelope = { issue: repairOf().diagnostic, steps: [diagnose()], repairAttempted: true,
      repairStopCode: "PROTOCOL_REPAIR_NO_PROGRESS", modelCalls: 2, focusedRepairCalls: 1 };
    const processed = { intent: "execute", relation: "continue", selectedSkillIds: [], plan: [],
      constraints: { changePolicy: "read_only" }, planError: `需求已判定为执行类，但计划生成失败：${JSON.stringify(envelope)}` };
    vi.mocked(invoke).mockResolvedValueOnce(processed);
    let failure: PlanProtocolError | undefined;
    try { await backend.processRequirement("继续", runtime()); } catch (error) { failure = error as PlanProtocolError; }
    expect(failure).toBeInstanceOf(PlanProtocolError);
    expect(failure!.processed).toEqual(processed);
    expect(failure!.repair.diagnostic?.code).toBe("RECOVERY_DIAGNOSE_MUTATION");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("retains newly classified constraints and selected Skill instructions during an initial repair", async () => {
    const skill = { id: "fixture-skill", name: "fixture", description: "fixture", version: 1,
      instructions: "只能检查，不得安装依赖", allowedToolIds: [], forbiddenToolIds: ["server.connect"] };
    const processed = { intent: "execute", relation: "new_goal", selectedSkillIds: [skill.id], plan: [diagnose()],
      constraints: { changePolicy: "read_only", environmentPolicy: "preserve", failurePolicy: "strict",
        prohibitedActions: ["不得安装"], userDirectives: ["只读检查"], requiredConditions: [] } };
    vi.mocked(invoke).mockResolvedValueOnce(processed).mockResolvedValueOnce([diagnose("uname -a")]);
    await backend.processRequirement("只读检查", runtime({ executionConstraints: undefined, activeSkills: [] }), [skill]);
    const context = JSON.parse((vi.mocked(invoke).mock.calls[1][1] as { context: string }).context);
    expect(context.executionConstraints).toEqual(processed.constraints);
    expect(context.activeSkills).toEqual([skill]);
  });

  it("repairs a rejected Rust next-stage plan without losing the joint decision or regenerating the business", async () => {
    const decision = { decision: "adjust", reason: "先检查阻断", summary: "原目标尚未完成" };
    const envelope = { issue: repairOf().diagnostic, steps: [diagnose()], repairAttempted: false,
      repairStopCode: "PROTOCOL_REPAIR_BUDGET_EXHAUSTED",
      modelCalls: 1, focusedRepairCalls: 0, nextStageDecision: decision };
    vi.mocked(invoke).mockRejectedValueOnce(JSON.stringify(envelope)).mockResolvedValueOnce([diagnose("uname -a")]);
    const result = await backend.decideNextStage("部署应用", runtime());
    expect(result).toMatchObject({ ...decision, source: "model", steps: [{ command: "uname -a" }] });
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual(["decide_ai_next_stage", "generate_ai_plan"]);
  });
});
