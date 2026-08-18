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
    ops.connectedServerIds.push("server-a");
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
});
