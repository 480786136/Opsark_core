import { defineStore } from "pinia";
import { normalizeTerminalPaneSizes } from "./terminalPaneLayout";
import {
  collectTerminalPaneIds,
  createTerminalPaneNode,
  migrateFlatTerminalLayout,
  normalizeTerminalLayout,
  type TerminalLayoutNode,
  type TerminalSplitDirection,
} from "./terminalSplitTree";

export type TerminalPaneStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface AgentTerminalOutputChunk {
  id: number;
  data: string;
}

export interface AgentPtyCommandRequest {
  id: string;
  paneId: string;
  command: string;
  displayCommand: string;
  createdAt: string;
}

export interface AgentPtyCommandResult {
  output: string;
  success: boolean;
  simulated: false;
  exitCode: number;
  emptyResult: boolean;
}

export interface AgentPtySshJumpRequest {
  id: string;
  paneId: string;
  host: string;
  port: number;
  username: string;
  createdAt: string;
}

export interface AgentPtySshJumpResult {
  output: string;
  success: true;
  simulated: false;
  exitCode: 0;
  emptyResult: false;
}

const agentCommandCallbacks = new Map<string, {
  resolve: (result: AgentPtyCommandResult) => void;
  reject: (error: Error) => void;
  onProgress?: (data: string) => void;
  timer: number;
}>();

const agentSshJumpCallbacks = new Map<string, {
  resolve: (result: AgentPtySshJumpResult) => void;
  reject: (error: Error) => void;
  password: string;
  timer: number;
}>();

export interface TerminalSessionDefinition {
  id: string;
  label: string;
  createdAt: string;
  panes: TerminalPaneDefinition[];
  activePaneId: string;
  layout: TerminalLayoutNode;
}

export interface TerminalPaneDefinition {
  id: string;
  createdAt: string;
  kind: "shell" | "agent";
  agentTaskId?: string;
}

interface PersistedTerminalWorkspaceV2 {
  version: 2;
  sessionsByServer: Record<string, TerminalSessionDefinition[]>;
  activeSessionByServer: Record<string, string>;
}

interface PersistedTerminalWorkspaceV1 {
  sessionsByServer?: Record<string, unknown[]>;
  activeSessionByServer?: Record<string, string>;
}

const STORAGE_KEY = "opsark.terminalWorkspaces.v2";
const LEGACY_STORAGE_KEY = "opsark.terminalWorkspaces.v1";
const MAX_SESSIONS_PER_SERVER = 8;
const MAX_PANES_PER_SESSION = 4;

function createSession(index: number, paneKind: TerminalPaneDefinition["kind"] = "shell"): TerminalSessionDefinition {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  return {
    id,
    label: `Shell ${index}`,
    createdAt,
    panes: [{ id, createdAt, kind: paneKind }],
    activePaneId: id,
    layout: createTerminalPaneNode(id),
  };
}

function normalizeSession(value: unknown): TerminalSessionDefinition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const session = value as Record<string, unknown>;
  if (
    typeof session.id !== "string"
    || typeof session.label !== "string"
    || !session.label.trim()
    || typeof session.createdAt !== "string"
  ) return undefined;

  const paneIds = new Set<string>();
  const panes = Array.isArray(session.panes)
    ? session.panes.filter((pane): pane is TerminalPaneDefinition => {
      if (!pane || typeof pane !== "object") return false;
      const candidate = pane as Record<string, unknown>;
      if (
        typeof candidate.id !== "string"
        || paneIds.has(candidate.id)
        || typeof candidate.createdAt !== "string"
      ) return false;
      candidate.kind = candidate.kind === "agent" ? "agent" : "shell";
      candidate.agentTaskId = typeof candidate.agentTaskId === "string"
        ? candidate.agentTaskId
        : undefined;
      paneIds.add(candidate.id);
      return true;
    }).slice(0, MAX_PANES_PER_SESSION)
    : [];
  // 最早期数据只有标签字段；沿用标签 ID 迁移为唯一叶子。
  if (!panes.length) panes.push({ id: session.id, createdAt: session.createdAt, kind: "shell" });
  const ids = panes.map(({ id }) => id);
  const legacyDirection: TerminalSplitDirection = session.splitDirection === "horizontal" ? "horizontal" : "vertical";
  const legacySizes = normalizeTerminalPaneSizes(session.paneSizes, panes.length);
  const layout = normalizeTerminalLayout(
    session.layout,
    ids,
    () => migrateFlatTerminalLayout(ids, legacySizes, legacyDirection),
  );
  const orderedPaneIds = collectTerminalPaneIds(layout);
  const activePaneId = typeof session.activePaneId === "string" && orderedPaneIds.includes(session.activePaneId)
    ? session.activePaneId
    : orderedPaneIds[0];
  return {
    id: session.id,
    label: session.label,
    createdAt: session.createdAt,
    panes,
    activePaneId,
    layout,
  };
}

