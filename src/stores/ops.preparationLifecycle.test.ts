import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { useOpsStore } from "./ops";
import type { OpsTask, PlanStep, ServerProfile } from "@/types";

const source: ServerProfile = { id: "source", name: "source", host: "source.example", port: 22, username: "root",
  group: "test", status: "offline", environment: [], createdAt: "", info: { os: "", kernel: "", cpu: "", cores: 1, memoryGb: 1, diskGb: 1, uptime: "" } };
const call = () => ({ id: "connect-call", toolId: "server.connect",
  arguments: { host: "new.example", port: 2222, username: "deploy", passwordSecretKey: "SSH_PASSWORD" } });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};

function runningTask(): OpsTask {
  const store = useOpsStore();
  const task = store.createTask(source.id, "managed", "model");
  task.rootGoal = "连接到 new.example";
  task.status = "running"; task.workflowEpoch = 1; task.currentRoundId = "round";
  return task;
}

describe("J1 preparation and composite connection lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks(); localStorage.clear(); setActivePinia(createPinia());
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    const store = useOpsStore(); store.servers = [structuredClone(source)];
    store.setServerSecretValue(source.id, "SSH_PASSWORD", "fixture-secret");
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue(undefined);
    vi.spyOn(backend, "saveCredential").mockResolvedValue(undefined);
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "probeSsh").mockResolvedValue({ info: source.info, environment: [], hostname: "test" });
    vi.spyOn(backend, "getSshMetrics").mockResolvedValue({ cpu: 1, memory: 1, disk: 1, networkIn: 0, networkOut: 0, sampledAt: "" });
  });
  afterEach(() => {
    useOpsStore().stopConnectionMonitor(); vi.restoreAllMocks();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("stops after an SSH check resolves for a cancelled task before directory/connect/keychain writes", async () => {
    const store = useOpsStore(); const task = runningTask();
    const checked = deferred<void>();
    vi.mocked(backend.checkSshConnection).mockReturnValueOnce(checked.promise);
    const add = vi.spyOn(store, "addServer");
    const connect = vi.spyOn(store, "connectServer");
    const session = vi.spyOn(store, "ensureTaskAgentSession");
    const pending = store.executeToolCall(source.id, call(), undefined, undefined, task.id);
    expect(backend.checkSshConnection).toHaveBeenCalledOnce();
    store.rejectTask(task.id);
    checked.resolve();
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ dispatchState: "sent", category: "business" });
    expect(result.data).toMatchObject({ connectionChecked: true, directoryUpdated: false, connected: false, taskTargetUpdated: false, credentialStored: false });
    expect(add).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled(); expect(session).not.toHaveBeenCalled();
    expect(backend.saveCredential).not.toHaveBeenCalled();
    expect(task.executionTargetServerId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  it("preserves a completed connection as a partial fact after cancellation and does not switch task/session or save credentials", async () => {
    const store = useOpsStore(); const task = runningTask();
    const connectionCheck = deferred<void>();
    vi.mocked(backend.checkSshConnection).mockResolvedValueOnce(undefined).mockReturnValueOnce(connectionCheck.promise);
    const session = vi.spyOn(store, "ensureTaskAgentSession");
    const pending = store.executeToolCall(source.id, call(), undefined, undefined, task.id);
    await vi.waitFor(() => expect(backend.checkSshConnection).toHaveBeenCalledTimes(2));
    const target = store.servers.find(server => server.host === "new.example")!;
    expect(target).toBeDefined();
    store.rejectTask(task.id);
    connectionCheck.resolve();
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ connectionChecked: true, directoryUpdated: true, connected: true,
      serverId: target.id, taskTargetUpdated: false, agentSessionPrepared: false, credentialStored: false });
    expect(useConnectionStore().connection(target.id)).toMatchObject({ host: "new.example", port: 2222, username: "deploy" });
    expect(task.executionTargetServerId).toBeUndefined(); expect(session).not.toHaveBeenCalled();
    expect(backend.saveCredential).not.toHaveBeenCalled();
    expect(JSON.stringify({ result, logs: store.logs })).not.toContain("fixture-secret");
  });

  it("preserves raw executed steps and archived plans across repeated history loads", () => {
    const task = runningTask();
    const historical: PlanStep = { id: "old", title: "历史原件", description: "历史原件",
      action: { type: "tool", toolId: "files.read_content", arguments: { path: "/srv/README" } }, kind: "observe",
      command: "legacy raw command", validation: "legacy raw validation", validator: { type: "command", command: "legacy validator", validStates: ["matched"] },
      status: "completed", risk: "low", expected: "历史验收", output: "confirmed original result" };
    task.plan = [historical]; task.status = "completed";
    task.planHistory = [{ id: "round-old", requirement: "history", status: "completed", plan: [structuredClone(historical)], createdAt: "", completedAt: "" }];
    const raw = JSON.stringify(historical);
    localStorage.setItem("opsark.tasks", JSON.stringify([task]));
    for (let pass = 0; pass < 2; pass++) {
      setActivePinia(createPinia());
      const loaded = useOpsStore().tasks[0]!;
      expect(JSON.stringify(loaded.plan[0])).toBe(raw);
      expect(JSON.stringify(loaded.planHistory![0]!.plan[0])).toBe(raw);
      expect(loaded.preparedPlan).toBeUndefined();
      localStorage.setItem("opsark.tasks", JSON.stringify([loaded]));
    }
    expect(backend.checkSshConnection).not.toHaveBeenCalled();
  });

  it("keeps direct user tool calls available without creating Agent approval state", async () => {
    const store = useOpsStore();
    const result = await store.executeToolCall(source.id, call());
    expect(result.success).toBe(true);
    const target = store.servers.find(server => server.host === "new.example")!;
    expect(result.data).toMatchObject({ connected: true, serverId: target.id, host: "new.example", port: 2222 });
    expect(backend.saveCredential).toHaveBeenCalledWith("server", target.id, "fixture-secret");
    expect(store.tasks).toHaveLength(0);
  });
});
