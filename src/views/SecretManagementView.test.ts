// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { backend } from "@/services/backend";
import { i18n } from "@/features/preferences/i18n";
import { useOpsStore } from "@/stores/ops";
import { useServerWorkspaceTabsStore } from "@/features/workspace/serverWorkspaceTabsStore";
import SecretManagementView from "./SecretManagementView.vue";

describe("SecretManagementView", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    vi.spyOn(backend, "loadCredential").mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    host.remove();
  });

  it("默认选中最近活动服务器，不会因固定选中第一台而误报无数据", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    const createdAt = new Date().toISOString();
    store.servers = [
      { id: "server-a", name: "Alpha", host: "10.0.0.1", port: 22, username: "root", group: "test", status: "offline", environment: [], info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" }, createdAt },
      { id: "server-b", name: "Beta", host: "10.0.0.2", port: 22, username: "root", group: "test", status: "online", environment: [], info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" }, createdAt },
    ];
    store.secretMetadata = [{
      key: "GIT_HTTP_CREDENTIAL",
      description: "用于认证 gitee.com 私有 Git 仓库的密码或访问令牌",
      scope: "server",
      serverId: "server-b",
    }];
    const workspaceTabs = useServerWorkspaceTabsStore(pinia);
    workspaceTabs.open("server-b");

    const app = createApp(SecretManagementView);
    app.use(pinia).use(i18n).mount(host);
    await nextTick();

    expect(host.querySelector<HTMLSelectElement>(".secret-server-picker select")?.value).toBe("server-b");
    expect(host.querySelector<HTMLInputElement>(".secret-editor-row input")?.value).toBe("GIT_HTTP_CREDENTIAL");
    expect(host.textContent).toContain("Beta · 10.0.0.2 · 1");
    expect(host.querySelector(".secret-empty-state")).toBeNull();

    app.unmount();
  });

  it("将服务器级用户名和令牌显示为同一凭据组的两项敏感信息", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    const createdAt = new Date().toISOString();
    store.servers = [{
      id: "server-a", name: "Alpha", host: "10.0.0.1", port: 22, username: "root", group: "test", status: "online", environment: [],
      info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" }, createdAt,
    }];
    const common = {
      scope: "server" as const,
      serverId: "server-a",
      credentialGroupId: "gitee-main",
      credentialKind: "git-https" as const,
      credentialTarget: "gitee.com",
      credentialLabel: "Gitee HTTPS 凭据",
    };
    store.secretMetadata = [{
      ...common, key: "GIT_USERNAME", description: "Gitee 用户名", credentialRole: "username",
    }, {
      ...common, key: "GIT_HTTP_CREDENTIAL", description: "Gitee 访问令牌", credentialRole: "secret",
    }];

    const app = createApp(SecretManagementView);
    app.use(pinia).use(i18n).mount(host);
    await nextTick();

    expect(host.querySelectorAll(".secret-editor-row")).toHaveLength(2);
    expect(host.textContent).toContain("Alpha · 10.0.0.1 · 2");
    expect(host.textContent).toContain("Gitee HTTPS 凭据 · gitee.com · 用户名字段");
    expect(host.textContent).toContain("Gitee HTTPS 凭据 · gitee.com · 密码/令牌字段");
    app.unmount();
  });

  it("跟随工作台服务器切换，但不覆盖用户手动选择", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    const createdAt = new Date().toISOString();
    store.servers = [
      { id: "server-a", name: "Alpha", host: "10.0.0.1", port: 22, username: "root", group: "test", status: "offline", environment: [], info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" }, createdAt },
      { id: "server-b", name: "Beta", host: "10.0.0.2", port: 22, username: "root", group: "test", status: "online", environment: [], info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" }, createdAt },
    ];
    const workspaceTabs = useServerWorkspaceTabsStore(pinia);
    workspaceTabs.open("server-a");
    const app = createApp(SecretManagementView);
    app.use(pinia).use(i18n).mount(host);
    await nextTick();
    const select = host.querySelector<HTMLSelectElement>(".secret-server-picker select")!;

    workspaceTabs.open("server-b");
    await nextTick();
    expect(select.value).toBe("server-b");

    select.value = "server-a";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    workspaceTabs.open("server-a");
    await nextTick();
    workspaceTabs.open("server-b");
    await nextTick();

    expect(select.value).toBe("server-a");
    app.unmount();
  });
});
