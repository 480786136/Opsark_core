export const MIN_TERMINAL_PANE_PERCENT = 15;

function roundPercent(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function equalTerminalPaneSizes(count: number): number[] {
  if (count <= 0) return [];
  const size = 100 / count;
  const sizes = Array.from({ length: count }, () => roundPercent(size));
  sizes[count - 1] = roundPercent(100 - sizes.slice(0, -1).reduce((sum, item) => sum + item, 0));
  return sizes;
}

/** 将不可信持久化数据归一化为总和 100 的稳定比例。 */
export function normalizeTerminalPaneSizes(values: unknown, count: number): number[] {
  if (!Array.isArray(values) || values.length !== count) return equalTerminalPaneSizes(count);
  const sizes = values.map(Number);
  if (sizes.some((size) => !Number.isFinite(size) || size < MIN_TERMINAL_PANE_PERCENT)) {
    return equalTerminalPaneSizes(count);
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return equalTerminalPaneSizes(count);
  const normalized = sizes.map((size) => roundPercent(size / total * 100));
  normalized[count - 1] = roundPercent(100 - normalized.slice(0, -1).reduce((sum, size) => sum + size, 0));
  return normalized.some((size) => size < MIN_TERMINAL_PANE_PERCENT)
    ? equalTerminalPaneSizes(count)
    : normalized;
}
