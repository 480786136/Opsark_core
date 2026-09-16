import type { ITheme } from "@xterm/xterm";

type StyleReader = Pick<CSSStyleDeclaration, "getPropertyValue">;

const FALLBACKS = {
  background: "#0a0d10",
  foreground: "#cbd1d8",
  accent: "#d9f763",
  selection: "#394128",
  black: "#171b20",
  red: "#ff7b82",
  green: "#71db9b",
  yellow: "#eab866",
  blue: "#77a9ff",
  magenta: "#c69cff",
  cyan: "#65d9e8",
  white: "#d9dde2",
  brightBlack: "#717b87",
  brightRed: "#ff9ca1",
  brightGreen: "#9ce8b7",
  brightYellow: "#f3ca83",
  brightBlue: "#9abfff",
  brightMagenta: "#d8bcff",
  brightCyan: "#96e8f2",
  brightWhite: "#f7f9fa",
} as const;

function color(styles: StyleReader, name: string, fallback: string) {
  return styles.getPropertyValue(name).trim() || fallback;
}

export function terminalThemeFromStyles(styles: StyleReader): ITheme {
  const background = color(styles, "--terminal-bg", FALLBACKS.background);
  return {
    background,
    foreground: color(styles, "--terminal-text", FALLBACKS.foreground),
    cursor: color(styles, "--terminal-cursor", color(styles, "--accent", FALLBACKS.accent)),
    cursorAccent: background,
    selectionBackground: color(styles, "--terminal-selection", FALLBACKS.selection),
    black: color(styles, "--terminal-black", FALLBACKS.black),
    red: color(styles, "--terminal-red", FALLBACKS.red),
    green: color(styles, "--terminal-green", FALLBACKS.green),
    yellow: color(styles, "--terminal-yellow", FALLBACKS.yellow),
    blue: color(styles, "--terminal-blue", FALLBACKS.blue),
    magenta: color(styles, "--terminal-magenta", FALLBACKS.magenta),
    cyan: color(styles, "--terminal-cyan", FALLBACKS.cyan),
    white: color(styles, "--terminal-white", FALLBACKS.white),
    brightBlack: color(styles, "--terminal-bright-black", FALLBACKS.brightBlack),
    brightRed: color(styles, "--terminal-bright-red", FALLBACKS.brightRed),
    brightGreen: color(styles, "--terminal-bright-green", FALLBACKS.brightGreen),
    brightYellow: color(styles, "--terminal-bright-yellow", FALLBACKS.brightYellow),
    brightBlue: color(styles, "--terminal-bright-blue", FALLBACKS.brightBlue),
    brightMagenta: color(styles, "--terminal-bright-magenta", FALLBACKS.brightMagenta),
    brightCyan: color(styles, "--terminal-bright-cyan", FALLBACKS.brightCyan),
    brightWhite: color(styles, "--terminal-bright-white", FALLBACKS.brightWhite),
  };
}

export function readTerminalTheme(root: Element = document.documentElement): ITheme {
  return terminalThemeFromStyles(getComputedStyle(root));
}

export function readTerminalFontFamily(root: Element = document.documentElement) {
  return getComputedStyle(root).getPropertyValue("--font-mono").trim()
    || 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace';
}

export const TERMINAL_THEME_ATTRIBUTE_FILTER = ["data-theme"] as const;
