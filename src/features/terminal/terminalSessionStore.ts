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
  | "demo"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface AgentTerminalOutputChunk {
  id: number;
  data: string;
}

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

/** 只恢复版本化布局元数据；所有 PTY 在组件重新挂载后建立新通道。 */
export const useTerminalSessionStore = defineStore("terminalSessions", {
  state: () => ({
    hydrated: false,
    sessionsByServer: {} as Record<string, TerminalSessionDefinition[]>,
    activeSessionByServer: {} as Record<string, string>,
    paneStatusById: {} as Record<string, TerminalPaneStatus>,
    // Agent 输出只在当前运行期转发给任务绑定终端的只读视图，不写入布局持久化数据。
    agentOutputByPane: {} as Record<string, AgentTerminalOutputChunk[]>,
    agentOutputSequence: 0,
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
          if (valid.length) this.sessionsByServer[serverId] = valid;
        }
        for (const [serverId, sessionId] of Object.entries(parsed.activeSessionByServer ?? {})) {
          if (typeof sessionId === "string" && this.sessionsByServer[serverId]?.some(({ id }) => id === sessionId)) {
            this.activeSessionByServer[serverId] = sessionId;
          }
        }
        if (migrateLegacy && Object.keys(this.sessionsByServer).length) this.persist();
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
      if (this.activeSessionByServer[serverId] === sessionId) {
        const adjacent = sessions[Math.min(index, sessions.length - 1)];
        if (adjacent) this.activeSessionByServer[serverId] = adjacent.id;
        else delete this.activeSessionByServer[serverId];
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
