// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  resizeWorkspaceColumns,
  useWorkspaceLayoutStore,
  workspaceLayoutPresets,
} from "./workspaceLayoutStore";

describe("workspaceLayoutStore", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("拖拽时保持总比例并限制面板最小宽度", () => {
    const left = resizeWorkspaceColumns(workspaceLayoutPresets.shell, "files-terminal", -50);
    const right = resizeWorkspaceColumns(workspaceLayoutPresets.shell, "terminal-agent", 50);

    expect(left).toEqual({ files: 12, terminal: 63, agent: 25 });
    expect(right).toEqual({ files: 16, terminal: 60, agent: 24 });
    expect(left.files + left.terminal + left.agent).toBe(100);
    expect(right.files + right.terminal + right.agent).toBe(100);
  });

  it("恢复持久化比例，但不恢复临时专注模式", () => {
    const layout = useWorkspaceLayoutStore();
    layout.applyPreset("agent");
    layout.toggleFocus("terminal");

    setActivePinia(createPinia());
    const restored = useWorkspaceLayoutStore();
    restored.hydrate();

    expect(restored.columns).toEqual(workspaceLayoutPresets.agent);
    expect(restored.preset).toBe("agent");
    expect(restored.focusPanel).toBeNull();
  });

  it("忽略不满足最小比例的损坏配置", () => {
    localStorage.setItem("opsark.workspaceLayout.v1", JSON.stringify({
      columns: { files: 2, terminal: 80, agent: 18 },
      preset: "unknown",
    }));

    const layout = useWorkspaceLayoutStore();
    layout.hydrate();

    expect(layout.columns).toEqual(workspaceLayoutPresets.shell);
    expect(layout.preset).toBe("shell");
  });

  it("首次进入时将临时放宽的 Shell 布局恢复为原始比例", () => {
    localStorage.setItem("opsark.workspaceLayout.v1", JSON.stringify({
      columns: { files: 16, terminal: 49, agent: 35 },
      preset: "shell",
      visiblePanels: { files: false, terminal: true, agent: true },
    }));

    const layout = useWorkspaceLayoutStore();
    layout.hydrate();

    expect(layout.columns).toEqual({ files: 16, terminal: 59, agent: 25 });
    expect(layout.visiblePanels).toEqual({ files: false, terminal: true, agent: true });
    expect(JSON.parse(localStorage.getItem("opsark.workspaceLayout.v1") ?? "{}").columns)
      .toEqual({ files: 16, terminal: 59, agent: 25 });
  });

  it("不覆盖用户手动调整的其他布局比例", () => {
    localStorage.setItem("opsark.workspaceLayout.v1", JSON.stringify({
      columns: { files: 16, terminal: 54, agent: 30 },
      preset: null,
    }));

    const layout = useWorkspaceLayoutStore();
    layout.hydrate();

    expect(layout.columns).toEqual({ files: 16, terminal: 54, agent: 30 });
  });

  it("独立切换面板并恢复显示组合，比例预设不改变开关", () => {
    const layout = useWorkspaceLayoutStore();
    layout.togglePanel("files");
    layout.togglePanel("agent");
    layout.applyPreset("balanced");
    expect(layout.visiblePanels).toEqual({ files: false, terminal: true, agent: false });
    setActivePinia(createPinia());
    const restored = useWorkspaceLayoutStore();
    restored.hydrate();
    expect(restored.visiblePanels).toEqual(layout.visiblePanels);
    restored.togglePanel("terminal");
    expect(Object.values(restored.visiblePanels).some(Boolean)).toBe(false);
    restored.togglePanel("files");
    expect(restored.visiblePanels.files).toBe(true);
  });
});
