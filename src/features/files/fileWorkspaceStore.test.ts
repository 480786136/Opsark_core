// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend, type RuntimeConnection } from "@/services/backend";
import { classifyDirectoryLoadError, useFileWorkspaceStore } from "./fileWorkspaceStore";

const connection: RuntimeConnection = {
  host: "127.0.0.1",
  port: 22,
  username: "ops",
  password: "secret",
};

describe("fileWorkspaceStore", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    setActivePinia(createPinia());
  });

  it("持久化并恢复紧凑视图偏好", () => {
    const store = useFileWorkspaceStore();
    store.hydrate();
    store.setViewMode("compact");
    setActivePinia(createPinia());
    const restored = useFileWorkspaceStore();
    restored.hydrate();
    expect(restored.viewMode).toBe("compact");
  });

  it("持久化每台服务器最后成功的 SFTP 路径", async () => {
    vi.spyOn(backend, "listSftp").mockResolvedValue([]);
    const store = useFileWorkspaceStore();
    store.hydrate();
    await store.loadDirectory("server-a", connection, "/srv/apps");
    await store.loadDirectory("server-b", connection, "/var/log");

    setActivePinia(createPinia());
    const restored = useFileWorkspaceStore();
    restored.hydrate();
    expect(restored.ensureServer("server-a").currentPath).toBe("/srv/apps");
    expect(restored.ensureServer("server-b").currentPath).toBe("/var/log");
  });

  it("将常见目录读取异常归类为稳定错误码", () => {
    expect(classifyDirectoryLoadError("Permission denied", true)).toBe("permission");
    expect(classifyDirectoryLoadError("No such file", true)).toBe("notFound");
    expect(classifyDirectoryLoadError("Connection closed", true)).toBe("disconnected");
    expect(classifyDirectoryLoadError("anything", false)).toBe("disconnected");
  });

  it("按服务器隔离目录路径和文件快照", async () => {
    vi.spyOn(backend, "listSftp").mockImplementation(async (_connection, path) => ([{
      name: path.slice(1),
      path,
      kind: "directory",
      size: "—",
      modified: "now",
    }]));
    const store = useFileWorkspaceStore();

    await store.loadDirectory("server-a", connection, "/apps");
    await store.loadDirectory("server-b", connection, "/logs");

    expect(store.serverWorkspaces["server-a"].currentPath).toBe("/apps");
    expect(store.serverWorkspaces["server-a"].files[0].name).toBe("apps");
    expect(store.serverWorkspaces["server-b"].currentPath).toBe("/logs");
  });

  it("丢弃晚于新导航返回的旧目录响应", async () => {
    let resolveOld: ((files: Awaited<ReturnType<typeof backend.listSftp>>) => void) | undefined;
    let resolveNew: ((files: Awaited<ReturnType<typeof backend.listSftp>>) => void) | undefined;
    vi.spyOn(backend, "listSftp").mockImplementation((_connection, path) => new Promise((resolve) => {
      if (path === "/old") resolveOld = resolve;
      else resolveNew = resolve;
    }));
    const store = useFileWorkspaceStore();
    const oldRequest = store.loadDirectory("server-a", connection, "/old");
    const newRequest = store.loadDirectory("server-a", connection, "/new");
    resolveNew?.([{ name: "new", path: "/new", kind: "directory", size: "—", modified: "now" }]);
    await newRequest;
    resolveOld?.([{ name: "old", path: "/old", kind: "directory", size: "—", modified: "now" }]);

    expect(await oldRequest).toEqual({ ok: false, stale: true });
    expect(store.serverWorkspaces["server-a"].currentPath).toBe("/new");
    expect(store.serverWorkspaces["server-a"].files[0].name).toBe("new");
  });

  it("断线状态使在途目录请求失效", async () => {
    let resolveRequest: ((files: Awaited<ReturnType<typeof backend.listSftp>>) => void) | undefined;
    vi.spyOn(backend, "listSftp").mockImplementation(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    const store = useFileWorkspaceStore();
    const request = store.loadDirectory("server-a", connection, "/apps");
    store.markDirectoryError("server-a", "disconnected", "/apps");
    resolveRequest?.([{ name: "apps", path: "/apps", kind: "directory", size: "—", modified: "now" }]);

    expect(await request).toEqual({ ok: false, stale: true });
    expect(store.serverWorkspaces["server-a"].errorCode).toBe("disconnected");
    expect(store.serverWorkspaces["server-a"].currentPath).toBe("/");
  });

  it("创建、重命名和删除后由文件工作区刷新当前目录", async () => {
    const list = vi.spyOn(backend, "listSftp").mockResolvedValue([]);
    const create = vi.spyOn(backend, "createSftpDirectory").mockResolvedValue(undefined);
    const rename = vi.spyOn(backend, "renameSftpEntry").mockResolvedValue(undefined);
    const remove = vi.spyOn(backend, "deleteSftpEntry").mockResolvedValue(undefined);
    const store = useFileWorkspaceStore();

    const created = await store.createDirectory("server-a", connection, "/apps/new");
    const renamed = await store.renameEntry("server-a", connection, "/apps/old", "/apps/new");
    const deleted = await store.deleteEntry("server-a", connection, {
      name: "old.log",
      path: "/apps/old.log",
      kind: "file",
      size: "1 KB",
      modified: "now",
    });

    expect(create).toHaveBeenCalledWith(connection, "/apps/new");
    expect(rename).toHaveBeenCalledWith(connection, "/apps/old", "/apps/new");
    expect(remove).toHaveBeenCalledWith(connection, "/apps/old.log", "file");
    expect(list).toHaveBeenCalledTimes(3);
    expect(created).toMatchObject({ operation: "createDirectory", refresh: { ok: true }, audit: { titleKey: "files.audit.createDirectory" } });
    expect(renamed).toMatchObject({ operation: "rename", audit: { detail: "/apps/old -> /apps/new" } });
    expect(deleted).toMatchObject({ operation: "delete", audit: { level: "warning" } });
  });
});
