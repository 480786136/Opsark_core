// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { backend } from "@/services/backend";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import DashboardView from "./DashboardView.vue";

describe("DashboardView", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    i18n.global.locale.value = "zh-CN";
    host = document.createElement("div");
    document.body.append(host);
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
    vi.spyOn(backend, "deleteCredential").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll(".action-confirmation-overlay").forEach((element) => element.remove());
    host.remove();
  });

  it("shows orphaned execution recovery without requiring a server entry and routes read-only/storage actions", async () => {
    const pinia = createPinia(), store = useOpsStore(pinia);
    store.servers = [];
    const task = store.createTask("unlinked-server", "observe", "");
    task.title = "执行记录恢复 · missing.example:2222";
    task.executionLedgerRecovery = { version: "execution-ledger-recovery@1", items: [
      { kind: "uncertain", operationId: "original-operation", attemptId: "original-attempt", summary: "原目标结果待核对", knownFacts: ["已登记派发"], action: "reconcile" },
      { kind: "storage_failed", operationId: "pending-operation", attemptId: "pending-attempt", summary: "结果已返回，记录待保存", knownFacts: [], action: "retry_storage" },
    ] };
    const restore = vi.spyOn(store, "restoreExecutionLedgerTasks").mockResolvedValue();
    const reconcile = vi.spyOn(store, "reconcileExecutionAttempt").mockResolvedValue();
    const save = vi.spyOn(store, "retryExecutionLedgerStorage").mockResolvedValue();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: DashboardView }] });
    await router.push("/"); await router.isReady();
    const app = createApp(DashboardView).use(pinia).use(i18n).use(router);
    app.mount(host);
    try {
      await nextTick();
      expect(restore).toHaveBeenCalledOnce();
      expect(host.textContent).toContain("missing.example:2222");
      expect(host.textContent).toContain("1 个任务需要处理");
      const details = host.querySelector<HTMLDetailsElement>(".dashboard-recovery-details")!;
      expect(details.open).toBe(false);
      details.open = true;
      expect(host.textContent).toContain("original-attempt");
      host.querySelector<HTMLButtonElement>('[data-ledger-action="reconcile"]')!.click();
      host.querySelector<HTMLButtonElement>('[data-ledger-action="retry_storage"]')!.click();
      await nextTick();
      expect(reconcile).toHaveBeenCalledWith(task.id, "original-attempt");
      expect(save).toHaveBeenCalledWith(task.id, "pending-attempt");
    } finally { app.unmount(); }
  });

  it("displays task projection and durable ledger read failures when there are no readable tasks", async () => {
    const pinia = createPinia(), store = useOpsStore(pinia);
    store.servers = []; store.tasks = [];
    store.taskCacheReadError = "任务缓存版本无法识别，原始记录已保留。";
    store.executionLedgerReadError = "执行台账暂时不可读，变更派发已暂停。";
    vi.spyOn(store, "restoreExecutionLedgerTasks").mockResolvedValue();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: DashboardView }] });
    await router.push("/"); await router.isReady();
    const app = createApp(DashboardView).use(pinia).use(i18n).use(router);
    app.mount(host);
    try {
      await nextTick();
      const alerts = [...host.querySelectorAll('[role="alert"]')].map(node => node.textContent);
      expect(alerts).toEqual([store.taskCacheReadError, store.executionLedgerReadError]);
      expect(host.querySelector('[data-ledger-action="reconcile"]')).toBeNull();
    } finally { app.unmount(); }
  });

  it("删除服务器前说明影响范围并要求二次确认", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    store.servers = [{
      id: "server-a", name: "生产服务器", host: "10.0.0.1", port: 22, username: "root", group: "production", status: "online", environment: [],
      info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 4, memoryGb: 8, diskGb: 100, uptime: "1h" }, createdAt: new Date().toISOString(),
    }];
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: DashboardView }, { path: "/server/:id", component: { template: "<div/>" } }],
    });
    await router.push("/");
    await router.isReady();
    const app = createApp(DashboardView);
    app.use(pinia).use(i18n).use(router).mount(host);
    await nextTick();

    host.querySelector<HTMLButtonElement>("[aria-label='删除服务器']")!.click();
    await nextTick();
    expect(document.querySelector("[role='alertdialog']")?.textContent).toContain("保存的凭据和本地工作区数据");
    expect(store.servers).toHaveLength(1);
    document.querySelector<HTMLButtonElement>(".action-confirmation .button.secondary")!.click();
    await nextTick();
    expect(store.servers).toHaveLength(1);

    host.querySelector<HTMLButtonElement>("[aria-label='删除服务器']")!.click();
    await nextTick();
    document.querySelector<HTMLButtonElement>(".action-confirmation .button.primary")!.click();
    await nextTick();
    expect(store.servers).toHaveLength(0);
    app.unmount();
  });
});
