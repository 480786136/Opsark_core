import { describe, expect, it } from "vitest";
import { providedToolEvidence, requiredToolEvidence } from "./toolEvidenceCapability";
import { defaultToolCatalog } from "./toolCatalog";
import type { ToolDefinition } from "./types";

const reader = defaultToolCatalog.find(t => t.id === "files.read_content")!;
const metadata = defaultToolCatalog.find(t => t.id === "files.preview_deletion")!;
const text = (expected: string, description = "读取配置") => ({ expected, description });

describe("第二十五批：证据种类与旧版预期的有限兼容", () => {
  it.each([
    "获得配置B正文及读取完整性信息，确定最小修改方式；本步骤不执行修改。",
    "获得文件内容，不修改文件。",
    "不修改文件，但读取配置正文。",
    "读取配置正文并保留真实结果。",
    "Read the configuration file content without changing it.",
    "Returns file text; do not change files.",
    "Obtain configuration body and integrity information.",
  ])("识别当前结果的明确正文承诺：%s", expected => {
    expect(requiredToolEvidence(text(expected))).toEqual(["file_content"]);
  });
  it.each([
    "获得路径、大小和摘要，不含配置正文。",
    "仅读取文件元数据，不读取配置正文。",
    "获得元数据，下一步读取文件正文。",
    "获取文件摘要；随后读取配置正文。",
    "Do not read configuration content; return file metadata.",
    "Return file metadata without reading file content.",
    "Return file metadata; next read configuration content.",
    "获取文件正文的路径和大小。",
    "返回配置内容摘要及SHA-256。",
    "Return the file content checksum.",
    "Read text file metadata.",
  ])("否定及未来工作不会强制当前工具读取正文：%s", expected => {
    expect(requiredToolEvidence(text(expected))).toEqual([]);
  });
  it("不从用户任务、标题或别的步骤推定当前预检必须返回正文", () => {
    expect(requiredToolEvidence(text("获得文件大小和SHA-256", "为后续配置修改做预检"))).toEqual([]);
    expect(requiredToolEvidence(text("获取HTTP响应正文", "查询站点状态"))).toEqual([]);
    // Explicit limitation: ambiguous outcomes are not silently promoted to
    // authoritative evidence declarations by a keyword heuristic.
    expect(requiredToolEvidence(text("结果正确", "读取配置"))).toEqual([]);
  });
  it("能力依赖必填、顶层、字符串path/content，而非工具ID或说明", () => {
    expect(providedToolEvidence(metadata)).toEqual([]);
    expect(providedToolEvidence({ ...reader, id: "fixture.alternate", outputDescription: "其他语言" })).toEqual(["file_content"]);
    for (const outputSchema of [
      undefined,
      { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path"] },
      { type: "object", properties: { path: { type: "string" }, content: { type: "number" } }, required: ["path", "content"] },
      { type: "object", properties: { data: reader.outputSchema }, required: ["data"] },
    ]) expect(providedToolEvidence({ ...reader, outputSchema } as ToolDefinition)).toEqual([]);
  });
});
