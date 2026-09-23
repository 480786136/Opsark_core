import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideTaskNextStage } from "./agentService";
import { backend, buildPlanNormalizationRepair, PlanProtocolError } from "@/services/backend";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import type { ModelProfile, NextStageDecision, OpsTask, PlanStep } from "@/types";
import missingSteps from "@/services/fixtures/next-stage-missing-steps.json";
import { protocolRejectionFingerprint } from "@/services/planProtocolRepair";

const model: ModelProfile = { id: "model", name: "model", provider: "Remote", model: "fixture",
  endpoint: "https://fixture.invalid", enabled: true, hasApiKey: true };
const observe = (command: string): PlanStep => ({ id: command, kind: "observe", command,
  title: "检查", description: "读取证据", expected: "获得事实", validation: "", risk: "low", status: "pending" });
const failure = (command: string, reason = "第 1 个计划步骤调用了当前规划上下文未开放工具 hidden.read") =>
  new PlanProtocolError(buildPlanNormalizationRepair(reason, [observe(command)]), "重新规划");
const parseFailure = (rawModelResponse = JSON.stringify(missingSteps)) => new PlanProtocolError({
  errorCode: "next_stage_response_invalid", previousModelOutput: [], rawModelResponse,
  validationError: "阶段联合决策结构解析失败：missing field steps", instruction: "返回完整联合决策",
}, "响应无法解析");

function fixture() {
  const initial = failure('opsark-tool evidence.read {"evidenceId":"old"}', "只读批次不能混入变更、Shell 或 standalone 工具；全部步骤必须为 observe 且参数已确定");
  const task: OpsTask = {
    id: "task", serverId: "server", title: "部署", rootGoal: "部署应用", currentRoundId: "round",
    status: "needs_adjustment", permission: "safe", modelId: model.id,
    messages: [], plan: [{ ...observe("pwd"), status: "completed", output: "/opt/report" }],
    createdAt: "now", updatedAt: "now",
    protocolRepair: { roundId: "round", serverId: "server", repair: initial.repair, repairError: initial.repairError },
  };
  return { task, model, apiKey: "fixture", tools: defaultToolCatalog, secretMetadata: [], skills: [],
    generationSettings: { limitOutput: false, maxPlanSteps: 6, maxOutputTokens: 5000, maxTextChars: 200, maxCommandChars: 4000 } };
}
const next = (steps: PlanStep[] = [observe("uname -a")]): NextStageDecision => ({
  source: "model", decision: steps.length ? "continue" : "adjust", reason: "依据已有证据继续", summary: "目标未完成", steps,
});

beforeEach(() => localStorage.clear());

