// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "./i18n";
import { usePreferenceStore } from "./preferenceStore";

describe("preferenceStore", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.removeAttribute("data-surface");
    document.documentElement.removeAttribute("data-terminal-theme");
    setActivePinia(createPinia());
  });

  it("恢复统一系统主题和终端偏好", () => {
    localStorage.setItem("opsark.preferences.v1", JSON.stringify({
      locale: "en-US",
      systemTheme: "midnight",
      terminalFontSize: 15,
      terminalLineHeight: 1.6,
      terminalShortcutPreset: "vscode",
    }));

    const preferences = usePreferenceStore();
    preferences.hydrate();

    expect(preferences.locale).toBe("en-US");
    expect(i18n.global.locale.value).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    expect(preferences.systemTheme).toBe("midnight");
    expect(document.documentElement.dataset.theme).toBe("midnight");
    expect(preferences.terminalFontSize).toBe(15);
    expect(preferences.terminalLineHeight).toBe(1.6);
    expect(preferences.terminalShortcutPreset).toBe("vscode");
  });

  it("将旧版分散主题配置迁移到最接近的系统主题", () => {
    localStorage.setItem("opsark.preferences.v1", JSON.stringify({
      accentTheme: "cyan",
      surfaceTheme: "carbon",
      terminalColorTheme: "aurora",
    }));

    const preferences = usePreferenceStore();
    preferences.hydrate();

    expect(preferences.systemTheme).toBe("midnight");
    expect(document.documentElement.dataset.theme).toBe("midnight");
    expect(document.documentElement.dataset.accent).toBeUndefined();
    expect(document.documentElement.dataset.surface).toBeUndefined();
    expect(document.documentElement.dataset.terminalTheme).toBeUndefined();
  });

  it("忽略未知配置并限制终端排版范围", () => {
    localStorage.setItem("opsark.preferences.v1", JSON.stringify({
      locale: "unknown",
      systemTheme: "unknown",
      terminalFontSize: 99,
      terminalLineHeight: -1,
    }));

    const preferences = usePreferenceStore();
    preferences.hydrate();

    expect(preferences.locale).toBe("zh-CN");
    expect(preferences.systemTheme).toBe("carbon");
    expect(preferences.terminalFontSize).toBe(18);
    expect(preferences.terminalLineHeight).toBe(1);
  });

  it("持久化主题时只写入统一主题字段", () => {
    const preferences = usePreferenceStore();
    preferences.hydrate();
    preferences.setSystemTheme("porcelain");

    const saved = JSON.parse(localStorage.getItem("opsark.preferences.v1") ?? "{}");
    expect(saved.systemTheme).toBe("porcelain");
    expect(saved.accentTheme).toBeUndefined();
    expect(saved.surfaceTheme).toBeUndefined();
    expect(saved.terminalColorTheme).toBeUndefined();
  });
});
