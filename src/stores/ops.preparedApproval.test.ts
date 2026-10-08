import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { backend } from "@/services/backend";
import { useOpsStore } from "./ops";
import type { PlanStep, ServerProfile } from "@/types";

const server: ServerProfile = {
  id: "prepared-server", host: "prepared.example.invalid", port: 22, username: "tester",
  name: "审批集成测试", group: "test", status: "offline", environment: [], createdAt: "2026-09-26T00:00:00Z",
  info: { os: "Test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" },
};
const proposal = (): PlanStep => ({ id: "prepared-step", title: "检查状态", description: "读取明确目标的状态",
  action: { type: "shell", command: "printf 'READY\\n'" }, command: "printf 'READY\\n'", validation: "true",
  expected: "READY", kind: "observe", risk: "high", status: "pending", executionScope: "isolated_exec" });

async function waitingApproval() {
  const store = useOpsStore();
  const task = store.createTask(server.id, "safe", "prepared-model");
  task.rootGoal = "检查目标状态";
  task.currentRoundId = `round-${task.id}`;
  task.workflowEpoch = 1;
  task.status = "awaiting_plan_approval";
  task.plan = [proposal()];
  store.pushMessage(task, { role: "user", kind: "message", content: task.rootGoal });
  store.prepareTaskPlan(task);
  await store.approvePlan(task.id);
  expect(task.status).toBe("awaiting_step_approval");
  expect(task.plan[0]!.safetyApprovalSnapshot).toBeDefined();
  expect(backend.executeCommand).not.toHaveBeenCalled();
  return { store, task };
}