describe("bounded protocol recovery", () => {
  it("recovers the first safety rejection during an ordinary adjustment without replaying evidence", async () => {
    const input = { ...fixture(), recoverProtocolFailures: true };
    delete input.task.protocolRepair;
    const saved = structuredClone(input.task.plan);
    const rejected = failure("GIT_TERMINAL_PROMPT=0 git ls-remote https://example.test/repo.git | head -n 20",
      "steps[0].command PIPELINE_STATUS_LOST：关键命令直接管道到 head/tail");
    const decide = vi.fn().mockRejectedValueOnce(rejected).mockResolvedValueOnce(next([
      observe("GIT_TERMINAL_PROMPT=0 git ls-remote https://example.test/repo.git HEAD"),
    ]));
    const result = await decideTaskNextStage(input, decide);
    expect(decide).toHaveBeenCalledTimes(2);
    const context = JSON.parse(decide.mock.calls[1][1].context);
    expect(context.protocolReplan.rule).toContain("PIPELINE_STATUS_LOST");
    expect(context.protocolRepairBudget.remainingModelCalls).toBe(1);
    expect(result.nextPlan[0].command).not.toContain("head -n");
    expect(input.task.plan).toEqual(saved);
  });

  it("caps ordinary adjustment at one original and two revised proposals", async () => {
    const input = { ...fixture(), recoverProtocolFailures: true };
    delete input.task.protocolRepair;
    const last = failure("third", "PIPELINE_STATUS_LOST");
    const decide = vi.fn().mockRejectedValueOnce(failure("first"))
      .mockRejectedValueOnce(failure("second")).mockRejectedValue(last);
    await expect(decideTaskNextStage(input, decide)).rejects.toBe(last);
    expect(decide).toHaveBeenCalledTimes(3);
    expect(last.repair.businessReplanProgress).toEqual({ attemptCount: 2, stopReason: "budget_exhausted" });
    expect(last.userMessage).toContain("已尝试 2 次");
    expect(last.userMessage).toContain("PIPELINE_STATUS_LOST");
  });

  it("stops an unchanged ordinary proposal after one repair and identifies no progress", async () => {
    const input = { ...fixture(), recoverProtocolFailures: true };
    delete input.task.protocolRepair;
    const repeated = failure("same");
    const decide = vi.fn().mockRejectedValue(repeated);
    await expect(decideTaskNextStage(input, decide)).rejects.toBe(repeated);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(repeated.repair.businessReplanProgress).toEqual({ attemptCount: 1, stopReason: "no_progress" });
  });
  it("feeds the missing-steps response back and accepts a real standalone question", async () => {
    const input = fixture();
    const original = parseFailure();
    input.task.protocolRepair!.repair = original.repair;
    const question = { ...observe('opsark-tool user.request_input {"title":"部署方式","description":"请选择部署方式","fields":[{"key":"mode","label":"部署方式","description":"选择运行方式","type":"select","required":true,"options":[{"value":"host","label":"主机服务"},{"value":"container","label":"容器"}]}]}'),
      validation: "true" };
    const decide = vi.fn().mockResolvedValueOnce({ ...next([question]), decision: "adjust" });
    const result = await decideTaskNextStage(input, decide);
    const context = JSON.parse(decide.mock.calls[0][1].context);
    expect(context.protocolReplan.rejectedResponse.content).toBe(original.repair.rawModelResponse);
    expect(context.protocolReplan.rejectedResponse.instruction).toContain("不能只在 summary 中声称已提问");
    expect(result.complete).toBe(false);
    expect(result.nextPlan).toHaveLength(1);
    const prefix = "opsark-tool user.request_input ";
    expect(result.nextPlan[0].command.startsWith(prefix)).toBe(true);
    expect(JSON.parse(result.nextPlan[0].command.slice(prefix.length)))
      .toEqual(JSON.parse(question.command.slice(prefix.length)));
    expect(result.nextPlan[0].status).toBe("pending");
    expect(input.task.plan[0].status).toBe("completed");
  });

  it("distinguishes different malformed responses but stops a repeated response regardless of JSON formatting", async () => {
    const input = fixture();
    const initial = parseFailure();
    input.task.protocolRepair!.repair = initial.repair;
    const repeated = parseFailure(JSON.stringify(missingSteps, null, 2));
    expect(protocolRejectionFingerprint(initial.repair)).toBe(protocolRejectionFingerprint(repeated.repair));
    const repeat = vi.fn().mockRejectedValue(repeated);
    await expect(decideTaskNextStage(input, repeat)).rejects.toBe(repeated);
    expect(repeat).toHaveBeenCalledOnce();

    const changed = parseFailure('{"decision":"adjust","reason":"more evidence","steps":{}}');
    expect(protocolRejectionFingerprint(initial.repair)).not.toBe(protocolRejectionFingerprint(changed.repair));
    const progress = vi.fn().mockRejectedValueOnce(changed).mockResolvedValueOnce(next());
    await expect(decideTaskNextStage(input, progress)).resolves.toMatchObject({ complete: false });
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it("caps successive different parse failures without changing completed evidence", async () => {
    const input = fixture();
    input.task.protocolRepair!.repair = parseFailure().repair;
    const saved = structuredClone(input.task.plan);
    const last = parseFailure('{"decision":false,"steps":[]}');
    const decide = vi.fn().mockRejectedValueOnce(parseFailure('{"steps":null}')).mockRejectedValue(last);
    await expect(decideTaskNextStage(input, decide)).rejects.toBe(last);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(input.task.plan).toEqual(saved);
  });

  it("feeds the latest tool rejection back and accepts a new legal proposal without changing evidence", async () => {
    const input = fixture();
    const original = structuredClone(input.task);
    const error = failure("opsark-tool hidden.read {}");
    const decide = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(next());
    const execute = vi.spyOn(backend, "executeCommand");
    try {
      const result = await decideTaskNextStage(input, decide);
      expect(decide).toHaveBeenCalledTimes(2);
      const before = JSON.parse(decide.mock.calls[0][1].context);
      const after = JSON.parse(decide.mock.calls[1][1].context);
      expect(after.protocolReplan.rule).toContain("hidden.read");
      expect(after.protocolReplan.rejectedPlanExecuted).toBe(false);
      expect(after.baseSnapshot).toEqual(before.baseSnapshot);
      expect(after.tools).toEqual(before.tools);
      expect(after.executionConstraints).toEqual(before.executionConstraints);
      expect(result.nextPlan[0].command).toBe("uname -a");
      expect(result.nextPlan[0].status).toBe("pending");
      expect(result.complete).toBe(false);
      expect(input.task).toEqual(original);
      expect(execute).not.toHaveBeenCalled();
    } finally { execute.mockRestore(); }
  });

  it("stops immediately if the model repeats the original rejected proposal", async () => {
    const input = fixture();
    const repeated = new PlanProtocolError(input.task.protocolRepair!.repair, "same plan");
    const decide = vi.fn().mockRejectedValue(repeated);
    await expect(decideTaskNextStage(input, decide)).rejects.toBe(repeated);
    expect(decide).toHaveBeenCalledOnce();
  });

  it("caps changing protocol failures at two proposals", async () => {
    const input = fixture();
    const last = failure("opsark-tool missing.tool {}");
    const decide = vi.fn().mockRejectedValueOnce(failure("opsark-tool hidden.read {}"))
      .mockRejectedValue(last);
    await expect(decideTaskNextStage(input, decide)).rejects.toBe(last);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(input.task.plan[0].status).toBe("completed");
  });

  it("never retries service errors as protocol failures", async () => {
    const error = new Error("network unavailable");
    const decide = vi.fn().mockRejectedValue(error);
    await expect(decideTaskNextStage(fixture(), decide)).rejects.toBe(error);
    expect(decide).toHaveBeenCalledOnce();
  });

  it("honors cancellation before another proposal", async () => {
    let cancelled = false;
    const decide = vi.fn().mockImplementation(async () => {
      cancelled = true;
      throw failure("opsark-tool hidden.read {}");
    });
    await expect(decideTaskNextStage({ ...fixture(), isCancelled: () => cancelled }, decide))
      .rejects.toThrow("过期");
    expect(decide).toHaveBeenCalledOnce();
  });

  it("accepts a genuine no-action result without inventing executable work", async () => {
    const decide = vi.fn().mockRejectedValueOnce(failure("opsark-tool hidden.read {}"))
      .mockResolvedValueOnce(next([]));
    const result = await decideTaskNextStage(fixture(), decide);
    expect(result.nextPlan).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it("still rejects a mutating fallback under explicit read-only authorization", async () => {
    const input = fixture();
    input.task.executionConstraints = { changePolicy: "read_only", environmentPolicy: "preserve",
      failurePolicy: "strict", prohibitedActions: [], requiredConditions: [], userDirectives: ["只读"] };
    const decide = vi.fn().mockRejectedValueOnce(failure("opsark-tool hidden.read {}"))
      .mockResolvedValueOnce(next([{ ...observe("touch /tmp/result"), kind: "change", validation: "test -f /tmp/result" }]));
    await expect(decideTaskNextStage(input, decide)).rejects.toThrow("只读授权");
    expect(input.task.plan[0].command).toBe("pwd");
  });
});
