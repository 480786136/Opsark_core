import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { useOpsStore } from "./ops";
import type { PlanStep, ServerProfile } from "@/types";

const source: ServerProfile = { id: "source", name: "source", host: "source.example", port: 22, username: "root",
  group: "test", status: "offline", environment: [], createdAt: "", info: { os: "", kernel: "", cpu: "", cores: 1, memoryGb: 1, diskGb: 1, uptime: "" } };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const args = { host: "new.example", port: 2222, username: "deploy", passwordSecretKey: "SSH_PASSWORD" };
function preparedTask() {
  const store = useOpsStore();
  const task = store.createTask(source.id, "managed", "model");
  task.rootGoal = "连接 new.example"; task.status = "running"; task.currentRoundId = "round"; task.workflowEpoch = 1;
  task.plan = [{ id: "connect", title: "连接目标", description: "连接已指定服务器", kind: "change", risk: "medium", status: "pending",
    command: "", validation: "", expected: "连接成功", action: { type: "tool", toolId: "server.connect", arguments: { ...args } } } as PlanStep];
  store.prepareTaskPlan(task);
  return { store, task, step: task.plan[0]! };
}

describe("J1 composite authorization remains current between side effects", () => {
  beforeEach(async () => {
    vi.restoreAllMocks(); localStorage.clear(); setActivePinia(createPinia()); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    const store = useOpsStore(); store.servers = [structuredClone(source)];
    store.setServerSecretValue(source.id, "SSH_PASSWORD", "fixture-secret");
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue(undefined);
    vi.spyOn(backend, "saveCredential").mockResolvedValue(undefined);
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "probeSsh").mockResolvedValue({ info: source.info, environment: [], hostname: "test" });
    vi.spyOn(backend, "getSshMetrics").mockResolvedValue({ cpu: 1, memory: 1, disk: 1, networkIn: 0, networkOut: 0, sampledAt: "" });
    await useConnectionStore().connect(source.id, { host: source.host, port: source.port, username: source.username, password: "source-password" });
    vi.mocked(backend.checkSshConnection).mockClear();
    vi.spyOn(store, "validateRecoveryDispatch").mockResolvedValue(true);
  });
  afterEach(() => { useOpsStore().stopConnectionMonitor(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

  it.each(["action", "permission", "constraints", "target", "directory"] as const)("stops a %s change during the initial SSH check before further effects", async field => {
    const { store, task, step } = preparedTask();
    const checked = deferred<void>();
    vi.mocked(backend.checkSshConnection).mockReturnValueOnce(checked.promise);
    const add = vi.spyOn(store, "addServer"), connect = vi.spyOn(store, "connectServer"), session = vi.spyOn(store, "ensureTaskAgentSession");
    const pending = store.runToolStep(task.id, step.id, { id: "call", toolId: "server.connect", arguments: { ...args } });
    await vi.waitFor(() => expect(backend.checkSshConnection).toHaveBeenCalledOnce());
    if (field === "action" && step.action?.type === "tool") step.action.arguments.host = "different.example";
    if (field === "permission") task.permission = "observe";
    if (field === "constraints") task.executionConstraints = { changePolicy: "read_only", environmentPolicy: "preserve", failurePolicy: "strict", prohibitedActions: [], requiredConditions: [], userDirectives: [] };
    if (field === "target") store.servers[0]!.host = "moved.example";
    if (field === "directory") store.servers.push({ ...source, id: "concurrent", host: "new.example", port: 2222, username: "deploy" });
    checked.resolve(); await pending;
    expect(add).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled(); expect(session).not.toHaveBeenCalled();
    expect(backend.saveCredential).not.toHaveBeenCalled();
    expect(task.executionTargetServerId).toBeUndefined();
    expect(step.result?.facts.partialEffects).toMatchObject({ connectionCheckDispatched: true, connectionChecked: true, directoryUpdated: false });
    expect(JSON.stringify(step.result)).not.toContain("fixture-secret");
  });

  it.each(["action", "confirmed_input", "secret_binding"] as const)("stops %s edits during connection, preserving the completed connection fact", async field => {
    const { store, task, step } = preparedTask();
    const checked = deferred<void>();
    vi.mocked(backend.checkSshConnection).mockResolvedValueOnce(undefined).mockReturnValueOnce(checked.promise);
    const session = vi.spyOn(store, "ensureTaskAgentSession");
    const pending = store.runToolStep(task.id, step.id, { id: "call", toolId: "server.connect", arguments: { ...args } });
    await vi.waitFor(() => expect(backend.checkSshConnection).toHaveBeenCalledTimes(2));
    if (field === "action" && step.action?.type === "tool") step.action.arguments.host = "different.example";
    if (field === "confirmed_input") task.submittedInputs = { DEPLOY_PATH: { type: "text", value: "/new/path", label: "路径", description: "部署路径", groupId: "group", groupTitle: "目录", submittedAt: "now" } };
    if (field === "secret_binding") task.submittedSecretBindings = { SSH_PASSWORD: { key: "SSH_PASSWORD", groupId: "new", label: "密码", description: "连接密码", groupTitle: "连接", submittedAt: "now" } };
    checked.resolve(); await pending;
    expect(step.result?.facts.partialEffects).toMatchObject({ connectionChecked: true, directoryUpdated: true, connected: true, taskTargetUpdated: false });
    expect(task.executionTargetServerId).toBeUndefined(); expect(session).not.toHaveBeenCalled();
    expect(backend.saveCredential).not.toHaveBeenCalled();
  });

  it("records already completed effects when a later ordinary connection failure occurs", async () => {
    const { store, task, step } = preparedTask();
    vi.spyOn(store, "connectServer").mockResolvedValue(false);
    await store.runToolStep(task.id, step.id, { id: "call", toolId: "server.connect", arguments: { ...args } });
    expect(step.result?.facts.partialEffects).toMatchObject({ connectionChecked: true, directoryUpdated: true, connected: false, taskTargetUpdated: false });
    expect(step.result?.facts.errorCode).not.toBe("TOOL_OUTPUT_INVALID");
    expect(backend.saveCredential).not.toHaveBeenCalled();
  });
});
