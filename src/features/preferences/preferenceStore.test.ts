// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "./i18n";
import { usePreferenceStore } from "./preferenceStore";

describe("preferenceStore", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.removeAttribute("data-surface");
    document.documentElement.removeAttribute("data-terminal-theme");
    setActivePinia(createPinia());
  });

  it("在启动时恢复语言和强调色", () => {
    localStorage.setItem("opsark.preferences.v1", JSON.stringify({
      locale: "en-US",
      accentTheme: "cyan",
      surfaceTheme: "ink",
      terminalColorTheme: "aurora",
      terminalFontSize: 15,
      terminalLineHeight: 1.6,
      terminalShortcutPreset: "vscode",
    }));

    const preferences = usePreferenceStore();
    preferences.hydrate();

    expect(preferences.locale).toBe("en-US");
    expect(i18n.global.locale.value).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    expect(document.documentElement.dataset.accent).toBe("cyan");
    expect(document.documentElement.dataset.surface).toBe("ink");
    expect(document.documentElement.dataset.terminalTheme).toBe("aurora");
    expect(preferences.terminalFontSize).toBe(15);
    expect(preferences.terminalLineHeight).toBe(1.6);
    expect(preferences.terminalShortcutPreset).toBe("vscode");
  });

  it("忽略损坏或未知的本地配置", () => {
    localStorage.setItem("opsark.preferences.v1", JSON.stringify({
      locale: "unknown",
      accentTheme: "purple",
      surfaceTheme: "unknown",
      terminalColorTheme: "unknown",
      terminalFontSize: 99,
      terminalLineHeight: -1,
    }));

    const preferences = usePreferenceStore();
    preferences.hydrate();

    expect(preferences.locale).toBe("zh-CN");
    expect(preferences.accentTheme).toBe("lime");
    expect(preferences.surfaceTheme).toBe("carbon");
    expect(preferences.terminalColorTheme).toBe("opsark");
    expect(preferences.terminalFontSize).toBe(18);
    expect(preferences.terminalLineHeight).toBe(1);
  });

  it("支持明亮界面主题且不改变独立终端配色", () => {
    const preferences = usePreferenceStore();
    preferences.hydrate();
    preferences.setTerminalColorTheme("aurora");
    preferences.setSurfaceTheme("porcelain");

    expect(preferences.surfaceTheme).toBe("porcelain");
    expect(preferences.terminalColorTheme).toBe("aurora");
    expect(document.documentElement.dataset.surface).toBe("porcelain");
    expect(document.documentElement.dataset.terminalTheme).toBe("aurora");
  });
});