describe("J1 current plan approval through the real store", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    setActivePinia(createPinia());
    const store = useOpsStore();
    store.servers = [structuredClone(server)];
    store.models = [{ id: "prepared-model", name: "测试", provider: "Test", model: "test", endpoint: "https://model.example.invalid",
      enabled: true, hasApiKey: true }];
    store.modelApiKeys["prepared-model"] = "fixture-only";
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue(undefined);
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue(undefined);
    vi.spyOn(backend, "executeCommand").mockResolvedValue({ success: true, simulated: true, output: "READY", exitCode: 0 });
    vi.spyOn(backend, "validateStep").mockResolvedValue({ passed: true, detail: "READY" });
    vi.spyOn(backend, "reviewStep").mockResolvedValue({ decision: "continue", reason: "证据一致", summary: "完成", source: "model" });
    vi.spyOn(backend, "decideNextStage").mockResolvedValue({ decision: "complete", reason: "目标已验证", summary: "完成", source: "model", steps: [] });
    vi.spyOn(backend, "reviewGoal").mockResolvedValue({ decision: "complete", reason: "目标已验证", summary: "完成", source: "model" });
    await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: "fixture-only" });
  });
  afterEach(() => {
    useOpsStore().stopConnectionMonitor();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it.each(["expected", "target", "permission", "dependency"] as const)("blocks approval when %s changes during the wait", async field => {
    const { store, task } = await waitingApproval();
    if (field === "expected") task.plan[0]!.expected = "不再要求 READY";
    if (field === "target") store.servers[0]!.username = "another-account";
    if (field === "permission") task.permission = "observe";
    if (field === "dependency") task.plan[0]!.retryAfterStepId = "different-prerequisite";
    await store.approveStep(task.id, "prepared-step");
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.validateStep).not.toHaveBeenCalled();
    expect(task.plan[0]!.approvalGrant).toBeUndefined();
    expect(task.status).toBe("awaiting_plan_approval");
    expect(task.plan[0]!.status).toBe("pending");
    expect(task.planApproval).toBeUndefined();
    expect(() => store.assertPreparedStep(task, task.plan[0]!)).not.toThrow();
    expect(backend.decideNextStage).not.toHaveBeenCalled();
  });

  it("prepares changed approval locally and continues only after approving the new plan and step", async () => {
    const { store, task } = await waitingApproval();
    const originalDigest = task.plan[0]!.executionIntent!.digest;
    task.plan[0]!.expected = "READY 且退出码为 0";
    await store.approveStep(task.id, "prepared-step");
    expect(task.status).toBe("awaiting_plan_approval");
    expect(task.plan[0]!.executionIntent!.digest).not.toBe(originalDigest);
    expect(backend.executeCommand).not.toHaveBeenCalled();
    await store.approvePlan(task.id);
    expect(task.status).toBe("awaiting_step_approval");
    expect(backend.executeCommand).not.toHaveBeenCalled();
    await store.approveStep(task.id, "prepared-step");
    expect(backend.executeCommand).toHaveBeenCalledOnce();
    expect(task.status).toBe("completed");
  });

  it.each([false, true])("releases an invalid waiting approval when preparation fails (restored=%s)", async restored => {
    const { store, task } = await waitingApproval();
    if (restored) task.plan[0]!.executionIntent = undefined;
    task.plan[0]!.action = { type: "tool", toolId: "unavailable-tool", arguments: {} };
    task.plan[0]!.command = "";
    task.plan[0]!.validation = "";
    await store.approveStep(task.id, "prepared-step");
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(task.status).toBe("needs_adjustment");
    expect(task.plan[0]!.status).toBe("pending");
    expect(task.plan[0]!.approvalGrant).toBeUndefined();
    expect(task.planApproval).toBeUndefined();
  });

  it("refreshes a stale displayed snapshot even when preparation normalizes back to the old intent", async () => {
    const { store, task } = await waitingApproval();
    task.plan[0]!.executionScope = "invalid-scope" as PlanStep["executionScope"];
    await store.approveStep(task.id, "prepared-step");
    expect(task.status).toBe("awaiting_plan_approval");
    expect(task.plan[0]!.status).toBe("pending");
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(backend.decideNextStage).not.toHaveBeenCalled();
  });

  it("permits renamed display text with the same prepared execution and accepts exactly once", async () => {
    const { store, task } = await waitingApproval();
    const digest = task.plan[0]!.executionIntent!.digest;
    task.plan[0]!.title = "新的展示名称";
    task.plan[0]!.description = "新的说明排版";
    await Promise.all([store.approveStep(task.id, "prepared-step"), store.approveStep(task.id, "prepared-step")]);
    expect(backend.executeCommand).toHaveBeenCalledOnce();
    expect(task.plan[0]!.approvalGrant?.executionDigest).toBe(digest);
    expect(task.status).toBe("completed");
  });

  it("restored waiting plans are prepared for a fresh decision without silently approving them", async () => {
    const store = useOpsStore();
    const task = store.createTask(server.id, "safe", "prepared-model");
    task.rootGoal = "检查目标状态";
    task.status = "awaiting_step_approval";
    task.plan = [{ ...proposal(), status: "awaiting_approval" }];
    await store.approveStep(task.id, "prepared-step");
    expect(backend.executeCommand).not.toHaveBeenCalled();
    expect(task.plan[0]!.executionIntent).toBeDefined();
    expect(task.plan[0]!.approvalGrant).toBeUndefined();
    expect(task.plan[0]!.safetyApprovalSnapshot).toBeDefined();
  });

  it("binds a protected SSH principal revision without including its value or invalidating password rotation", () => {
    const store = useOpsStore();
    const task = store.createTask(server.id, "safe", "prepared-model");
    task.rootGoal = "连接目标服务器";
    store.secretMetadata = [
      { key: "SSH_USER", description: "账户", scope: "server", serverId: server.id, credentialGroupId: "ssh-pair",
        credentialKind: "ssh-password", credentialRole: "username", credentialTarget: "target.invalid" },
      { key: "SSH_PASS", description: "密码", scope: "server", serverId: server.id, credentialGroupId: "ssh-pair",
        credentialKind: "ssh-password", credentialRole: "secret", credentialTarget: "target.invalid" },
    ];
    store.setServerSecretValue(server.id, "SSH_USER", "protected-principal-A");
    store.setServerSecretValue(server.id, "SSH_PASS", "protected-password-A");
    task.plan = [{ ...proposal(), command: "", validation: "", kind: "change", risk: "medium",
      action: { type: "tool", toolId: "server.connect", arguments: { host: "target.invalid", credentialRef: "server-credential:ssh-pair" } } }];
    const prepared = store.prepareTaskPlan(task);
    expect(JSON.stringify(prepared)).not.toContain("protected-principal-A");
    expect(JSON.stringify(prepared)).not.toContain("protected-password-A");
    store.setServerSecretValue(server.id, "SSH_PASS", "protected-password-B");
    expect(() => store.assertPreparedStep(task, task.plan[0]!)).not.toThrow();
    store.setServerSecretValue(server.id, "SSH_USER", "protected-principal-B");
    expect(() => store.assertPreparedStep(task, task.plan[0]!)).toThrow("已变化");
  });

  it("invalidates prepared authority when a confirmed decision changes without copying its value into the snapshot", () => {
    const store = useOpsStore();
    const task = store.createTask(server.id, "safe", "prepared-model");
    task.plan = [proposal()];
    task.submittedInputs = { DEPLOY_MODE: { value: "private-decision-A", label: "部署方式", description: "选择方式",
      type: "text", groupId: "decision-group", groupTitle: "部署决策", submittedAt: "2026-09-26T00:00:00Z" } };
    const prepared = store.prepareTaskPlan(task);
    expect(JSON.stringify(prepared)).not.toContain("private-decision-A");
    task.submittedInputs.DEPLOY_MODE!.value = "private-decision-B";
    expect(() => store.assertPreparedStep(task, task.plan[0]!)).toThrow("已变化");
  });
});
