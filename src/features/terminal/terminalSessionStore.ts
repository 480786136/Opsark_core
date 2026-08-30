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

export type TerminalPaneStatus = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

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
  kind: "shell";
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

function createSession(index: number): TerminalSessionDefinition {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  return {
    id,
    label: `Shell ${index}`,
    createdAt,
    panes: [{ id, createdAt, kind: "shell" }],
    activePaneId: id,
    layout: createTerminalPaneNode(id),
  };
}

function normalizeSession(value: unknown): TerminalSessionDefinition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const session = value as Record<string, unknown>;
  if (typeof session.id !== "string" || typeof session.label !== "string"
    || !session.label.trim() || typeof session.createdAt !== "string") return undefined;
  const paneIds = new Set<string>();
  const panes = Array.isArray(session.panes)
    ? session.panes.filter((pane): pane is TerminalPaneDefinition => {
      if (!pane || typeof pane !== "object") return false;
      const candidate = pane as Record<string, unknown>;
      // Legacy Agent panes belonged to the removed shared-PTY protocol. Never
      // resurrect them as a live shell or a fake AgentSession.
      if (candidate.kind === "agent") return false;
      if (typeof candidate.id !== "string" || paneIds.has(candidate.id)
        || typeof candidate.createdAt !== "string") return false;
      candidate.kind = "shell";
      delete candidate.agentTaskId;
      paneIds.add(candidate.id);
      return true;
    }).slice(0, MAX_PANES_PER_SESSION)
    : [];
  if (!panes.length) panes.push({ id: session.id, createdAt: session.createdAt, kind: "shell" });
  const ids = panes.map(({ id }) => id);
  const legacyDirection: TerminalSplitDirection = session.splitDirection === "horizontal" ? "horizontal" : "vertical";
  const layout = normalizeTerminalLayout(
    session.layout,
    ids,
    () => migrateFlatTerminalLayout(ids, normalizeTerminalPaneSizes(session.paneSizes, panes.length), legacyDirection),
  );
  const orderedPaneIds = collectTerminalPaneIds(layout);
  const activePaneId = typeof session.activePaneId === "string" && orderedPaneIds.includes(session.activePaneId)
    ? session.activePaneId
    : orderedPaneIds[0];
  return { id: session.id, label: session.label, createdAt: session.createdAt, panes, activePaneId, layout };
}

function readPersistedWorkspace(): PersistedTerminalWorkspaceV1 {
  const current = localStorage.getItem(STORAGE_KEY);
  if (current) {
    const parsed = JSON.parse(current) as Partial<PersistedTerminalWorkspaceV2>;
    if (parsed.version === 2) return parsed;
  }
  return JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "{}") as PersistedTerminalWorkspaceV1;
}

/** User Shell state only. Agent execution state lives in agentTerminalStore. */
export const useTerminalSessionStore = defineStore("terminalSessions", {
  state: () => ({
    hydrated: false,
    sessionsByServer: {} as Record<string, TerminalSessionDefinition[]>,
    activeSessionByServer: {} as Record<string, string>,
    paneStatusById: {} as Record<string, TerminalPaneStatus>,
    terminalGenerationByPane: {} as Record<string, number>,
  }),
  actions: {
    hydrate() {
      if (this.hydrated) return;
      this.hydrated = true;
      try {
        const parsed = readPersistedWorkspace();
        for (const [serverId, sessions] of Object.entries(parsed.sessionsByServer ?? {})) {
          if (!Array.isArray(sessions)) continue;
          const valid = sessions.map(normalizeSession)
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
            panes: [{ ...activePane, kind: "shell" }],
            activePaneId: activePane.id,
            layout: createTerminalPaneNode(activePane.id),
          };
          this.sessionsByServer[serverId] = [restored];
          this.activeSessionByServer[serverId] = restored.id;
        }
        if (Object.keys(this.sessionsByServer).length) this.persist();
      } catch {
        // Corrupt layout data is isolated from SSH credentials and rebuilt on demand.
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
    /** Convert legacy split layouts to independent Shell tabs. */
    flattenServerTabs(serverId: string) {
      const sessions = this.sessionsByServer[serverId] ?? [];
      if (!sessions.some(({ panes }) => panes.length > 1)) return;
      const activeSession = sessions.find(({ id }) => id === this.activeSessionByServer[serverId]);
      const activePaneId = activeSession?.activePaneId;
      const flattened: TerminalSessionDefinition[] = [];
      for (const session of sessions) {
        for (const paneId of collectTerminalPaneIds(session.layout)) {
          const pane = session.panes.find(({ id }) => id === paneId);
          if (!pane || flattened.length >= MAX_SESSIONS_PER_SERVER) continue;
          flattened.push({
            id: pane.id,
            label: session.label,
            createdAt: pane.createdAt,
            panes: [{ ...pane, kind: "shell" }],
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
      const session = this.sessionsByServer[serverId]?.find(({ panes }) => panes.some(({ id }) => id === paneId));
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
    setPaneStatus(paneId: string, status: TerminalPaneStatus) {
      const previous = this.paneStatusById[paneId];
      if (status === "connected" && previous !== "connected") {
        this.terminalGenerationByPane[paneId] = (this.terminalGenerationByPane[paneId] ?? 0) + 1;
      }
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
        delete this.terminalGenerationByPane[id];
      });
      sessions.splice(index, 1);
      if (!sessions.length) {
        const replacement = createSession(1);
        sessions.push(replacement);
        this.activeSessionByServer[serverId] = replacement.id;
      } else if (this.activeSessionByServer[serverId] === sessionId) {
        this.activeSessionByServer[serverId] = sessions[Math.min(index, sessions.length - 1)].id;
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
