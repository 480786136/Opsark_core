// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useFileWorkspaceStore } from "@/features/files/fileWorkspaceStore";
import { useWorkspaceLinkStore } from "@/features/workspace/workspaceLinkStore";
import { useOpsStore } from "@/stores/ops";
import { backend } from "@/services/backend";
import FileExplorer from "./FileExplorer.vue";

describe("FileExplorer", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    host.remove();
  });

  it("仅保留统一文件列表并移除无效视图切换", () => {
    const pinia = createPinia();
    const app = createApp(FileExplorer, { serverId: "server-a" });
    app.use(pinia);
    app.use(i18n);
    app.mount(host);

    expect(host.querySelector('button[title="列表视图"]')).toBeNull();
    expect(host.querySelector('button[title="紧凑视图"]')).toBeNull();
    expect(host.querySelector(".file-list")?.className).toBe("file-list");
    app.unmount();
  });

  it("将当前目录发送到活动终端并消费终端返回的 SFTP 路径", async () => {
    vi.spyOn(backend, "listSftp").mockResolvedValue([]);
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.servers.push({
      id: "server-a",
      name: "Test",
      host: "127.0.0.1",
      port: 22,
      username: "ops",
      group: "test",
      status: "online",
      environment: [],
      info: { os: "Linux", kernel: "6", cpu: "CPU", cores: 1, memoryGb: 1, diskGb: 1, uptime: "1h" },
      createdAt: new Date().toISOString(),
    });
    ops.serverPasswords["server-a"] = "secret";
    ops.serverConnection("server-a").status = "connected";
    vi.spyOn(ops, "getRuntimeConnection").mockReturnValue({ host: "127.0.0.1", port: 22, username: "ops", password: "secret" });
    const app = createApp(FileExplorer, { serverId: "server-a" });
    app.use(pinia).use(i18n).mount(host);
    const links = useWorkspaceLinkStore(pinia);

    host.querySelector<HTMLButtonElement>('button[title="在活动终端中打开当前目录"]')?.click();
    expect(links.terminalPathRequests["server-a"]?.path).toBe("/");
    links.requestSftpPath("server-a", "/var/log");
    await nextTick();
    await Promise.resolve();
    await nextTick();

    expect(useFileWorkspaceStore(pinia).serverWorkspaces["server-a"].currentPath).toBe("/var/log");
    await vi.waitFor(() => expect(links.sftpPathRequests["server-a"]).toBeUndefined());
    app.unmount();
  });

  it("首次离线不显示伪空目录或派发读取；缓存须明确打开且不可编辑", async () => {
    const list = vi.spyOn(backend, "listSftp").mockResolvedValue([]);
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    const files = useFileWorkspaceStore(pinia);
    const app = createApp(FileExplorer, { serverId: "server-a" });
    app.use(pinia).use(i18n).mount(host);
    expect(host.textContent).not.toContain("目录为空");
    expect(list).not.toHaveBeenCalled();
    const state = files.ensureServer("server-a");
    state.files = [{ name: "cached.txt", path: "/cached.txt", kind: "file", size: "1 B", modified: "now" }];
    state.lastSuccessAt = new Date().toISOString();
    await nextTick();
    expect(host.textContent).not.toContain("cached.txt");
    [...host.querySelectorAll("button")].find((button) => button.textContent === "查看离线缓存")?.click();
    await nextTick();
    expect(host.textContent).toContain("cached.txt");
    expect(host.textContent).toContain("离线缓存／非实时");
    expect(host.textContent).toContain(new Date(state.lastSuccessAt).toLocaleString());
    expect(host.textContent).not.toContain(state.lastSuccessAt);
    expect(host.querySelector<HTMLButtonElement>('button[title="上传文件"]')?.disabled).toBe(true);
    expect(ops.isServerConnected("server-a")).toBe(false);
    expect(list).not.toHaveBeenCalled();
    app.unmount();
  });

  it("断线关闭已打开的写入确认框，恢复后刷新当前路径", async () => {
    const list = vi.spyOn(backend, "listSftp").mockResolvedValue([]);
    const create = vi.spyOn(backend, "createSftpDirectory").mockResolvedValue(undefined);
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.serverConnection("server-a").status = "connected";
    vi.spyOn(ops, "getRuntimeConnection").mockImplementation(() => ops.isServerConnected("server-a")
      ? { host: "localhost", port: 22, username: "ops", password: "secret" } : undefined);
    const app = createApp(FileExplorer, { serverId: "server-a" });
    app.use(pinia).use(i18n).mount(host);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    host.querySelector<HTMLButtonElement>(`button[title="${i18n.global.t('files.newFolder')}"]`)?.click();
    await nextTick();
    expect(host.querySelector(".file-dialog")).not.toBeNull();
    ops.serverConnection("server-a").status = "suspect";
    await nextTick();
    expect(host.textContent).toContain("连接待确认");
    expect(host.querySelector(".file-directory-state")?.textContent).not.toContain("离线缓存／非实时");
    expect(host.querySelector(".file-dialog")).toBeNull();
    expect(create).not.toHaveBeenCalled();
    ops.serverConnection("server-a").status = "connected";
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    app.unmount();
  });
});
