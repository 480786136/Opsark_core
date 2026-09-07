import { defineStore } from "pinia";
import { i18n, type AppLocale } from "./i18n";

export type SystemTheme = "carbon" | "midnight" | "graphite" | "plum" | "porcelain" | "mist";
export type TerminalShortcutPreset = "platform" | "vscode";

export interface SystemThemeDefinition {
  id: SystemTheme;
  labelKey: `appearance.${SystemTheme}`;
  descriptionKey: `appearance.${SystemTheme}Description`;
  dark: boolean;
  preview: [string, string, string, string];
}

export const systemThemes: SystemThemeDefinition[] = [
  { id: "carbon", labelKey: "appearance.carbon", descriptionKey: "appearance.carbonDescription", dark: true, preview: ["#0b0d10", "#171b21", "#d9f763", "#0a0d10"] },
  { id: "midnight", labelKey: "appearance.midnight", descriptionKey: "appearance.midnightDescription", dark: true, preview: ["#07111c", "#101e2d", "#55d8ff", "#050d16"] },
  { id: "graphite", labelKey: "appearance.graphite", descriptionKey: "appearance.graphiteDescription", dark: true, preview: ["#121314", "#202327", "#ffc45c", "#0d0f11"] },
  { id: "plum", labelKey: "appearance.plum", descriptionKey: "appearance.plumDescription", dark: true, preview: ["#120d16", "#211827", "#ff77a8", "#0d0910"] },
  { id: "porcelain", labelKey: "appearance.porcelain", descriptionKey: "appearance.porcelainDescription", dark: false, preview: ["#f3f5f7", "#ffffff", "#2864c7", "#f7f8fa"] },
  { id: "mist", labelKey: "appearance.mist", descriptionKey: "appearance.mistDescription", dark: false, preview: ["#edf4f3", "#fbfdfc", "#087d72", "#edf5f3"] },
];

const STORAGE_KEY = "opsark.preferences.v1";

function isLocale(value: unknown): value is AppLocale {
  return value === "zh-CN" || value === "en-US";
}

function isSystemTheme(value: unknown): value is SystemTheme {
  return systemThemes.some((theme) => theme.id === value);
}

function migrateLegacyTheme(parsed: Record<string, unknown>): SystemTheme {
  if (parsed.surfaceTheme === "porcelain") return "porcelain";
  if (parsed.surfaceTheme === "mist") return "mist";
  if (parsed.surfaceTheme === "graphite" || parsed.accentTheme === "amber") return "graphite";
  if (parsed.surfaceTheme === "ink" || parsed.accentTheme === "rose" || parsed.accentTheme === "coral") return "plum";
  if (parsed.accentTheme === "cyan" || parsed.terminalColorTheme === "aurora") return "midnight";
  return "carbon";
}

function isShortcutPreset(value: unknown): value is TerminalShortcutPreset {
  return value === "platform" || value === "vscode";
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function applyPreferences(locale: AppLocale, systemTheme: SystemTheme) {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  document.documentElement.dataset.theme = systemTheme;
  delete document.documentElement.dataset.accent;
  delete document.documentElement.dataset.surface;
  delete document.documentElement.dataset.terminalTheme;
}

export const usePreferenceStore = defineStore("preferences", {
  state: () => ({
    locale: "zh-CN" as AppLocale,
    systemTheme: "carbon" as SystemTheme,
    terminalFontSize: 12,
    terminalLineHeight: 1.35,
    terminalShortcutPreset: "platform" as TerminalShortcutPreset,
  }),
  actions: {
    hydrate() {
      try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
        if (isLocale(parsed.locale)) this.locale = parsed.locale;
        this.systemTheme = isSystemTheme(parsed.systemTheme) ? parsed.systemTheme : migrateLegacyTheme(parsed);
        this.terminalFontSize = boundedNumber(parsed.terminalFontSize, 10, 18, 12);
        this.terminalLineHeight = boundedNumber(parsed.terminalLineHeight, 1, 1.8, 1.35);
        if (isShortcutPreset(parsed.terminalShortcutPreset)) this.terminalShortcutPreset = parsed.terminalShortcutPreset;
      } catch {
        // 本地配置损坏时使用稳定默认值，不阻断应用启动。
      }
      this.apply();
    },
    setLocale(locale: AppLocale) {
      this.locale = locale;
      this.persist();
    },
    setSystemTheme(systemTheme: SystemTheme) {
      this.systemTheme = systemTheme;
      this.persist();
    },
    setTerminalTypography(fontSize: number, lineHeight: number) {
      this.terminalFontSize = boundedNumber(fontSize, 10, 18, 12);
      this.terminalLineHeight = boundedNumber(lineHeight, 1, 1.8, 1.35);
      this.persist();
    },
    setTerminalShortcutPreset(terminalShortcutPreset: TerminalShortcutPreset) {
      this.terminalShortcutPreset = terminalShortcutPreset;
      this.persist();
    },
    apply() {
      applyPreferences(this.locale, this.systemTheme);
    },
    persist() {
      this.apply();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        locale: this.locale,
        systemTheme: this.systemTheme,
        terminalFontSize: this.terminalFontSize,
        terminalLineHeight: this.terminalLineHeight,
        terminalShortcutPreset: this.terminalShortcutPreset,
      }));
    },
  },
});
