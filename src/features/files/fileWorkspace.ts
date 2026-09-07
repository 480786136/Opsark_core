import type { FileEntry } from "@/types";

export type FileSortKey = "name" | "size" | "modified";
export type SortDirection = "asc" | "desc";

export interface FileSortState {
  key: FileSortKey;
  direction: SortDirection;
}

export interface SelectionModifiers {
  toggle: boolean;
  range: boolean;
}

export interface FileSelectionState {
  selectedPaths: string[];
  anchorPath: string;
}

function parseFileSize(value: string): number {
  const match = value.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return 0;
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  const multiplier = multipliers[unit] ?? 1;
  return Number(match[1]) * multiplier;
}

function compareEntries(left: FileEntry, right: FileEntry, key: FileSortKey): number {
  if (key === "size") return parseFileSize(left.size) - parseFileSize(right.size);
  if (key === "modified") {
    const leftTimestamp = Number(left.modified);
    const rightTimestamp = Number(right.modified);
    if (Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp)) return leftTimestamp - rightTimestamp;
  }
  return left[key].localeCompare(right[key], undefined, { numeric: true, sensitivity: "base" });
}

/** 所有排序均保持目录在文件之前，避免切换列后改变导航区的基本结构。 */
export function sortRemoteFiles(entries: FileEntry[], sort: FileSortState): FileEntry[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return compareEntries(left, right, sort.key) * direction;
  });
}

export function updateFileSelection(
  current: FileSelectionState,
  orderedPaths: string[],
  targetPath: string,
  modifiers: SelectionModifiers,
): FileSelectionState {
  if (modifiers.range && current.anchorPath) {
    const anchorIndex = orderedPaths.indexOf(current.anchorPath);
    const targetIndex = orderedPaths.indexOf(targetPath);
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const [start, end] = anchorIndex < targetIndex
        ? [anchorIndex, targetIndex]
        : [targetIndex, anchorIndex];
      return { selectedPaths: orderedPaths.slice(start, end + 1), anchorPath: current.anchorPath };
    }
  }
  if (modifiers.toggle) {
    const selected = new Set(current.selectedPaths);
    if (selected.has(targetPath)) selected.delete(targetPath);
    else selected.add(targetPath);
    return { selectedPaths: [...selected], anchorPath: targetPath };
  }
  return { selectedPaths: [targetPath], anchorPath: targetPath };
}

export function moveFileSelection(
  currentPath: string,
  orderedPaths: string[],
  offset: -1 | 1,
): string | undefined {
  if (!orderedPaths.length) return undefined;
  const currentIndex = orderedPaths.indexOf(currentPath);
  const nextIndex = currentIndex < 0
    ? 0
    : Math.min(orderedPaths.length - 1, Math.max(0, currentIndex + offset));
  return orderedPaths[nextIndex];
}
