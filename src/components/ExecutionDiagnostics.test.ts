// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { useOpsStore } from "@/stores/ops";
import { i18n } from "@/features/preferences/i18n";
import ExecutionDiagnostics from "./ExecutionDiagnostics.vue";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it("opens diagnostics on demand, deduplicates task receipts and preserves recovery actions", async () => {
  const pinia = createPinia(), store = useOpsStore(pinia);
  const task = store.createTask("server", "safe", "model");
  task.title = "部署项目";
  task.executionLedgerRecovery = { version: "execution-ledger-recovery@1", items: [
    { kind: "uncertain", operationId: "operation-a", attemptId: "attempt-a", summary: "当前任务结果未知", knownFacts: [], action: "reconcile" },
  ] };
  store.executionRecoveryCases = [{ taskId: task.id, title: "旧副本", targets: [], recovery: {
    version: "execution-ledger-recovery@1", items: [
      { ...task.executionLedgerRecovery.items[0], summary: "重复的历史副本" },
      { kind: "recorded_result", operationId: "operation-old", attemptId: "attempt-old", summary: "已处理的历史回执", knownFacts: [], action: "verify" },
    ], error: "已解决的旧错误", busyAttemptId: "attempt-old",
  } }, { taskId: "archived-task", title: "历史任务", targets: [], recovery: {
    version: "execution-ledger-recovery@1", items: [
      { kind: "storage_failed", operationId: "operation-b", attemptId: "attempt-b", summary: "落盘失败", knownFacts: [], action: "retry_storage" },
    ],
  } }];
  store.executionLedgerReadError = "台账读取失败";
  const restore = vi.spyOn(store, "restoreExecutionLedgerTasks").mockResolvedValue();
  const reconcile = vi.spyOn(store, "reconcileExecutionAttempt").mockResolvedValue();
  const save = vi.spyOn(store, "retryExecutionLedgerStorage").mockResolvedValue();
  const host = document.createElement("div"); document.body.append(host);
  const app = createApp(ExecutionDiagnostics).use(pinia).use(i18n); app.mount(host);
  try {
    await nextTick();
    expect(host.querySelector(".execution-ledger-recovery")).toBeNull();
    expect(restore).not.toHaveBeenCalled();
    const details = host.querySelector("details")!;
    details.open = true; details.dispatchEvent(new Event("toggle"));
    await nextTick(); await nextTick();
    expect(restore).toHaveBeenCalled();
    expect(host.querySelectorAll("[data-diagnostic-task]")).toHaveLength(2);
    expect(host.querySelectorAll(".ledger-recovery-item")).toHaveLength(2);
    expect(host.textContent).not.toContain("重复的历史副本");
    expect(host.textContent).not.toContain("已处理的历史回执");
    expect(host.textContent).not.toContain("已解决的旧错误");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("台账读取失败");
    host.querySelector<HTMLButtonElement>('[data-ledger-action="reconcile"]')!.click();
    host.querySelector<HTMLButtonElement>('[data-ledger-action="retry_storage"]')!.click();
    await nextTick();
    expect(reconcile).toHaveBeenCalledWith(task.id, "attempt-a");
    expect(save).toHaveBeenCalledWith("archived-task", "attempt-b");
    expect(task.executionLedgerRecovery.items[0].kind).toBe("uncertain");
  } finally { app.unmount(); host.remove(); }
});

it("keeps recovery available until the task loads its projection, then honors resolution without reviving stale records", async () => {
  const pinia = createPinia(), store = useOpsStore(pinia);
  const task = store.createTask("server", "safe", "model");
  const historical = { version: "execution-ledger-recovery@1" as const, items: [
    { kind: "uncertain" as const, operationId: "op-old", attemptId: "attempt-old",
      summary: "历史派发尚未核对", knownFacts: [], action: "reconcile" as const },
  ] };
  store.executionRecoveryCases = [{ taskId: task.id, title: "原任务", targets: [], recovery: historical }];
  vi.spyOn(store, "restoreExecutionLedgerTasks").mockResolvedValue();
  const reconcile = vi.spyOn(store, "reconcileExecutionAttempt").mockResolvedValue();
  const host = document.createElement("div");
  const app = createApp(ExecutionDiagnostics).use(pinia).use(i18n); app.mount(host);
  try {
    const details = host.querySelector("details")!;
    details.open = true; details.dispatchEvent(new Event("toggle"));
    await nextTick(); await nextTick();
    expect(host.textContent).toContain("历史派发尚未核对");
    task.executionLedgerRecovery = { version: historical.version, items: [] };
    await nextTick();
    expect(host.querySelectorAll("[data-diagnostic-task]")).toHaveLength(0);
    expect(host.textContent).toContain("暂无需要核对的执行异常");
    // A diagnostic refresh cannot turn the stale queue into current task work.
    host.querySelector<HTMLButtonElement>("button")!.click();
    await nextTick(); await nextTick();
    expect(host.textContent).not.toContain("历史派发尚未核对");
    expect(reconcile).not.toHaveBeenCalled();
    expect(store.executionRecoveryCases[0].recovery.items).toHaveLength(1);
  } finally { app.unmount(); }
});
