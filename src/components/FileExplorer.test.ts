// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { i18n } from "@/features/preferences/i18n";
import { useFileWorkspaceStore } from "@/features/files/fileWorkspaceStore";
import { useTransferQueueStore } from "@/features/files/transferQueueStore";
import { useWorkspaceLinkStore } from "@/features/workspace/workspaceLinkStore";
import { useOpsStore } from "@/stores/ops";
import { backend } from "@/services/backend";
import type { FileEntry } from "@/types";
import FileExplorer from "./FileExplorer.vue";

describe("FileExplorer", () => {
  let host: HTMLElement;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    localStorage.clear();
    i18n.global.locale.value = "zh-CN";
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
    host.remove();
  });

  const entries: FileEntry[] = [
    { name: "site", path: "/site", kind: "directory", size: "—", modified: "now" },
    { name: "keep.txt", path: "/keep.txt", kind: "file", size: "1 B", modified: "now" },
  ];
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  }
  async function mountConnected() {
    const pinia = createPinia();
    const ops = useOpsStore(pinia);
    ops.serverConnection("server-a").status = "connected";
    vi.spyOn(ops, "getRuntimeConnection").mockReturnValue({ host: "localhost", port: 22, username: "ops", password: "secret" });
    const app = createApp(FileExplorer, { serverId: "server-a" });
    app.use(pinia).use(i18n).mount(host);
    cleanup = () => { app.unmount(); ops.stopConnectionMonitor(); ops.persist(true); ops.$dispose(); };
    await vi.waitFor(() => expect(host.querySelectorAll(".file-row-wrap")).toHaveLength(entries.length));
    return { ops, pinia };
  }
  async function openDelete(index = 0) {
    host.querySelectorAll(".file-row-wrap")[index].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await nextTick();
    const remove = document.querySelector<HTMLButtonElement>(".file-context-menu .danger");
    expect(remove).not.toBeNull();
    remove!.click();
    await nextTick();
    const form = host.querySelector<HTMLFormElement>(".file-dialog");
    expect(form).not.toBeNull();
    return form!;
  }
  function submit(form: HTMLFormElement) {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  it("递归删除及后续刷新期间持续显示删除中，阻止重复确认和并发文件操作", async () => {
    const deletion = deferred<undefined>(), refresh = deferred<FileEntry[]>();
    const list = vi.spyOn(backend, "listSftp").mockResolvedValueOnce(entries).mockReturnValueOnce(refresh.promise);
    const remove = vi.spyOn(backend, "deleteSftpEntry").mockReturnValue(deletion.promise);
    const { pinia } = await mountConnected();
    const upload = vi.spyOn(useTransferQueueStore(pinia), "enqueueUpload");
    const form = await openDelete();
    expect(remove).not.toHaveBeenCalled();
    expect(form.textContent).toContain("将递归删除其中的所有内容");
    submit(form); submit(form);
    await nextTick();
    const confirm = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(confirm.textContent).toContain("删除中");
    expect(confirm.querySelector("svg.spin")).not.toBeNull();
    expect(confirm.disabled).toBe(true);
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect([...form.querySelectorAll<HTMLButtonElement>("button")].every(button => button.disabled)).toBe(true);
    for (const key of ["files.upload", "files.newFolder", "files.openInTerminal", "common.refresh", "files.download"]) {
      expect(host.querySelector<HTMLButtonElement>(`button[title="${i18n.global.t(key)}"]`)?.disabled, key).toBe(true);
    }
    host.querySelector(".file-dialog-backdrop")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    host.querySelector(".file-row-wrap")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    host.querySelector(".file-row-wrap")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["content"], "new.txt")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    submit(form);
    await nextTick();
    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0].slice(1)).toEqual(["/site", "directory"]);
    expect(list).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.querySelector(".file-context-menu")).toBeNull());
    expect(host.querySelector(".file-dialog")).toBe(form);
    deletion.resolve(undefined);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(confirm.textContent).toContain("删除中");
    expect(confirm.disabled).toBe(true);
    refresh.resolve([entries[1]]);
    await vi.waitFor(() => expect(host.querySelector(".file-dialog")).toBeNull());
    expect(host.querySelector(".file-panel")?.getAttribute("aria-busy")).toBe("false");
    expect(host.querySelector<HTMLButtonElement>(`button[title="${i18n.global.t('files.newFolder')}"]`)?.disabled).toBe(false);
    expect(host.querySelectorAll(".file-row-wrap")).toHaveLength(1);
  });

  it("删除失败保留确认框和错误，清理loading后只在用户再次确认时重试", async () => {
    vi.spyOn(backend, "listSftp").mockResolvedValue(entries);
    const deletion = deferred<undefined>();
    const remove = vi.spyOn(backend, "deleteSftpEntry").mockReturnValueOnce(deletion.promise).mockResolvedValueOnce(undefined);
    await mountConnected();
    const form = await openDelete();
    submit(form);
    deletion.reject(new Error("Permission denied"));
    await vi.waitFor(() => expect(form.querySelector('[role="alert"]')?.textContent).toContain("Permission denied"));
    expect(form.getAttribute("aria-busy")).toBe("false");
    expect(form.querySelector("svg.spin")).toBeNull();
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(remove).toHaveBeenCalledOnce();
    submit(form);
    await vi.waitFor(() => expect(host.querySelector(".file-dialog")).toBeNull());
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("多选仍仅确认删除右键项目，不将单项授权扩成批量删除", async () => {
    vi.spyOn(backend, "listSftp").mockResolvedValue(entries);
    const remove = vi.spyOn(backend, "deleteSftpEntry").mockResolvedValue(undefined);
    await mountConnected();
    const rows = host.querySelectorAll(".file-row-wrap");
    rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    rows[1].dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await nextTick();
    expect(host.querySelectorAll('.file-row-wrap[aria-selected="true"]')).toHaveLength(2);
    const form = await openDelete(1);
    expect(form.textContent).toContain("/keep.txt");
    submit(form);
    await vi.waitFor(() => expect(host.querySelector(".file-dialog")).toBeNull());
    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0].slice(1)).toEqual(["/keep.txt", "file"]);
  });

  it("删除中断线关闭确认框后仍显示进度，迟到错误不会污染重连", async () => {
    vi.spyOn(backend, "listSftp").mockResolvedValue(entries);
    const deletion = deferred<undefined>();
    vi.spyOn(backend, "deleteSftpEntry").mockReturnValue(deletion.promise);
    const { ops } = await mountConnected();
    const report = vi.spyOn(ops, "reportConnectionFailure");
    const form = await openDelete();
    submit(form);
    ops.serverConnection("server-a").status = "suspect";
    await nextTick();
    expect(host.querySelector(".file-dialog")).toBeNull();
    expect(host.querySelector(".file-delete-progress")?.textContent).toContain("删除中… /site");
    ops.serverConnection("server-a").generation += 1;
    ops.serverConnection("server-a").status = "connected";
    await nextTick();
    expect(host.querySelector<HTMLButtonElement>(`button[title="${i18n.global.t('files.newFolder')}"]`)?.disabled).toBe(true);
    deletion.reject(new Error("SSH connection closed"));
    await vi.waitFor(() => expect(host.querySelector(".file-delete-progress")).toBeNull());
    expect(report).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>(`button[title="${i18n.global.t('files.newFolder')}"]`)?.disabled).toBe(false);
  });

  it("删除中暂缓终端发来的目录跳转，完成后继续消费请求", async () => {
    const list = vi.spyOn(backend, "listSftp").mockResolvedValue(entries);
    const deletion = deferred<undefined>();
    vi.spyOn(backend, "deleteSftpEntry").mockReturnValue(deletion.promise);
    const { pinia } = await mountConnected();
    const links = useWorkspaceLinkStore(pinia);
    submit(await openDelete());
    links.requestSftpPath("server-a", "/var/log");
    await nextTick();
    expect(list).toHaveBeenCalledOnce();
    expect(links.sftpPathRequests["server-a"]?.path).toBe("/var/log");
    deletion.resolve(undefined);
    await vi.waitFor(() => expect(links.sftpPathRequests["server-a"]).toBeUndefined());
    expect(useFileWorkspaceStore(pinia).serverWorkspaces["server-a"].currentPath).toBe("/var/log");
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
    expect(host.textContent).toContain(new Date(state.lastSuccessAt).toLocaleString(i18n.global.locale.value));
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