function readPersistedWorkspace(): PersistedTerminalWorkspaceV1 {
  const current = localStorage.getItem(STORAGE_KEY);
  if (current) {
    const parsed = JSON.parse(current) as Partial<PersistedTerminalWorkspaceV2>;
    if (parsed.version === 2) return parsed;
  }
  return JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "{}") as PersistedTerminalWorkspaceV1;
}

/** PTY 是实时会话；启动时每台服务器只恢复上次活动的一个标签。 */
export const useTerminalSessionStore = defineStore("terminalSessions", {
  state: () => ({
    hydrated: false,
    sessionsByServer: {} as Record<string, TerminalSessionDefinition[]>,
    activeSessionByServer: {} as Record<string, string>,
    paneStatusById: {} as Record<string, TerminalPaneStatus>,
    // Agent 输出只在当前运行期转发给任务绑定终端的只读视图，不写入布局持久化数据。
    agentOutputByPane: {} as Record<string, AgentTerminalOutputChunk[]>,
    agentOutputSequence: 0,
    agentCommandByPane: {} as Record<string, AgentPtyCommandRequest>,
    agentSshJumpByPane: {} as Record<string, AgentPtySshJumpRequest>,
    effectiveSshTargetByPane: {} as Record<string, { host: string; port: number; username: string }>,
    agentInterruptByPane: {} as Record<string, number>,
  }),
  actions: {
    hydrate() {
      if (this.hydrated) return;
      this.hydrated = true;
      try {
        const migrateLegacy = !localStorage.getItem(STORAGE_KEY);
        const parsed = readPersistedWorkspace();
        for (const [serverId, sessions] of Object.entries(parsed.sessionsByServer ?? {})) {
          if (!Array.isArray(sessions)) continue;
          const valid = sessions
            .map(normalizeSession)
            .filter((session): session is TerminalSessionDefinition => Boolean(session))
            .slice(0, MAX_SESSIONS_PER_SERVER);
          if (!valid.length) continue;
          const persistedActiveId = parsed.activeSessionByServer?.[serverId];
          const active = valid.find(({ id }) => id === persistedActiveId) ?? valid[0];
          const activePane = active.panes.find(({ id }) => id === active.activePaneId) ?? active.panes[0];
          const restored: TerminalSessionDefinition = {
            id: activePane.id,
            label: active.label,
            createdAt: activePane.createdAt,
            panes: [{ ...activePane, kind: "shell", agentTaskId: undefined }],
            activePaneId: activePane.id,
            layout: createTerminalPaneNode(activePane.id),
          };
          this.sessionsByServer[serverId] = [restored];
          this.activeSessionByServer[serverId] = restored.id;
        }
        if ((migrateLegacy || Object.keys(this.sessionsByServer).length) && Object.keys(this.sessionsByServer).length) this.persist();
      } catch {
        // 布局数据损坏时按服务器重建默认标签，不影响 SSH 凭据。
      }
    },
    ensureWorkspace(serverId: string) {
      this.hydrate();
      if (!this.sessionsByServer[serverId]?.length) {
        const session = createSession(1);
        this.sessionsByServer[serverId] = [session];
        this.activeSessionByServer[serverId] = session.id;
        this.persist();
      } else if (!this.activeSessionByServer[serverId]) {
        this.activeSessionByServer[serverId] = this.sessionsByServer[serverId][0].id;
        this.persist();
      }
      this.flattenServerTabs(serverId);
    },
    /** 将旧分屏中的真实 Shell 叶子迁移为相互独立的终端选项卡。 */
    flattenServerTabs(serverId: string) {
      const sessions = this.sessionsByServer[serverId] ?? [];
      if (!sessions.some(({ panes }) => panes.length > 1 || panes.some(({ kind }) => kind === "agent"))) return;
      const activeSession = sessions.find(({ id }) => id === this.activeSessionByServer[serverId]);
      const activePaneId = activeSession?.activePaneId;
      const flattened: TerminalSessionDefinition[] = [];
      for (const session of sessions) {
        for (const paneId of collectTerminalPaneIds(session.layout)) {
          const pane = session.panes.find(({ id }) => id === paneId);
          if (!pane || pane.kind === "agent" || flattened.length >= MAX_SESSIONS_PER_SERVER) {
            delete this.paneStatusById[paneId];
            delete this.agentOutputByPane[paneId];
            continue;
          }
          const shellPane = { ...pane, kind: "shell" as const };
          flattened.push({
            id: pane.id,
            label: session.label,
            createdAt: pane.createdAt,
            panes: [shellPane],
            activePaneId: pane.id,
            layout: createTerminalPaneNode(pane.id),
          });
        }
      }
      if (!flattened.length) flattened.push(createSession(1));
      this.sessionsByServer[serverId] = flattened;
      this.activeSessionByServer[serverId] = flattened.some(({ id }) => id === activePaneId)
        ? activePaneId!
        : flattened[0].id;
      this.persist();
    },
    addSession(serverId: string) {
      this.ensureWorkspace(serverId);
      const sessions = this.sessionsByServer[serverId];
      if (sessions.length >= MAX_SESSIONS_PER_SERVER) return undefined;
      const session = createSession(sessions.length + 1);
      sessions.push(session);
      this.activeSessionByServer[serverId] = session.id;
      this.persist();
      return session;
    },
    activateSession(serverId: string, sessionId: string) {
      if (!this.sessionsByServer[serverId]?.some(({ id }) => id === sessionId)) return;
      this.activeSessionByServer[serverId] = sessionId;
      this.persist();
    },
    activatePane(serverId: string, paneId: string) {
      const session = this.sessionsByServer[serverId]?.find(({ panes }) =>
        panes.some(({ id }) => id === paneId)
      );
      if (!session) return false;
      session.activePaneId = paneId;
      this.activeSessionByServer[serverId] = session.id;
      this.persist();
      return true;
    },
    resolveActivePaneId(serverId: string) {
      const activeSessionId = this.activeSessionByServer[serverId];
      return this.sessionsByServer[serverId]?.find(({ id }) => id === activeSessionId)?.activePaneId;
    },
    resolveTaskPaneId(serverId: string, taskId: string) {
      for (const session of this.sessionsByServer[serverId] ?? []) {
        const pane = session.panes.find(({ agentTaskId }) => agentTaskId === taskId);
        if (pane) return pane.id;
      }
      return undefined;
    },
    bindAgentTask(serverId: string, taskId: string) {
      this.ensureWorkspace(serverId);
      const activeSessionId = this.activeSessionByServer[serverId];
      const session = this.sessionsByServer[serverId]?.find(({ id }) => id === activeSessionId);
      const pane = session?.panes[0];
      if (!pane) return undefined;
      for (const item of this.sessionsByServer[serverId]) {
        item.panes.forEach((candidate) => {
          if (candidate.agentTaskId === taskId) candidate.agentTaskId = undefined;
        });
      }
      pane.agentTaskId = taskId;
      this.persist();
      return pane.id;
    },
    publishAgentOutput(paneId: string, data: string) {
      if (!paneId || !data) return;
      const paneExists = Object.values(this.sessionsByServer)
        .some((sessions) => sessions.some(({ panes }) => panes.some(({ id, agentTaskId }) => id === paneId && Boolean(agentTaskId))));
      if (!paneExists) return;
      const queue = this.agentOutputByPane[paneId] ??= [];
      queue.push({ id: ++this.agentOutputSequence, data });
      // 组件暂未挂载时保留有限队列，防止长任务无限占用内存。
      if (queue.length > 500) queue.splice(0, queue.length - 500);
    },
    requestAgentPtyCommand(paneId: string, executionId: string, command: string, onProgress?: (data: string) => void, displayCommand = command) {
      if (this.agentCommandByPane[paneId] || this.agentSshJumpByPane[paneId]) return Promise.reject(new Error("当前终端已有智能命令在执行"));
      const request = { id: executionId, paneId, command, displayCommand, createdAt: new Date().toISOString() };
      this.agentCommandByPane[paneId] = request;
      return new Promise<AgentPtyCommandResult>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          delete this.agentCommandByPane[paneId];
          agentCommandCallbacks.delete(executionId);
          reject(new Error("绑定终端执行超时"));
        }, 30 * 60 * 1000);
        agentCommandCallbacks.set(executionId, { resolve, reject, onProgress, timer });
      });
    },
    requestAgentPtySshJump(
      paneId: string,
      executionId: string,
      target: { host: string; port: number; username: string },
      password: string,
    ) {
      if (this.agentCommandByPane[paneId] || this.agentSshJumpByPane[paneId]) {
        return Promise.reject(new Error("当前终端已有智能命令在执行"));
      }
      this.agentSshJumpByPane[paneId] = {
        id: executionId,
        paneId,
        ...target,
        createdAt: new Date().toISOString(),
      };
      return new Promise<AgentPtySshJumpResult>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          delete this.agentSshJumpByPane[paneId];
          agentSshJumpCallbacks.delete(executionId);
          reject(new Error("终端内 SSH 登录超时"));
        }, 60_000);
        agentSshJumpCallbacks.set(executionId, { resolve, reject, password, timer });
      });
    },
    readAgentSshPassword(executionId: string) {
      return agentSshJumpCallbacks.get(executionId)?.password;
    },
    completeAgentPtySshJump(paneId: string, executionId: string, output: string) {
      const callback = agentSshJumpCallbacks.get(executionId);
      if (!callback) return;
      const request = this.agentSshJumpByPane[paneId];
      if (request?.id === executionId) {
        this.effectiveSshTargetByPane[paneId] = {
          host: request.host,
          port: request.port,
          username: request.username,
        };
      }
      window.clearTimeout(callback.timer);
      agentSshJumpCallbacks.delete(executionId);
      if (this.agentSshJumpByPane[paneId]?.id === executionId) delete this.agentSshJumpByPane[paneId];
      callback.resolve({ output, success: true, simulated: false, exitCode: 0, emptyResult: false });
    },
    failAgentPtySshJump(paneId: string, executionId: string, reason: string) {
      const callback = agentSshJumpCallbacks.get(executionId);
      if (!callback) return;
      window.clearTimeout(callback.timer);
      agentSshJumpCallbacks.delete(executionId);
      if (this.agentSshJumpByPane[paneId]?.id === executionId) delete this.agentSshJumpByPane[paneId];
      callback.reject(new Error(reason));
    },
    clearAgentPtySshTarget(paneId: string) {
      delete this.effectiveSshTargetByPane[paneId];
    },
    publishAgentPtyProgress(executionId: string, data: string) {
      if (data) agentCommandCallbacks.get(executionId)?.onProgress?.(data);
    },
    completeAgentPtyCommand(paneId: string, executionId: string, output: string, exitCode: number) {
      const callback = agentCommandCallbacks.get(executionId);
      if (!callback) return;
      window.clearTimeout(callback.timer);
      agentCommandCallbacks.delete(executionId);
      if (this.agentCommandByPane[paneId]?.id === executionId) delete this.agentCommandByPane[paneId];
      const emptyResult = exitCode === 0 && !output.trim();
      callback.resolve({ output, success: exitCode === 0, simulated: false, exitCode, emptyResult });
    },
    failAgentPtyCommand(paneId: string, executionId: string, reason: string) {
      const callback = agentCommandCallbacks.get(executionId);
      if (!callback) return;
      window.clearTimeout(callback.timer);
      agentCommandCallbacks.delete(executionId);
      if (this.agentCommandByPane[paneId]?.id === executionId) delete this.agentCommandByPane[paneId];
      callback.reject(new Error(reason));
    },
    interruptAgentPtyCommand(paneId: string) {
      this.agentInterruptByPane[paneId] = (this.agentInterruptByPane[paneId] ?? 0) + 1;
    },
    consumeAgentOutput(paneId: string, throughId: number) {
      const queue = this.agentOutputByPane[paneId];
      if (!queue?.length) return;
      const remaining = queue.filter(({ id }) => id > throughId);
      if (remaining.length) this.agentOutputByPane[paneId] = remaining;
      else delete this.agentOutputByPane[paneId];
    },
    setPaneStatus(paneId: string, status: TerminalPaneStatus) {
      this.paneStatusById[paneId] = status;
    },
    renameSession(serverId: string, sessionId: string, label: string) {
      const session = this.sessionsByServer[serverId]?.find(({ id }) => id === sessionId);
      const normalized = label.trim().slice(0, 40);
      if (!session || !normalized) return false;
      session.label = normalized;
      this.persist();
      return true;
    },
    removeSession(serverId: string, sessionId: string) {
      const sessions = this.sessionsByServer[serverId] ?? [];
      const index = sessions.findIndex(({ id }) => id === sessionId);
      if (index < 0) return;
      sessions[index].panes.forEach(({ id }) => {
        delete this.paneStatusById[id];
        delete this.agentOutputByPane[id];
      });
      sessions.splice(index, 1);
      if (!sessions.length) {
        const replacement = createSession(1);
        sessions.push(replacement);
        this.activeSessionByServer[serverId] = replacement.id;
      } else if (this.activeSessionByServer[serverId] === sessionId) {
        const adjacent = sessions[Math.min(index, sessions.length - 1)];
        this.activeSessionByServer[serverId] = adjacent.id;
      }
      this.persist();
    },
    persist() {
      const value: PersistedTerminalWorkspaceV2 = {
        version: 2,
        sessionsByServer: this.sessionsByServer,
        activeSessionByServer: this.activeSessionByServer,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    },
  },
});

export {
  LEGACY_STORAGE_KEY,
  MAX_PANES_PER_SESSION,
  MAX_SESSIONS_PER_SERVER,
  STORAGE_KEY,
  type TerminalSplitDirection,
};
