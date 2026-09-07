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
});
