import { normalizeTerminalPaneSizes } from "./terminalPaneLayout";

export type TerminalSplitDirection = "horizontal" | "vertical";
export type TerminalDropEdge = "left" | "right" | "top" | "bottom";

export interface TerminalPaneNode {
  type: "pane";
  id: string;
  paneId: string;
}

export interface TerminalSplitNode {
  type: "split";
  id: string;
  direction: TerminalSplitDirection;
  ratio: number;
  first: TerminalLayoutNode;
  second: TerminalLayoutNode;
}

export type TerminalLayoutNode = TerminalPaneNode | TerminalSplitNode;

export const MIN_TERMINAL_SPLIT_RATIO = 15;

function clampRatio(ratio: number) {
  return Math.min(100 - MIN_TERMINAL_SPLIT_RATIO, Math.max(MIN_TERMINAL_SPLIT_RATIO, ratio));
}

export function createTerminalPaneNode(
  paneId: string,
  createId: () => string = () => crypto.randomUUID(),
): TerminalPaneNode {
  return { type: "pane", id: createId(), paneId };
}

export function collectTerminalPaneIds(node: TerminalLayoutNode): string[] {
  return node.type === "pane"
    ? [node.paneId]
    : [...collectTerminalPaneIds(node.first), ...collectTerminalPaneIds(node.second)];
}

/** 将旧平铺布局转换为同方向右嵌套树，保持叶子顺序与全局比例。 */
export function migrateFlatTerminalLayout(
  paneIds: string[],
  paneSizes: unknown,
  direction: TerminalSplitDirection,
  createId: () => string = () => crypto.randomUUID(),
): TerminalLayoutNode {
  if (!paneIds.length) throw new Error("TERMINAL_LAYOUT_REQUIRES_PANE");
  const sizes = normalizeTerminalPaneSizes(paneSizes, paneIds.length);
  const build = (index: number): TerminalLayoutNode => {
    const first = createTerminalPaneNode(paneIds[index], createId);
    if (index === paneIds.length - 1) return first;
    const remainingTotal = sizes.slice(index).reduce((sum, size) => sum + size, 0);
    return {
      type: "split",
      id: createId(),
      direction,
      ratio: clampRatio(sizes[index] / remainingTotal * 100),
      first,
      second: build(index + 1),
    };
  };
  return build(0);
}

function parseLayoutNode(value: unknown, nodeIds: Set<string>, paneIds: Set<string>): TerminalLayoutNode | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || nodeIds.has(candidate.id)) return undefined;
  nodeIds.add(candidate.id);
  if (candidate.type === "pane") {
    if (typeof candidate.paneId !== "string" || paneIds.has(candidate.paneId)) return undefined;
    paneIds.add(candidate.paneId);
    return { type: "pane", id: candidate.id, paneId: candidate.paneId };
  }
  if (
    candidate.type !== "split"
    || (candidate.direction !== "horizontal" && candidate.direction !== "vertical")
    || typeof candidate.ratio !== "number"
    || !Number.isFinite(candidate.ratio)
    || candidate.ratio < MIN_TERMINAL_SPLIT_RATIO
    || candidate.ratio > 100 - MIN_TERMINAL_SPLIT_RATIO
  ) return undefined;
  const first = parseLayoutNode(candidate.first, nodeIds, paneIds);
  const second = parseLayoutNode(candidate.second, nodeIds, paneIds);
  if (!first || !second) return undefined;
  return {
    type: "split",
    id: candidate.id,
    direction: candidate.direction,
    ratio: candidate.ratio,
    first,
    second,
  };
}

export function normalizeTerminalLayout(
  value: unknown,
  expectedPaneIds: string[],
  fallback: () => TerminalLayoutNode,
): TerminalLayoutNode {
  const paneIds = new Set<string>();
  const parsed = parseLayoutNode(value, new Set<string>(), paneIds);
  const expected = new Set(expectedPaneIds);
  if (
    !parsed
    || paneIds.size !== expected.size
    || [...paneIds].some((paneId) => !expected.has(paneId))
  ) return fallback();
  return parsed;
}

export function splitTerminalPane(
  node: TerminalLayoutNode,
  targetPaneId: string,
  newPaneId: string,
  direction: TerminalSplitDirection,
  createId: () => string = () => crypto.randomUUID(),
): TerminalLayoutNode {
  if (node.type === "pane") {
    if (node.paneId !== targetPaneId) return node;
    return {
      type: "split",
      id: createId(),
      direction,
      ratio: 50,
      first: node,
      second: createTerminalPaneNode(newPaneId, createId),
    };
  }
  return {
    ...node,
    first: splitTerminalPane(node.first, targetPaneId, newPaneId, direction, createId),
    second: splitTerminalPane(node.second, targetPaneId, newPaneId, direction, createId),
  };
}

