import { describe, expect, it, vi } from "vitest";
import { restoreUserInputRequests } from "@/features/agent/restoreUserInputRequests";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import type { OpsTask, PlanStep, TaskStatus } from "@/types";

const inputArguments = {
  title: "确认目标",
  description: "确认后继续当前任务",
  fields: [{ key: "TARGET", label: "目标", description: "本次操作对象", type: "text", required: true }],
};

function inputStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "input-step", title: "确认目标", description: "确认本次任务范围",
    command: `opsark-tool user.request_input ${JSON.stringify(inputArguments)}`,
    expected: "用户确认目标", validation: "", risk: "low", status: "awaiting_input",
    ...overrides,
  };
}

function task(overrides: Partial<OpsTask> = {}): OpsTask {
  return {
    id: "task-1", serverId: "server-1", title: "处理指定目标", status: "awaiting_input",
    permission: "managed", modelId: "model-1", messages: [], plan: [inputStep()],
    currentRoundId: "round-1", workflowEpoch: 3,
    createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("restoreUserInputRequests", () => {
  it("恢复选择器候选项但不把旧回答或第一个选项设为默认值", () => {
    const fields = [{ key: "TARGET", label: "选择目标", description: "从已发现目标中选择", type: "select", required: true,
      options: [{ value: "target-a", label: "目标甲" }, { value: "target-b", label: "目标乙" }] }];
    const current = task({ plan: [inputStep({ command: `opsark-tool user.request_input ${JSON.stringify({ title: "选择目标", fields })}` })],
      submittedInputs: { TARGET: { value: "target-a", type: "select", label: "旧问题", description: "旧目标",
        groupId: "old-request", groupTitle: "旧问题", submittedAt: "2026-09-14T00:00:00Z" } } });
    const [restored] = restoreUserInputRequests([current], defaultToolCatalog, () => "restored-select");
    expect(restored.fields[0]).toMatchObject(fields[0]);
    expect(restored.fields[0]).not.toHaveProperty("value");
    expect(restored.fields[0]).not.toHaveProperty("defaultValue");
    expect(restored).not.toHaveProperty("values");
  });

  it("恢复唯一未回答表单，绑定当前任务上下文并生成新的调用 ID", () => {
    const current = task({ executionTargetServerId: "target-server" });
    const snapshot = structuredClone(current);
    const createCallId = vi.fn().mockReturnValueOnce("restored-1").mockReturnValueOnce("restored-2");
    const restored = restoreUserInputRequests([current], defaultToolCatalog, createCallId);
    expect(restored).toEqual([{
      ...inputArguments, taskId: current.id, stepId: "input-step", callId: "restored-1",
      roundId: "round-1", workflowEpoch: 3, serverId: "target-server", command: current.plan[0].command,
    }]);
    expect(restoreUserInputRequests([current], defaultToolCatalog, createCallId)[0].callId).toBe("restored-2");
    expect(current).toEqual(snapshot);
  });

  it("旧任务无 epoch 或切换目标时使用默认 epoch 和任务服务器", () => {
    const current = task({ workflowEpoch: undefined, currentRoundId: undefined });
    expect(restoreUserInputRequests([current], defaultToolCatalog, () => "restored")[0]).toMatchObject({
      workflowEpoch: 0, serverId: "server-1", roundId: undefined,
    });
  });

  it("已结束步骤可以保留在计划内，仅恢复剩余的唯一等待输入步骤", () => {
    const current = task({ plan: [
      inputStep({ id: "done", status: "completed" }),
      inputStep({ id: "failed", status: "failed" }),
      inputStep({ id: "skipped", status: "skipped" }),
      inputStep(),
    ] });
    expect(restoreUserInputRequests([current], defaultToolCatalog, () => "restored")).toHaveLength(1);
  });

  it("忽略非等待输入任务和已请求取消的任务", () => {
    const statuses: TaskStatus[] = [
      "draft", "planning", "planning_failed", "awaiting_plan_approval", "running", "awaiting_step_approval",
      "validating", "awaiting_continuation", "needs_adjustment", "completed", "failed", "cancelled",
    ];
    const tasks = statuses.map((status) => task({ status }));
    tasks.push(task({ cancelRequested: true }));
    const createCallId = vi.fn(() => "restored");
    expect(restoreUserInputRequests(tasks, defaultToolCatalog, createCallId)).toEqual([]);
    expect(createCallId).not.toHaveBeenCalled();
  });

  it("忽略多个未结束步骤以及没有等待输入步骤的计划", () => {
    const unfinishedStatuses = ["pending", "awaiting_approval", "running", "validating", "awaiting_input"] as const;
    const tasks = unfinishedStatuses.map((status) => task({
      plan: [inputStep(), inputStep({ id: "other", status })],
    }));
    tasks.push(task({ plan: [] }), task({ plan: [inputStep({ status: "completed" })] }));
    tasks.push(...unfinishedStatuses.filter((status) => status !== "awaiting_input")
      .map((status) => task({ plan: [inputStep({ status })] })));
    expect(restoreUserInputRequests(tasks, defaultToolCatalog, () => "restored")).toEqual([]);
  });

  it("忽略无效、非输入及禁用工具命令，并继续恢复其他有效任务", () => {
    const invalidCommands = [
      "echo waiting",
      "opsark-tool user.request_input {",
      'opsark-tool user.request_input {"title":"确认","fields":[]}',
      `opsark-tool user.request_input ${JSON.stringify(inputArguments)} && echo done`,
      'opsark-tool files.get_structure {"rootPath":"/opt"}',
      `opsark-tool missing.tool ${JSON.stringify(inputArguments)}`,
    ];
    const tasks = invalidCommands.map((command, index) => task({ id: `invalid-${index}`, plan: [inputStep({ command })] }));
    const current = task();
    tasks.push(current);
    const restored = restoreUserInputRequests(tasks, defaultToolCatalog, () => "restored");
    expect(restored).toHaveLength(1);
    expect(restored[0].taskId).toBe(current.id);
    const disabledTools = defaultToolCatalog.map((tool) => tool.id === "user.request_input" ? { ...tool, enabled: false } : tool);
    expect(restoreUserInputRequests([current], disabledTools, () => "restored")).toEqual([]);
  });

  it("按用户输入执行模式恢复注册工具，并校验完整字段定义", () => {
    const definition = defaultToolCatalog.find((tool) => tool.id === "user.request_input")!;
    const tools = [{ ...definition, id: "custom.ask" }];
    const current = task({ plan: [inputStep({ command: `opsark-tool custom.ask ${JSON.stringify(inputArguments)}` })] });
    expect(restoreUserInputRequests([current], tools, () => "restored")).toHaveLength(1);
    current.plan[0].command = `opsark-tool custom.ask ${JSON.stringify({
      ...inputArguments,
      fields: [{ ...inputArguments.fields[0], description: "" }],
    })}`;
    expect(restoreUserInputRequests([current], tools, () => "restored")).toEqual([]);
  });

  it("只恢复敏感字段定义，不读取或带回已填写值及密钥绑定", () => {
    const current = task({ plan: [inputStep({ command: `opsark-tool user.request_input ${JSON.stringify({
      title: "确认访问参数",
      fields: [{ key: "API_TOKEN", label: "令牌", description: "访问用户指定服务", type: "password", required: true }],
    })}` })] });
    Object.defineProperties(current, {
      submittedInputs: { get() { throw new Error("不得读取用户输入值"); } },
      submittedSecretBindings: { get() { throw new Error("不得读取密钥绑定"); } },
    });
    const restored = restoreUserInputRequests([current], defaultToolCatalog, () => "restored");
    expect(restored).toHaveLength(1);
    expect(restored[0].fields[0]).toEqual({
      key: "API_TOKEN", label: "令牌", description: "访问用户指定服务", type: "password", required: true,
    });
    expect(restored[0]).not.toHaveProperty("values");
    expect(restored[0]).not.toHaveProperty("submittedInputs");
    expect(restored[0]).not.toHaveProperty("submittedSecretBindings");
    expect(restored[0].fields[0]).not.toHaveProperty("value");
  });
});
