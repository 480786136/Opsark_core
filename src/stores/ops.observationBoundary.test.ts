import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { normalizeOperationsRequest } from "@/features/tools/operationsInspection";
import { resetExecutionLedgerForTests } from "@/services/executionLedger";
import type { PlanStep, ServerProfile } from "@/types";
import { useOpsStore } from "./ops";

const server: ServerProfile = { id: "server", host: "fixture.invalid", port: 22, username: "fixture", name: "test",
  group: "test", status: "offline", environment: [], createdAt: "2026-10-02T00:00:00Z",
  info: { os: "test", kernel: "test", cpu: "test", cores: 1, memoryGb: 1, diskGb: 1, uptime: "test" } };
const inspect = (id = "ports"): PlanStep => ({ id, title: "确认 8080 端口当前未被占用", description: "占用时需要根据结果调整",
  kind: "observe", action: { type: "tool", toolId: "services.inspect", arguments: { check: "ports" } },
  command: "", validation: "", expected: "返回当前监听端口清单，明确 8080 是否已被占用", risk: "low", status: "pending" });
const deploy = (): PlanStep => ({ id: "deploy", title: "启动站点", description: "托管静态站点", kind: "change",
  command: "systemctl start core-case-static.service", action: { type: "shell", command: "systemctl start core-case-static.service" },
  validation: "systemctl is-active core-case-static.service", expected: "active", risk: "medium", status: "pending" });

describe("real observations before store change dispatch", () => {
  beforeEach(async () => {
    vi.restoreAllMocks(); resetExecutionLedgerForTests(); localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); setActivePinia(createPinia());
    const store = useOpsStore(); store.servers = [structuredClone(server)];
    store.models = [{ id: "model", name: "test", provider: "Test", model: "test", endpoint: "https://fixture.invalid", enabled: true, hasApiKey: true }];
    store.modelApiKeys.model = "fixture";
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "saveCredential").mockResolvedValue();
    vi.spyOn(backend, "checkSshConnection").mockResolvedValue();
    vi.spyOn(backend, "configureTaskCapabilities").mockResolvedValue();
    vi.spyOn(backend, "validateStep").mockResolvedValue({ passed: true, detail: "fixture" });
    vi.spyOn(backend, "reviewStep").mockResolvedValue({ decision: "continue", reason: "fixture", summary: "fixture", source: "model" });
    await useConnectionStore().connect(server.id, { host: server.host, port: server.port, username: server.username, password: "fixture" });
  });
  afterEach(() => {
    const store = useOpsStore();
    for (const task of store.tasks) task.cancelRequested = true;
    store.stopConnectionMonitor(); store.persist(true); store.$dispose();
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  });

  function setup() {
    const store = useOpsStore();
    const task = store.createTask(server.id, "managed", "model");
    task.rootGoal = "部署静态站点"; task.currentRoundId = "round"; task.status = "running";
    task.executionConstraints = { changePolicy: "requested_changes_only", environmentPolicy: "unspecified", failurePolicy: "unspecified",
      prohibitedActions: [], requiredConditions: [], userDirectives: [] };
    task.plan = [inspect(), deploy()];
    const data = { request: normalizeOperationsRequest("services.inspect", { check: "ports" }), status: "complete",
      items: [{ kind: "ports", subject: "server:listening",
        text: 'tcp LISTEN 0 5 0.0.0.0:8080 0.0.0.0:* users:(("python3",pid=68474,fd=3))', exitCode: 0 }],
      scannedEntries: 0, matchedEntries: 1, skippedCount: 0, skipped: [], coverageComplete: true, truncated: false,
      elapsedMs: 22, finishedAt: new Date().toISOString() };
    const stdout = `OPSARK_RESULT ${JSON.stringify(data)}\n`;
    const execute = vi.spyOn(backend, "executeCommand").mockResolvedValue({ success: true, simulated: true, exitCode: 0,
      output: stdout, stdout, stderr: "", stdoutTruncated: false });
    const adjustment = vi.spyOn(store, "beginAdjustment").mockResolvedValue();
    return { store, task, execute, adjustment };
  }

  it("keeps the occupied-port receipt and requests one decision instead of starting the preplanned service", async () => {
    const { store, task, execute, adjustment } = setup();
    await store.runStep(task.id, "ports");
    expect(task.plan[0].status).toBe("completed");
    expect(task.plan[0].output).toContain("68474");
    expect(task.plan[0].evidence?.[0].scope?.targetId).toBe(server.id);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls.some(([command]) => command === deploy().command)).toBe(false);
    expect(task.plan[1].status).toBe("pending");
    expect(adjustment).toHaveBeenCalledOnce();
    expect(task.status).toBe("needs_adjustment");
  });

  it("also blocks direct dispatch of the queued write after restoring the observed plan", async () => {
    const { store, task, execute, adjustment } = setup();
    const advance = vi.spyOn(store, "advanceTask").mockResolvedValue();
    await store.runStep(task.id, "ports");
    expect(execute).toHaveBeenCalledOnce();
    advance.mockRestore();
    task.status = "running";
    await store.runStep(task.id, "deploy");
    expect(execute).toHaveBeenCalledOnce();
    expect(task.plan[1].status).toBe("pending");
    expect(adjustment).toHaveBeenCalledOnce();
  });

  it("does not interrupt an independent read batch for per-tool model reviews", async () => {
    const { store, task, execute, adjustment } = setup();
    task.plan = [inspect(), inspect("more-ports")];
    const decide = vi.spyOn(backend, "decideNextStage").mockResolvedValue({ decision: "complete", reason: "观察完成", summary: "已记录端口",
      source: "model", steps: [] });
    await store.runStep(task.id, "ports");
    expect(task.plan.map(step => step.status)).toEqual(["completed", "completed"]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(adjustment).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledOnce();
  });

  it("also blocks a direct change-tool dispatch after a real observation", async () => {
    const { store, task, execute, adjustment } = setup();
    store.servers.push({ ...structuredClone(server), id: "destination", name: "destination", host: "destination.invalid" });
    task.rootGoal = "检查当前服务器并将 /app/dist.tar 传输到 destination 的 /srv/dist.tar";
    task.plan[1] = { ...deploy(), id: "transfer", title: "传输构建产物", command: "", validation: "",
      action: { type: "tool", toolId: "files.transfer_between_servers", arguments: {
        sourcePath: "/app/dist.tar", targetServer: "destination", targetPath: "/srv/dist.tar", overwrite: false,
      } } };
    const advance = vi.spyOn(store, "advanceTask").mockResolvedValue();
    await store.runStep(task.id, "ports");
    expect(task.plan[0].status, task.pauseReason).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
    advance.mockRestore();
    const tool = vi.spyOn(store, "executeToolCall");
    const action = task.plan[1].action;
    if (action?.type !== "tool") throw new Error("fixture requires tool action");
    await store.runToolStep(task.id, "transfer", { id: "direct-transfer", toolId: action.toolId, arguments: action.arguments });
    expect(tool).not.toHaveBeenCalled();
    expect(task.plan[1].status).toBe("pending");
    expect(adjustment).toHaveBeenCalledOnce();
    expect(task.status).toBe("needs_adjustment");
  });
});