export function removeTerminalPane(node: TerminalLayoutNode, paneId: string): TerminalLayoutNode | undefined {
  if (node.type === "pane") return node.paneId === paneId ? undefined : node;
  const first = removeTerminalPane(node.first, paneId);
  const second = removeTerminalPane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function updateTerminalSplitRatio(
  node: TerminalLayoutNode,
  splitNodeId: string,
  ratio: number,
): TerminalLayoutNode {
  if (node.type === "pane") return node;
  if (node.id === splitNodeId) return { ...node, ratio: clampRatio(ratio) };
  return {
    ...node,
    first: updateTerminalSplitRatio(node.first, splitNodeId, ratio),
    second: updateTerminalSplitRatio(node.second, splitNodeId, ratio),
  };
}

function swapPaneReferences(node: TerminalLayoutNode, firstPaneId: string, secondPaneId: string): TerminalLayoutNode {
  if (node.type === "pane") {
    if (node.paneId === firstPaneId) return { ...node, paneId: secondPaneId };
    if (node.paneId === secondPaneId) return { ...node, paneId: firstPaneId };
    return node;
  }
  return {
    ...node,
    first: swapPaneReferences(node.first, firstPaneId, secondPaneId),
    second: swapPaneReferences(node.second, firstPaneId, secondPaneId),
  };
}

/** 移动通过交换相邻叶子引用实现，PTY 身份和分支比例均保持不变。 */
export function moveTerminalPane(
  node: TerminalLayoutNode,
  paneId: string,
  offset: -1 | 1,
): TerminalLayoutNode | undefined {
  const paneIds = collectTerminalPaneIds(node);
  const index = paneIds.indexOf(paneId);
  const targetIndex = index + offset;
  if (index < 0 || targetIndex < 0 || targetIndex >= paneIds.length) return undefined;
  return swapPaneReferences(node, paneId, paneIds[targetIndex]);
}

function findTerminalPaneNode(
  node: TerminalLayoutNode,
  paneId: string,
): TerminalPaneNode | undefined {
  if (node.type === "pane") return node.paneId === paneId ? node : undefined;
  return findTerminalPaneNode(node.first, paneId) ?? findTerminalPaneNode(node.second, paneId);
}

function insertTerminalPaneAtEdge(
  node: TerminalLayoutNode,
  targetPaneId: string,
  sourcePane: TerminalPaneNode,
  edge: TerminalDropEdge,
  createId: () => string,
): TerminalLayoutNode {
  if (node.type === "pane") {
    if (node.paneId !== targetPaneId) return node;
    const sourceFirst = edge === "left" || edge === "top";
    return {
      type: "split",
      id: createId(),
      direction: edge === "left" || edge === "right" ? "vertical" : "horizontal",
      ratio: 50,
      first: sourceFirst ? sourcePane : node,
      second: sourceFirst ? node : sourcePane,
    };
  }
  return {
    ...node,
    first: insertTerminalPaneAtEdge(node.first, targetPaneId, sourcePane, edge, createId),
    second: insertTerminalPaneAtEdge(node.second, targetPaneId, sourcePane, edge, createId),
  };
}

/**
 * 将已有终端叶子移动到目标叶子的指定边缘。
 *
 * 移动时保留源叶子的节点标识和 PTY 标识；源分支先自动折叠，再在目标位置创建
 * 新的二叉分支，因此同一算法可以处理同分支换位和跨分支移动。
 */
export function moveTerminalPaneToEdge(
  node: TerminalLayoutNode,
  sourcePaneId: string,
  targetPaneId: string,
  edge: TerminalDropEdge,
  createId: () => string = () => crypto.randomUUID(),
): TerminalLayoutNode | undefined {
  if (sourcePaneId === targetPaneId) return undefined;
  const sourcePane = findTerminalPaneNode(node, sourcePaneId);
  if (!sourcePane || !findTerminalPaneNode(node, targetPaneId)) return undefined;
  const layoutWithoutSource = removeTerminalPane(node, sourcePaneId);
  if (!layoutWithoutSource) return undefined;
  return insertTerminalPaneAtEdge(
    layoutWithoutSource,
    targetPaneId,
    sourcePane,
    edge,
    createId,
  );
}
