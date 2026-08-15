import { describe, expect, it } from "vitest";
import {
  collectTerminalPaneIds,
  migrateFlatTerminalLayout,
  moveTerminalPane,
  moveTerminalPaneToEdge,
  normalizeTerminalLayout,
  removeTerminalPane,
  splitTerminalPane,
  updateTerminalSplitRatio,
} from "./terminalSplitTree";

function idFactory() {
  let index = 0;
  return () => `node-${index += 1}`;
}

describe("terminalSplitTree", () => {
  it("将平铺比例迁移为保持顺序的分屏树", () => {
    const layout = migrateFlatTerminalLayout(["a", "b", "c"], [30, 30, 40], "vertical", idFactory());
    expect(collectTerminalPaneIds(layout)).toEqual(["a", "b", "c"]);
    expect(layout).toMatchObject({ type: "split", direction: "vertical", ratio: 30 });
  });

  it("支持在叶子上创建不同方向的嵌套分屏", () => {
    let layout = migrateFlatTerminalLayout(["a"], [100], "vertical", idFactory());
    layout = splitTerminalPane(layout, "a", "b", "vertical", idFactory());
    layout = splitTerminalPane(layout, "b", "c", "horizontal", idFactory());
    expect(layout).toMatchObject({
      type: "split",
      direction: "vertical",
      second: { type: "split", direction: "horizontal" },
    });
  });

  it("删除叶子后提升兄弟节点并归并父分支", () => {
    let layout = migrateFlatTerminalLayout(["a"], [100], "vertical", idFactory());
    layout = splitTerminalPane(layout, "a", "b", "vertical", idFactory());
    layout = splitTerminalPane(layout, "b", "c", "horizontal", idFactory());
    expect(collectTerminalPaneIds(removeTerminalPane(layout, "b")!)).toEqual(["a", "c"]);
    expect(collectTerminalPaneIds(removeTerminalPane(layout, "a")!)).toEqual(["b", "c"]);
  });

  it("移动叶子时交换相邻位置并保留树结构", () => {
    const layout = migrateFlatTerminalLayout(["a", "b", "c"], [30, 30, 40], "vertical", idFactory());
    expect(collectTerminalPaneIds(moveTerminalPane(layout, "b", -1)!)).toEqual(["b", "a", "c"]);
    expect(moveTerminalPane(layout, "a", -1)).toBeUndefined();
  });

  it("将叶子跨分支移动到目标边缘并保留源节点标识", () => {
    let layout = migrateFlatTerminalLayout(["a"], [100], "vertical", idFactory());
    layout = splitTerminalPane(layout, "a", "b", "vertical", idFactory());
    layout = splitTerminalPane(layout, "b", "c", "horizontal", idFactory());
    const sourceNode = layout.type === "split" && layout.second.type === "split"
      ? layout.second.second
      : undefined;
    const moved = moveTerminalPaneToEdge(layout, "c", "a", "top", idFactory())!;

    expect(moved).toMatchObject({
      type: "split",
      direction: "vertical",
      first: {
        type: "split",
        direction: "horizontal",
        first: { type: "pane", paneId: "c", id: sourceNode?.id },
        second: { type: "pane", paneId: "a" },
      },
    });
    expect(collectTerminalPaneIds(moved)).toEqual(["c", "a", "b"]);
  });

  it("拒绝投放到自身或不存在的目标叶子", () => {
    const layout = migrateFlatTerminalLayout(["a", "b"], [50, 50], "vertical", idFactory());
    expect(moveTerminalPaneToEdge(layout, "a", "a", "left", idFactory())).toBeUndefined();
    expect(moveTerminalPaneToEdge(layout, "a", "missing", "right", idFactory())).toBeUndefined();
  });

  it("限制分支比例并拒绝缺失叶子的持久化树", () => {
    const fallback = migrateFlatTerminalLayout(["a", "b"], [50, 50], "vertical", idFactory());
    const resized = updateTerminalSplitRatio(fallback, fallback.id, 99);
    expect(resized).toMatchObject({ ratio: 85 });
    expect(normalizeTerminalLayout({ type: "pane", id: "only", paneId: "a" }, ["a", "b"], () => fallback))
      .toBe(fallback);
  });
});
