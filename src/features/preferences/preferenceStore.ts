import { defineStore } from "pinia";
import { i18n, type AppLocale } from "./i18n";

export type AccentTheme = "lime" | "cyan" | "coral" | "frost" | "amber" | "rose";
export type SurfaceTheme = "carbon" | "ink" | "graphite" | "porcelain" | "mist";
export type TerminalColorTheme = "opsark" | "aurora" | "paper";
export type TerminalShortcutPreset = "platform" | "vscode";

export interface AccentThemeDefinition {
  id: AccentTheme;
  color: string;
  labelKey: `appearance.${AccentTheme}`;
}

export const accentThemes: AccentThemeDefinition[] = [
  { id: "lime", color: "#d8ff5f", labelKey: "appearance.lime" },
  { id: "cyan", color: "#52e5ff", labelKey: "appearance.cyan" },
  { id: "coral", color: "#ff786f", labelKey: "appearance.coral" },
  { id: "frost", color: "#f2f5f7", labelKey: "appearance.frost" },
  { id: "amber", color: "#ffc857", labelKey: "appearance.amber" },
  { id: "rose", color: "#ff6f91", labelKey: "appearance.rose" },
];

const STORAGE_KEY = "opsark.preferences.v1";

function isLocale(value: unknown): value is AppLocale {
  return value === "zh-CN" || value === "en-US";
}

function isAccentTheme(value: unknown): value is AccentTheme {
  return accentThemes.some((theme) => theme.id === value);
}

function isSurfaceTheme(value: unknown): value is SurfaceTheme {
  return value === "carbon"
    || value === "ink"
    || value === "graphite"
    || value === "porcelain"
    || value === "mist";
}

function isTerminalColorTheme(value: unknown): value is TerminalColorTheme {
  return value === "opsark" || value === "aurora" || value === "paper";
}

function isShortcutPreset(value: unknown): value is TerminalShortcutPreset {
  return value === "platform" || value === "vscode";
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function applyPreferences(locale: AppLocale, accentTheme: AccentTheme, surfaceTheme: SurfaceTheme, terminalColorTheme: TerminalColorTheme) {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
  document.documentElement.dataset.accent = accentTheme;
  document.documentElement.dataset.surface = surfaceTheme;
  document.documentElement.dataset.terminalTheme = terminalColorTheme;
}

export const usePreferenceStore = defineStore("preferences", {
  state: () => ({
    locale: "zh-CN" as AppLocale,
    accentTheme: "lime" as AccentTheme,
    surfaceTheme: "carbon" as SurfaceTheme,
    terminalColorTheme: "opsark" as TerminalColorTheme,
    terminalFontSize: 12,
    terminalLineHeight: 1.35,
    terminalShortcutPreset: "platform" as TerminalShortcutPreset,
  }),
  actions: {
    hydrate() {
      try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
        if (isLocale(parsed.locale)) this.locale = parsed.locale;
        if (isAccentTheme(parsed.accentTheme)) this.accentTheme = parsed.accentTheme;
        if (isSurfaceTheme(parsed.surfaceTheme)) this.surfaceTheme = parsed.surfaceTheme;
        if (isTerminalColorTheme(parsed.terminalColorTheme)) this.terminalColorTheme = parsed.terminalColorTheme;
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
    setAccentTheme(accentTheme: AccentTheme) {
      this.accentTheme = accentTheme;
      this.persist();
    },
    setSurfaceTheme(surfaceTheme: SurfaceTheme) {
      this.surfaceTheme = surfaceTheme;
      this.persist();
    },
    setTerminalColorTheme(terminalColorTheme: TerminalColorTheme) {
      this.terminalColorTheme = terminalColorTheme;
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
      applyPreferences(this.locale, this.accentTheme, this.surfaceTheme, this.terminalColorTheme);
    },
    persist() {
      this.apply();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        locale: this.locale,
        accentTheme: this.accentTheme,
        surfaceTheme: this.surfaceTheme,
        terminalColorTheme: this.terminalColorTheme,
        terminalFontSize: this.terminalFontSize,
        terminalLineHeight: this.terminalLineHeight,
        terminalShortcutPreset: this.terminalShortcutPreset,
      }));
    },
  },
});
