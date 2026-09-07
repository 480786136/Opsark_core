import { describe, expect, it } from "vitest";
import type { FileEntry } from "@/types";
import { moveFileSelection, sortRemoteFiles, updateFileSelection } from "./fileWorkspace";

const entries: FileEntry[] = [
  { name: "z.log", path: "/z.log", kind: "file", size: "2 KB", modified: "20" },
  { name: "src", path: "/src", kind: "directory", size: "—", modified: "30" },
  { name: "a.log", path: "/a.log", kind: "file", size: "10 B", modified: "10" },
];

describe("fileWorkspace", () => {
  it("排序时保持目录优先并正确比较文件大小", () => {
    expect(sortRemoteFiles(entries, { key: "size", direction: "asc" }).map(({ name }) => name))
      .toEqual(["src", "a.log", "z.log"]);
    expect(sortRemoteFiles(entries, { key: "name", direction: "desc" }).map(({ name }) => name))
      .toEqual(["src", "z.log", "a.log"]);
  });

  it("支持单选、追加选择和连续区间选择", () => {
    const paths = ["/a", "/b", "/c", "/d"];
    let state = updateFileSelection({ selectedPaths: [], anchorPath: "" }, paths, "/b", { toggle: false, range: false });
    state = updateFileSelection(state, paths, "/d", { toggle: true, range: false });
    expect(state.selectedPaths).toEqual(["/b", "/d"]);
    state = updateFileSelection(state, paths, "/b", { toggle: false, range: true });
    expect(state.selectedPaths).toEqual(["/b", "/c", "/d"]);
  });

  it("将键盘选择限制在列表边界内", () => {
    expect(moveFileSelection("/a", ["/a", "/b"], -1)).toBe("/a");
    expect(moveFileSelection("/b", ["/a", "/b"], 1)).toBe("/b");
    expect(moveFileSelection("", ["/a", "/b"], 1)).toBe("/a");
  });
});
