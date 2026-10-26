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
  const settle = async () => { await nextTick(); await nextTick(); };
  async function mountDeletionFixture() {
    const pinia = createPinia(), store = useOpsStore(pinia);
    store.servers = ["a", "b"].map(suffix => ({
      id: `server-${suffix}`, name: suffix === "a" ? "Alpha" : "Beta", host: `10.0.0.${suffix === "a" ? 1 : 2}`,
      port: 22, username: "root", group: "test", status: "online" as const, environment: [],
      info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" },
      createdAt: new Date().toISOString(),
    }));
    store.secretMetadata = [
      { key: "API_TOKEN", description: "甲服务器", scope: "server", serverId: "server-a" },
      { key: "API_TOKEN", description: "乙服务器", scope: "server", serverId: "server-b" },
    ];
    const tabs = useServerWorkspaceTabsStore(pinia); tabs.open("server-a");
    const app = createApp(SecretManagementView).use(pinia).use(i18n); app.mount(host); await settle();
    host.querySelector<HTMLButtonElement>(".secret-list-row")!.click(); await settle();
    return { app, store, tabs };
  }

  beforeEach(() => {
    localStorage.clear();
    i18n.global.locale.value = "zh-CN";
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

    expect(host.querySelector(".secret-server-picker summary")?.textContent).toContain("Beta · 10.0.0.2 · 1");
    expect(host.querySelector(".secret-row-copy strong")?.textContent).toBe("GIT_HTTP_CREDENTIAL");
    expect(host.textContent).toContain("敏感信息按服务器隔离保存在本地加密凭据库");
    expect(host.textContent).toContain("主密钥由系统凭据库保护");
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

    expect(host.querySelectorAll(".secret-list-row")).toHaveLength(2);
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
    const select = host.querySelector<HTMLElement>(".secret-server-picker summary")!;

    workspaceTabs.open("server-b");
    await nextTick();
    expect(select.textContent).toContain("Beta · 10.0.0.2");

    select.click();
    await nextTick();
    document.querySelector<HTMLButtonElement>('.parameter-options [data-value="server-a"]')!.click();
    await nextTick();
    workspaceTabs.open("server-a");
    await nextTick();
    workspaceTabs.open("server-b");
    await nextTick();

    expect(select.textContent).toContain("Alpha · 10.0.0.1");
    app.unmount();
  });

  it("删除敏感信息前要求二次确认", async () => {
    const pinia = createPinia();
    const store = useOpsStore(pinia);
    const createdAt = new Date().toISOString();
    store.servers = [{
      id: "server-a", name: "Alpha", host: "10.0.0.1", port: 22, username: "root", group: "test", status: "online", environment: [],
      info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" }, createdAt,
    }];
    store.secretMetadata = [{ key: "API_TOKEN", description: "测试令牌", scope: "server", serverId: "server-a" }];
    vi.spyOn(backend, "deleteCredential").mockResolvedValue(undefined);

    const app = createApp(SecretManagementView);
    app.use(pinia).use(i18n).mount(host);
    await nextTick();
    host.querySelector<HTMLButtonElement>(".secret-list-row")!.click();
    await nextTick();
    document.querySelector<HTMLButtonElement>(".secret-drawer-footer .button.danger")!.click();
    await nextTick();

    expect(document.querySelector("[role='alertdialog']")?.textContent).toContain("将删除此敏感变量");
    expect(store.secretMetadata).toHaveLength(1);
    document.querySelector<HTMLButtonElement>(".action-confirmation .button.secondary")!.click();
    await nextTick();
    expect(store.secretMetadata).toHaveLength(1);

    document.querySelector<HTMLButtonElement>(".secret-drawer-footer .button.danger")!.click();
    await nextTick();
    document.querySelector<HTMLButtonElement>(".action-confirmation .button.primary")!.click();
    await vi.waitFor(() => expect(store.secretMetadata).toHaveLength(0));
    app.unmount();
  });

  it("编辑器在确认前关闭也只删除捕获的原服务器对象", async () => {
    const { app, store } = await mountDeletionFixture();
    const remove = vi.spyOn(store, "removeSecretMetadata").mockResolvedValue();
    try {
      document.querySelector<HTMLButtonElement>(".secret-drawer-footer .danger")!.click(); await settle();
      const editor = document.querySelector<HTMLDialogElement>(".secret-drawer")!;
      editor.close(); editor.dispatchEvent(new Event("close")); await settle();
      expect(document.querySelector(".secret-drawer-header h2")!.textContent).not.toBe("API_TOKEN");
      const confirm = document.querySelector<HTMLButtonElement>(".action-confirmation .primary")!;
      confirm.click(); confirm.click(); await settle();
      expect(remove).toHaveBeenCalledExactlyOnceWith("API_TOKEN", "server-a");
      expect(editor.open).toBe(false);
    } finally { app.unmount(); }
  });

  it("旧删除异步返回不关闭后来打开的另一服务器编辑器", async () => {
    const { app, store, tabs } = await mountDeletionFixture();
    let complete!: () => void;
    const remove = vi.spyOn(store, "removeSecretMetadata").mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    try {
      document.querySelector<HTMLButtonElement>(".secret-drawer-footer .danger")!.click(); await settle();
      document.querySelector<HTMLButtonElement>(".action-confirmation .primary")!.click(); await settle();
      expect(remove).toHaveBeenCalledExactlyOnceWith("API_TOKEN", "server-a");
      const editor = document.querySelector<HTMLDialogElement>(".secret-drawer")!;
      editor.close(); editor.dispatchEvent(new Event("close"));
      tabs.open("server-b"); await settle();
      host.querySelector<HTMLButtonElement>(".secret-list-row")!.click(); await settle();
      complete(); await settle();
      expect(editor.open).toBe(true);
      expect(editor.querySelector(".secret-server-context")!.textContent).toBe("Beta");
      expect(editor.querySelector<HTMLInputElement>("input")!.value).toBe("API_TOKEN");
      expect(host.querySelector(".secrets-notice")).toBeNull();
      expect(remove).toHaveBeenCalledTimes(1);
    } finally { app.unmount(); }
  });

  it("确认期间目标被替换或凭据组范围扩大时不执行删除", async () => {
    const { app, store } = await mountDeletionFixture();
    const remove = vi.spyOn(store, "removeSecretMetadata").mockResolvedValue();
    try {
      document.querySelector<HTMLButtonElement>(".secret-drawer-footer .danger")!.click(); await settle();
      store.secretMetadata[0] = { ...store.secretMetadata[0] };
      document.querySelector<HTMLButtonElement>(".action-confirmation .primary")!.click(); await settle();
      expect(remove).not.toHaveBeenCalled();
      expect(document.querySelector(".secret-drawer [role='alert']")).not.toBeNull();
      document.querySelector<HTMLDialogElement>(".secret-drawer")!.close();
      document.querySelector<HTMLDialogElement>(".secret-drawer")!.dispatchEvent(new Event("close")); await settle();
      store.secretMetadata[0].credentialGroupId = "group-one";
      host.querySelector<HTMLButtonElement>(".secret-list-row")!.click(); await settle();
      document.querySelector<HTMLButtonElement>(".secret-drawer-footer .danger")!.click(); await settle();
      store.secretMetadata.push({ key: "NEW_MEMBER", description: "新增", scope: "server", serverId: "server-a", credentialGroupId: "group-one" });
      document.querySelector<HTMLButtonElement>(".action-confirmation .primary")!.click(); await settle();
      expect(remove).not.toHaveBeenCalled();
    } finally { app.unmount(); }
  });
});
