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
