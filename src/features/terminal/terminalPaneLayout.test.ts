import { describe, expect, it } from "vitest";
import {
  equalTerminalPaneSizes,
  normalizeTerminalPaneSizes,
} from "./terminalPaneLayout";

describe("terminalPaneLayout", () => {
  it("生成总和为 100 的等比分屏", () => {
    const sizes = equalTerminalPaneSizes(3);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(100);
  });

  it("拒绝非法或低于最小值的持久化比例", () => {
    expect(normalizeTerminalPaneSizes([5, 95], 2)).toEqual([50, 50]);
    expect(normalizeTerminalPaneSizes(["bad", 50], 2)).toEqual([50, 50]);
  });
});
