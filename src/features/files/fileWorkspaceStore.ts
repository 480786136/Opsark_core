import { defineStore } from "pinia";
import { backend, type RuntimeConnection } from "@/services/backend";
import type { FileEntry } from "@/types";
import { createFileMutationResult } from "./fileMutationResult";

export type FileViewMode = "list" | "compact";
export type DirectoryLoadErrorCode = "permission" | "disconnected" | "notFound" | "unknown";

export interface ServerFileWorkspace {
  files: FileEntry[];
  currentPath: string;
  loading: boolean;
  requestVersion: number;
  lastSuccessfulPath: string;
  failedPath: string;
  errorCode?: DirectoryLoadErrorCode;
}

export type DirectoryLoadResult =
  | { ok: true; path: string }
  | { ok: false; stale: true }
  | { ok: false; stale: false; error: unknown };

interface PersistedFileWorkspace {
  viewMode: FileViewMode;
  pathsByServer?: Record<string, string>;
}

const STORAGE_KEY = "opsark.fileWorkspace.v1";

export const DEMO_FILE_ENTRIES: FileEntry[] = [
  { name: "etc", path: "/etc", kind: "directory", size: "—", modified: "今天 09:20" },
  { name: "home", path: "/home", kind: "directory", size: "—", modified: "昨天 18:42" },
  { name: "opt", path: "/opt", kind: "directory", size: "—", modified: "7月24日" },
  { name: "var", path: "/var", kind: "directory", size: "—", modified: "今天 11:04" },
  { name: "deploy.sh", path: "/deploy.sh", kind: "file", size: "2.4 KB", modified: "7月21日" },
];

function createServerWorkspace(initialFiles: FileEntry[] = []): ServerFileWorkspace {
  return {
    files: [...initialFiles],
    currentPath: "/",
    loading: false,
    requestVersion: 0,
    lastSuccessfulPath: "/",
    failedPath: "",
  };
}

export function classifyDirectoryLoadError(error: unknown, connected: boolean): DirectoryLoadErrorCode {
  if (!connected) return "disconnected";
  const message = String(error).toLocaleLowerCase();
  if (/permission denied|access denied|eacces|权限|无权/.test(message)) return "permission";
  if (/no such file|not found|enoent|不存在/.test(message)) return "notFound";
  if (/disconnect|not connected|connection.*closed|broken pipe|连接.*断/.test(message)) return "disconnected";
  return "unknown";
}

/** 目录快照按服务器隔离；请求代次保证旧响应不能覆盖较新的导航结果。 */
export const useFileWorkspaceStore = defineStore("fileWorkspace", {
  state: () => ({
    hydrated: false,
    viewMode: "list" as FileViewMode,
    restoredPathsByServer: {} as Record<string, string>,
    serverWorkspaces: {} as Record<string, ServerFileWorkspace>,
  }),
  actions: {
    hydrate() {
      if (this.hydrated) return;
      this.hydrated = true;
      try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<PersistedFileWorkspace>;
        if (parsed.viewMode === "list" || parsed.viewMode === "compact") this.viewMode = parsed.viewMode;
        for (const [serverId, path] of Object.entries(parsed.pathsByServer ?? {})) {
          if (typeof path === "string" && path.startsWith("/")) this.restoredPathsByServer[serverId] = path;
        }
      } catch {
        // 偏好损坏时使用列表视图，不影响远程文件数据。
      }
    },
    ensureServer(serverId: string, initialFiles: FileEntry[] = []) {
      if (!this.serverWorkspaces[serverId]) {
        this.serverWorkspaces[serverId] = createServerWorkspace(initialFiles);
        const restoredPath = this.restoredPathsByServer[serverId];
        if (restoredPath) {
          this.serverWorkspaces[serverId].currentPath = restoredPath;
          this.serverWorkspaces[serverId].lastSuccessfulPath = restoredPath;
        }
      }
      return this.serverWorkspaces[serverId];
    },
    setViewMode(viewMode: FileViewMode) {
      this.viewMode = viewMode;
      this.persistPreferences();
    },
    markDirectoryError(serverId: string, code: DirectoryLoadErrorCode, failedPath: string) {
      const workspace = this.ensureServer(serverId);
      // 断线或本地拒绝导航时使在途请求失效，避免旧成功响应清除错误状态。
      workspace.requestVersion += 1;
      workspace.loading = false;
      workspace.errorCode = code;
      workspace.failedPath = failedPath;
    },
    removeServer(serverId: string) {
      delete this.serverWorkspaces[serverId];
      delete this.restoredPathsByServer[serverId];
      this.persistPreferences();
    },
    async loadDirectory(
      serverId: string,
      connection: RuntimeConnection,
      path = "/",
    ): Promise<DirectoryLoadResult> {
      const workspace = this.ensureServer(serverId);
      const requestVersion = workspace.requestVersion + 1;
      workspace.requestVersion = requestVersion;
      workspace.loading = true;
      try {
        const files = await backend.listSftp(connection, path);
        if (workspace.requestVersion !== requestVersion) return { ok: false, stale: true };
        workspace.files = files;
        workspace.currentPath = path;
        workspace.lastSuccessfulPath = path;
        workspace.failedPath = "";
        workspace.errorCode = undefined;
        this.restoredPathsByServer[serverId] = path;
        this.persistPreferences();
        return { ok: true, path };
      } catch (error) {
        if (workspace.requestVersion !== requestVersion) return { ok: false, stale: true };
        workspace.failedPath = path;
        workspace.errorCode = classifyDirectoryLoadError(error, true);
        return { ok: false, stale: false, error };
      } finally {
        if (workspace.requestVersion === requestVersion) workspace.loading = false;
      }
    },
    async createDirectory(serverId: string, connection: RuntimeConnection, path: string) {
      await backend.createSftpDirectory(connection, path);
      const refresh = await this.loadDirectory(serverId, connection, this.ensureServer(serverId).currentPath);
      return createFileMutationResult({ operation: "createDirectory", serverId, targetPath: path, refresh });
    },
    async renameEntry(serverId: string, connection: RuntimeConnection, fromPath: string, toPath: string) {
      await backend.renameSftpEntry(connection, fromPath, toPath);
      const refresh = await this.loadDirectory(serverId, connection, this.ensureServer(serverId).currentPath);
      return createFileMutationResult({
        operation: "rename",
        serverId,
        sourcePath: fromPath,
        targetPath: toPath,
        refresh,
      });
    },
    async deleteEntry(serverId: string, connection: RuntimeConnection, entry: FileEntry) {
      await backend.deleteSftpEntry(connection, entry.path, entry.kind);
      const refresh = await this.loadDirectory(serverId, connection, this.ensureServer(serverId).currentPath);
      return createFileMutationResult({ operation: "delete", serverId, sourcePath: entry.path, refresh });
    },
    persistPreferences() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        viewMode: this.viewMode,
        pathsByServer: this.restoredPathsByServer,
      } satisfies PersistedFileWorkspace));
    },
  },
});
