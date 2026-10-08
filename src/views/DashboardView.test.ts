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

  it("keeps execution recovery internal instead of showing it on the server page", async () => {
    const pinia = createPinia(), store = useOpsStore(pinia);
    store.servers = [];
    const task = { id: "original-task" };
    store.executionRecoveryCases = [{ taskId: task.id, title: "missing.example:2222", targets: [], recovery: { version: "execution-ledger-recovery@1", items: [
      { kind: "uncertain", operationId: "original-operation", attemptId: "original-attempt", summary: "原目标结果待核对", knownFacts: ["已登记派发"], action: "reconcile" },
      { kind: "storage_failed", operationId: "pending-operation", attemptId: "pending-attempt", summary: "结果已返回，记录待保存", knownFacts: [], action: "retry_storage" },
    ] } }];
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
      expect(host.querySelector(".execution-history")).toBeNull();
      expect(host.textContent).not.toContain("历史归档");
      expect(host.textContent).not.toContain("missing.example:2222");
      expect(host.textContent).not.toContain("待处理的执行记录");
      expect(host.querySelector(".dashboard-execution-recovery")).toBeNull();
      expect(host.querySelector(".execution-ledger-recovery")).toBeNull();
      expect(store.executionRecoveryCases).toHaveLength(1);
      expect(reconcile).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    } finally { app.unmount(); }
  });

  it("does not turn the server page into a ledger diagnostic panel", async () => {
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
      expect(alerts).toEqual([]);
      expect(store.executionLedgerReadError).toContain("变更派发已暂停");
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
