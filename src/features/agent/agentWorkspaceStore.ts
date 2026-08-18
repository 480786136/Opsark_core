import { defineStore } from "pinia";
import { normalizePermissionLevel } from "@/features/agent/approvalPolicy";
import type { PermissionLevel } from "@/types";

export interface ServerAgentWorkspaceState {
  activeTaskId: string;
  draft: string;
  permission: PermissionLevel;
  modelId: string;
  automationEnabled: boolean;
  showTasks: boolean;
}

interface PersistedAgentWorkspaces {
  version: 1;
  workspaces: Record<string, ServerAgentWorkspaceState>;
}

const STORAGE_KEY = "opsark.agentWorkspaces.v1";
let persistTimer: number | undefined;

function defaultWorkspace(): ServerAgentWorkspaceState {
  return {
    activeTaskId: "",
    draft: "",
    permission: "safe",
    modelId: "",
    automationEnabled: false,
    showTasks: true,
  };
}

function normalizeWorkspace(value: unknown): ServerAgentWorkspaceState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  return {
    activeTaskId: typeof candidate.activeTaskId === "string" ? candidate.activeTaskId : "",
    draft: typeof candidate.draft === "string" ? candidate.draft.slice(0, 20_000) : "",
    permission: normalizePermissionLevel(candidate.permission),
    modelId: typeof candidate.modelId === "string" ? candidate.modelId : "",
    automationEnabled: candidate.automationEnabled === true,
    showTasks: candidate.showTasks !== false,
  };
}

/** 保存无敏感值的 Agent 界面状态；终端引用和临时 Secret 始终只保存在组件内存。 */
export const useAgentWorkspaceStore = defineStore("agentWorkspaces", {
  state: () => ({
    hydrated: false,
    workspaces: {} as Record<string, ServerAgentWorkspaceState>,
  }),
  actions: {
    hydrate() {
      if (this.hydrated) return;
      this.hydrated = true;
      try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<PersistedAgentWorkspaces>;
        if (parsed.version !== 1) return;
        for (const [serverId, value] of Object.entries(parsed.workspaces ?? {})) {
          const workspace = normalizeWorkspace(value);
          if (workspace) this.workspaces[serverId] = workspace;
        }
      } catch {
        // 损坏的界面状态不影响已持久化任务和执行记录。
      }
    },
    ensureServer(serverId: string) {
      this.hydrate();
      if (!this.workspaces[serverId]) this.workspaces[serverId] = defaultWorkspace();
      return this.workspaces[serverId];
    },
    updateServer(serverId: string, patch: Partial<ServerAgentWorkspaceState>) {
      Object.assign(this.ensureServer(serverId), patch);
      this.persist();
    },
    reconcileTasks(serverId: string, taskIds: string[]) {
      const workspace = this.ensureServer(serverId);
      if (workspace.activeTaskId && taskIds.includes(workspace.activeTaskId)) return;
      workspace.activeTaskId = taskIds[0] ?? "";
      this.persist();
    },
    removeServer(serverId: string) {
      delete this.workspaces[serverId];
      this.persist(true);
    },
    persist(immediate = false) {
      if (persistTimer !== undefined) window.clearTimeout(persistTimer);
      const write = () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          version: 1,
          workspaces: this.workspaces,
        } satisfies PersistedAgentWorkspaces));
        persistTimer = undefined;
      };
      if (immediate) write();
      else persistTimer = window.setTimeout(write, 150);
    },
  },
});

export { STORAGE_KEY };
