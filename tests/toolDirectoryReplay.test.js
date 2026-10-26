import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildToolContext } from "../src/features/tools/toolContext";
import { resolveToolRegistry } from "../src/features/tools/toolRegistry";

describe("跨语言规划目录离线证据", () => {
  it("显式导出实际编译目录供Rust回放，默认运行不写文件", () => {
    const tools = buildToolContext(resolveToolRegistry([]));
    expect(tools.filter(tool => tool.requiresTargetChange).map(tool => tool.id)).toEqual([
      "files.transfer_between_servers", "files.confirm_deletion", "files.delete_confirmed",
    ]);
    if (process.env.OPSARK_G13_TOOL_CATALOG_EXPORT) {
      writeFileSync(process.env.OPSARK_G13_TOOL_CATALOG_EXPORT,
        JSON.stringify({ version: 1, tools }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    }
  });
});
