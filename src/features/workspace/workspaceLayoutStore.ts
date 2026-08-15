import { defineStore } from "pinia";

export type WorkspacePanel = "files" | "terminal" | "agent";
export type WorkspaceResizeHandle = "files-terminal" | "terminal-agent";
export type WorkspaceLayoutPreset = "shell" | "balanced" | "files" | "agent";

export interface WorkspaceColumns {
  files: number;
  terminal: number;
  agent: number;
}

const STORAGE_KEY = "opsark.workspaceLayout.v1";
const MIN_COLUMNS: WorkspaceColumns = { files: 12, terminal: 30, agent: 24 };

export const workspaceLayoutPresets: Record<WorkspaceLayoutPreset, WorkspaceColumns> = {
  shell: { files: 16, terminal: 59, agent: 25 },
  balanced: { files: 22, terminal: 45, agent: 33 },
  files: { files: 35, terminal: 40, agent: 25 },
  agent: { files: 15, terminal: 35, agent: 50 },
};

function roundColumn(value: number): number {
  return Math.round(value * 100) / 100;
}

function isPreset(value: unknown): value is WorkspaceLayoutPreset {
  return value === "shell" || value === "balanced" || value === "files" || value === "agent";
}

function isValidColumns(value: unknown): value is WorkspaceColumns {
  if (!value || typeof value !== "object") return false;
  const columns = value as Partial<WorkspaceColumns>;
  const values = [columns.files, columns.terminal, columns.agent];
  if (!values.every((item) => typeof item === "number" && Number.isFinite(item))) return false;
  if (columns.files! < MIN_COLUMNS.files || columns.terminal! < MIN_COLUMNS.terminal || columns.agent! < MIN_COLUMNS.agent) return false;
  return Math.abs(columns.files! + columns.terminal! + columns.agent! - 100) < 0.02;
}

/**
 * 只调整分隔线两侧的面板，第三个面板保持不变。
 * 该函数不访问 DOM，便于独立验证最小宽度和总比例约束。
 */
export function resizeWorkspaceColumns(
  columns: WorkspaceColumns,
  handle: WorkspaceResizeHandle,
  deltaPercent: number,
): WorkspaceColumns {
  if (handle === "files-terminal") {
    const pairTotal = columns.files + columns.terminal;
    const files = Math.min(
      pairTotal - MIN_COLUMNS.terminal,
      Math.max(MIN_COLUMNS.files, columns.files + deltaPercent),
    );
    return { files: roundColumn(files), terminal: roundColumn(pairTotal - files), agent: columns.agent };
  }

  const pairTotal = columns.terminal + columns.agent;
  const terminal = Math.min(
    pairTotal - MIN_COLUMNS.agent,
    Math.max(MIN_COLUMNS.terminal, columns.terminal + deltaPercent),
  );
  return { files: columns.files, terminal: roundColumn(terminal), agent: roundColumn(pairTotal - terminal) };
}

export const useWorkspaceLayoutStore = defineStore("workspace-layout", {
  state: () => ({
    columns: { ...workspaceLayoutPresets.shell } as WorkspaceColumns,
    preset: "shell" as WorkspaceLayoutPreset | null,
    focusPanel: null as WorkspacePanel | null,
    hydrated: false,
  }),
  actions: {
    hydrate() {
      if (this.hydrated) return;
      try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
        if (isValidColumns(parsed.columns)) this.columns = { ...parsed.columns };
        if (parsed.preset === null || isPreset(parsed.preset)) this.preset = parsed.preset;
      } catch {
        // 布局配置损坏时使用 Shell 默认布局，不阻断工作台启动。
      }
      this.hydrated = true;
    },
    applyPreset(preset: WorkspaceLayoutPreset) {
      this.preset = preset;
      this.columns = { ...workspaceLayoutPresets[preset] };
      this.persist();
    },
    setColumns(columns: WorkspaceColumns, shouldPersist = true) {
      if (!isValidColumns(columns)) return;
      this.columns = { ...columns };
      this.preset = null;
      if (shouldPersist) this.persist();
    },
    toggleFocus(panel: WorkspacePanel) {
      this.focusPanel = this.focusPanel === panel ? null : panel;
      // 专注模式属于临时工作状态，不跨应用启动恢复。
    },
    clearFocus() {
      this.focusPanel = null;
    },
    persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        columns: this.columns,
        preset: this.preset,
      }));
    },
  },
});
