import { describe, expect, it, vi } from "vitest";
import { buildNextStageContext, nextStagePolicyFingerprint } from "./agentContext";
import { decideTaskNextStage, planDiscoveryContinuation, planTaskAdjustment } from "./agentService";
import { StaleWorkflowError } from "./workflowLifetime";
import type { ModelProfile, NextStageDecision, OpsTask, PlanStep, ServerProfile } from "@/types";

const model: ModelProfile = { id: "model", name: "fixture", provider: "Remote", model: "fixture", endpoint: "https://fixture.invalid", enabled: true, hasApiKey: true };
const step = (id: string, command: string): PlanStep => ({ id, command, action: { type: "shell", command }, title: "只读检查", description: "读取真实证据", expected: "返回主机信息",
  kind: "observe", risk: "low", validation: "", status: "pending" });
function fixture() {
  const server: ServerProfile = { id: "server", name: "测试服务器", host: "before.invalid", port: 22, username: "ops", group: "test", status: "online", environment: [], createdAt: "2026-10-23",
    info: { os: "Linux", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" } };
  const task: OpsTask = { id: "task", serverId: server.id, title: "检查系统", rootGoal: "检查系统", currentInstruction: "检查系统", currentRoundId: "round", status: "needs_adjustment", permission: "safe", modelId: model.id,
    messages: [], plan: [{ ...step("done", "pwd"), status: "completed", output: "/srv/existing" }], createdAt: "2026-10-23", updatedAt: "2026-10-23",
    executionConstraints: { changePolicy: "read_only", environmentPolicy: "preserve", failurePolicy: "strict", prohibitedActions: [], requiredConditions: [], userDirectives: ["只读"] } };
  return { task, server, model, apiKey: "fixture", tools: [], secretMetadata: [], skills: [],
    generationSettings: { limitOutput: false, maxPlanSteps: 6, maxOutputTokens: 5000, maxTextChars: 200, maxCommandChars: 4000 } };
}
const changes = [
  ["host", "after.invalid"], ["port", 2222], ["username", "other-account"],
] as const;
function changeServer(server: ServerProfile, field: typeof changes[number][0], value: string | number) {
  Object.assign(server, { [field]: value });
}

describe("第二十一批：同ID服务器连接资料变更使旧计划失效", () => {
  it.each(changes)("缓存指纹绑定公开连接字段：%s", (field, value) => {
    const input = fixture(), original = structuredClone(input.server);
    const cached = nextStagePolicyFingerprint(input);
    // Simulate replacing the server record in the store while keeping its ID.
    const current = { ...input, server: { ...input.server, [field]: value } };
    expect(nextStagePolicyFingerprint(current)).not.toBe(cached);
    expect(input.server).toEqual(original); expect(current.server.id).toBe(original.id);
  });

  it("规划上下文携带完整公开连接身份，不包含密码", () => {
    const input = fixture(); Object.assign(input.server, { password: "private-server-password" });
    const context = buildNextStageContext(input);
    expect(context.server).toMatchObject({ id: "server", host: "before.invalid", port: 22, username: "ops" });
    expect(JSON.stringify(context)).not.toContain("private-server-password");
  });

  it.each(changes)("模型等待期间%s变化，旧响应不进入新计划或自动恢复", async (field, value) => {
    const input = fixture(), before = structuredClone(input.task);
    const decide = vi.fn(async (): Promise<NextStageDecision> => {
      changeServer(input.server, field, value);
      return { source: "model", decision: "continue", reason: "继续只读检查", summary: "尚需系统信息", steps: [step("new", "uname -a")] };
    });
    await expect(decideTaskNextStage(input, decide)).rejects.toBeInstanceOf(StaleWorkflowError);
    expect(decide).toHaveBeenCalledOnce(); expect(input.task).toEqual(before);
  });

  it.each(["continuation", "adjustment"] as const)("%s入口也拒绝连接身份变化后的旧候选", async mode => {
    const input = fixture(), before = structuredClone(input.task);
    const generate = vi.fn(async () => { input.server.port = 2222; return [step("new", "uname -a")]; });
    const promise = mode === "continuation"
      ? planDiscoveryContinuation({ ...input, requirement: "继续只读检查" }, generate)
      : planTaskAdjustment(input, generate);
    await expect(promise).rejects.toBeInstanceOf(StaleWorkflowError);
    expect(generate).toHaveBeenCalledOnce(); expect(input.task).toEqual(before);
  });

  it("名称、在线状态和实时主机信息变化不使规划失效", () => {
    const input = fixture(), fingerprint = nextStagePolicyFingerprint(input);
    input.server.name = "仅显示名称变化"; input.server.status = "offline"; input.server.info.uptime = "2h";
    expect(nextStagePolicyFingerprint(input)).toBe(fingerprint);
  });

  it("密码变化不进入公开身份指纹或模型上下文", () => {
    const input = fixture(), fingerprint = nextStagePolicyFingerprint(input);
    Object.assign(input.server, { password: "private-server-password" });
    expect(nextStagePolicyFingerprint(input)).toBe(fingerprint);
    expect(JSON.stringify(buildNextStageContext(input))).not.toContain("private-server-password");
  });
});
