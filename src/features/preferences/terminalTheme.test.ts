import { describe, expect, it, vi } from "vitest";
import { terminalThemeFromStyles } from "./terminalTheme";

const { readFileSync } = await vi.importActual<{
  readFileSync(path: string, encoding: "utf8"): string;
}>("node:fs");
const stylesCss = readFileSync("src/styles.css", "utf8");

const THEME_IDS = ["carbon", "midnight", "graphite", "plum", "porcelain", "mist"] as const;
const TERMINAL_COLOR_PROPERTIES = [
  "--terminal-bg",
  "--terminal-text",
  "--terminal-cursor",
  "--terminal-selection",
  "--terminal-black",
  "--terminal-red",
  "--terminal-green",
  "--terminal-yellow",
  "--terminal-blue",
  "--terminal-magenta",
  "--terminal-cyan",
  "--terminal-white",
  "--terminal-bright-black",
  "--terminal-bright-red",
  "--terminal-bright-green",
  "--terminal-bright-yellow",
  "--terminal-bright-blue",
  "--terminal-bright-magenta",
  "--terminal-bright-cyan",
  "--terminal-bright-white",
] as const;

function parseHexVariables(block: string) {
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{3,8})\s*(?:;|$)/gi)]
      .map((match) => [match[1], match[2]]),
  );
}

function themeBlock(themeId: typeof THEME_IDS[number]) {
  if (themeId === "carbon") {
    const match = stylesCss.match(/:root\s*\{([\s\S]*?)\}/);
    if (!match) throw new Error("缺少 :root 主题块");
    return match[1];
  }
  const match = stylesCss.match(new RegExp(`:root\\[data-theme="${themeId}"\\]\\s*\\{([\\s\\S]*?)\\}`));
  if (!match) throw new Error(`缺少 ${themeId} 主题块`);
  return match[1];
}

function rgb(hex: string) {
  let value = hex.slice(1);
  if (value.length === 3) value = [...value].map((part) => `${part}${part}`).join("");
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
}

function luminance(hex: string) {
  const [red, green, blue] = rgb(hex).map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string) {
  const [bright, dark] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (bright + 0.05) / (dark + 0.05);
}

describe("terminal theme", () => {
  it("把所有 ANSI 色和光标对比色传给 xterm", () => {
    const values: Record<string, string> = {
      "--terminal-bg": "#010203",
      "--terminal-text": "#f1f2f3",
      "--terminal-cursor": "#abcdef",
      "--terminal-selection": "#123456",
      "--terminal-black": "#111111",
      "--terminal-red": "#ff1111",
      "--terminal-green": "#11ff11",
      "--terminal-yellow": "#ffff11",
      "--terminal-blue": "#1111ff",
      "--terminal-magenta": "#ff11ff",
      "--terminal-cyan": "#11ffff",
      "--terminal-white": "#eeeeee",
      "--terminal-bright-black": "#777777",
      "--terminal-bright-red": "#ff7777",
      "--terminal-bright-green": "#77ff77",
      "--terminal-bright-yellow": "#ffff77",
      "--terminal-bright-blue": "#7777ff",
      "--terminal-bright-magenta": "#ff77ff",
      "--terminal-bright-cyan": "#77ffff",
      "--terminal-bright-white": "#ffffff",
    };
    const theme = terminalThemeFromStyles({ getPropertyValue: (property) => values[property] ?? "" });

    expect(theme).toMatchObject({
      background: "#010203",
      foreground: "#f1f2f3",
      cursor: "#abcdef",
      cursorAccent: "#010203",
      selectionBackground: "#123456",
      black: "#111111",
      brightBlack: "#777777",
      brightWhite: "#ffffff",
    });
  });

  it("六套主题都显式定义完整终端色板", () => {
    for (const themeId of THEME_IDS) {
      const variables = parseHexVariables(themeBlock(themeId));
      for (const property of TERMINAL_COLOR_PROPERTIES) {
        expect(variables[property], `${themeId} 缺少 ${property}`).toMatch(/^#/);
      }
    }
  });

  it("六套主题的次要文字与终端 ANSI 颜色达到 WCAG AA 对比度", () => {
    for (const themeId of THEME_IDS) {
      const variables = parseHexVariables(themeBlock(themeId));
      expect(contrast(variables["--dim"], variables["--bg"]), `${themeId} --dim / --bg`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(variables["--dim"], variables["--panel"]), `${themeId} --dim / --panel`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(variables["--dim"], variables["--raised"]), `${themeId} --dim / --raised`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(variables["--terminal-text"], variables["--terminal-bg"]), `${themeId} terminal text`).toBeGreaterThanOrEqual(7);

      for (const property of TERMINAL_COLOR_PROPERTIES.slice(5)) {
        expect(
          contrast(variables[property], variables["--terminal-bg"]),
          `${themeId} ${property} / --terminal-bg`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("提供组件公用的语义表面、状态与浮层 token", () => {
    const root = themeBlock("carbon");
    for (const property of [
      "--page", "--surface", "--secondary-text", "--accent-strong", "--danger",
      "--scrim", "--shadow-dialog", "--shadow-popover", "--focus-ring", "--disabled-opacity",
    ]) {
      expect(root, `缺少 ${property}`).toMatch(new RegExp(`${property}\\s*:`));
    }
  });
});
