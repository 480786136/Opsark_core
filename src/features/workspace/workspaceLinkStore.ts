import { defineStore } from "pinia";
import { normalizeRemotePath } from "@/features/files/remotePath";

export interface WorkspacePathRequest {
  id: number;
  path: string;
}

export interface TerminalModelReference {
  id: number;
  paneId: string;
  content: string;
}

let nextRequestId = 0;

function createPathRequest(path: string): WorkspacePathRequest {
  nextRequestId += 1;
  return { id: nextRequestId, path: normalizeRemotePath(path) };
}

/** 使用 POSIX 单引号规则生成不可插值的 Shell 参数。 */
export function quoteShellPath(path: string) {
  return `'${normalizeRemotePath(path).replace(/'/g, `'"'"'`)}'`;
}

export function buildTerminalDirectoryProbeCommand() {
  // 该命令是工作台内部探针，执行后从 Bash 历史中精确删除自身。
  return "printf '\\033]7;file://%s%s\\007' \"$HOSTNAME\" \"$PWD\"; if [ -n \"${BASH_VERSION:-}\" ]; then case $- in *h*) __opsark_history_tail=$(history 1); case \"$__opsark_history_tail\" in *file://%s%s*) history -d $((HISTCMD-1)) 2>/dev/null;; esac; unset __opsark_history_tail;; esac; fi\r";
}

export function buildTerminalChangeDirectoryCommand(path: string) {
  return `cd -- ${quoteShellPath(path)} && ${buildTerminalDirectoryProbeCommand()}`;
}

/**
 * 从终端数据块提取标准 OSC 7 当前目录标记。
 * 标记可能使用 BEL 或 ST 结束；主机部分只用于协议兼容，不参与远程路径计算。
 */
export function extractOsc7Directories(data: string): string[] {
  const directories: string[] = [];
  const pattern = /\u001b\]7;file:\/\/[^/\u0007\u001b]*(\/[^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
  for (const match of data.matchAll(pattern)) {
    try {
      directories.push(normalizeRemotePath(decodeURIComponent(match[1])));
    } catch {
      // 非法 URI 编码不是可信工作目录，直接忽略该标记。
    }
  }
  return directories;
}

/** 仅保存工作台内的瞬时联动请求，不跨启动恢复。 */
export const useWorkspaceLinkStore = defineStore("workspaceLinks", {
  state: () => ({
    terminalPathRequests: {} as Record<string, WorkspacePathRequest>,
    sftpPathRequests: {} as Record<string, WorkspacePathRequest>,
    paneDirectories: {} as Record<string, string>,
    terminalModelReferences: {} as Record<string, TerminalModelReference>,
  }),
  actions: {
    requestTerminalPath(serverId: string, path: string) {
      this.terminalPathRequests[serverId] = createPathRequest(path);
      return this.terminalPathRequests[serverId];
    },
    consumeTerminalPath(serverId: string, requestId: number) {
      if (this.terminalPathRequests[serverId]?.id === requestId) delete this.terminalPathRequests[serverId];
    },
    requestSftpPath(serverId: string, path: string) {
      this.sftpPathRequests[serverId] = createPathRequest(path);
      return this.sftpPathRequests[serverId];
    },
    consumeSftpPath(serverId: string, requestId: number) {
      if (this.sftpPathRequests[serverId]?.id === requestId) delete this.sftpPathRequests[serverId];
    },
    publishPaneDirectory(paneId: string, path: string) {
      this.paneDirectories[paneId] = normalizeRemotePath(path);
    },
    publishTerminalModelReference(serverId: string, paneId: string, content: string) {
      const normalized = content.trim().slice(0, 24_000);
      if (!normalized) return undefined;
      this.terminalModelReferences[serverId] = { id: ++nextRequestId, paneId, content: normalized };
      return this.terminalModelReferences[serverId];
    },
    consumeTerminalModelReference(serverId: string, requestId: number) {
      if (this.terminalModelReferences[serverId]?.id === requestId) delete this.terminalModelReferences[serverId];
    },
    removePane(paneId: string) {
      delete this.paneDirectories[paneId];
    },
  },
});
