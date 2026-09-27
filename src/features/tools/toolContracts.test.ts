import { describe, expect, it } from "vitest";
import contracts from "../../../contracts/tool-contracts.json";
import corpus from "../../../contracts/schema-cases.json";
import { defaultToolCatalog } from "./toolCatalog";
import { compileToolSchema } from "./toolParameterSchema";
import { toolResultSchema } from "./toolOutputSchemas";
import { enforceToolResult } from "./toolResultContract";

describe("shared Draft-07 contracts", () => {
  it("keeps the exported artifact identical to the executable catalog", () => {
    expect(contracts.resultSchema).toEqual(toolResultSchema);
    expect(contracts.tools).toEqual(defaultToolCatalog.map(({ id, inputSchema, outputSchema }) =>
      ({ id, inputSchema, ...(outputSchema ? { outputSchema } : {}) })));
    expect(contracts.tools.filter(tool => "outputSchema" in tool)).toHaveLength(12);
  });
  it.each(corpus.cases)("$name", fixture => {
    const item = fixture as { schema?: Record<string, unknown>; toolId?: string; contract?: string; value: unknown; valid: boolean };
    const schema = item.schema ?? (item.contract === "resultSchema" ? contracts.resultSchema
      : (contracts.tools.find(tool => tool.id === item.toolId) as unknown as Record<string, Record<string, unknown>>)[item.contract!]);
    const before = JSON.stringify(item.value);
    expect(compileToolSchema(schema)(item.value)).toBe(item.valid);
    expect(JSON.stringify(item.value)).toBe(before);
  });
});

describe("tool output boundary", () => {
  const call = { id: "read", toolId: "files.read_content", arguments: { path: "/a", maxBytes: 10 } };
  const data = { path: "/a", content: "abc", totalBytes: 3, returnedBytes: 3, encoding: "utf-8", truncated: false };
  const result = () => ({ callId: call.id, toolId: call.toolId, success: true, data: { ...data } });
  it.each([
    { path: "/other" }, { returnedBytes: 4 }, { totalBytes: 2 }, { truncated: true },
    { returnedBytes: 11, totalBytes: 11 }, { encoding: "unknown" }, { extra: "secret-should-not-leak" },
  ])("rejects malformed or unrelated file results: %j", patch => {
    const checked = enforceToolResult(call, { ...result(), data: { ...data, ...patch } });
    expect(checked).toMatchObject({ success: false, error: { code: "TOOL_OUTPUT_INVALID", category: "output", dispatchState: "unknown" } });
    expect(checked.data).toBeUndefined();
    expect(JSON.stringify(checked)).not.toContain("secret-should-not-leak");
  });
  it("accepts valid partial data without equating redacted text length to remote bytes", () => {
    expect(enforceToolResult(call, { ...result(), data: { ...data, content: "[REDACTED]", totalBytes: 20, returnedBytes: 10, truncated: true } }).success).toBe(true);
  });
  it.each([{ callId: "other" }, { toolId: "other" }, { success: false }, { error: { code: "bad", message: "bad" } }])("checks result identity and discriminated envelope: %j", patch => {
    expect(enforceToolResult(call, { ...result(), ...patch }).success).toBe(false);
  });
  it("requires complete, unique software results matching the request", () => {
    const software = { id: "software", toolId: "software.check", arguments: { names: ["node", "npm"] } };
    for (const names of [["node"], ["node", "node"], ["node", "other"]]) {
      expect(enforceToolResult(software, { callId: software.id, toolId: software.toolId, success: true,
        data: { items: names.map(name => ({ name, installed: false })) } }).success).toBe(false);
    }
  });
  it("uses Unicode code points and requires forward progress in evidence pages", () => {
    const evidence = { id: "e", toolId: "evidence.read", arguments: { evidenceId: "a".repeat(64), offset: 2, limit: 1 } };
    const value = { callId: evidence.id, toolId: evidence.toolId, success: true,
      data: { evidenceId: evidence.arguments.evidenceId, historical: true, metadata: {}, text: "😀", offset: 2, totalCharacters: 4, nextOffset: 3, instruction: "history" } };
    expect(enforceToolResult(evidence, value).success).toBe(true);
    expect(enforceToolResult(evidence, { ...value, data: { ...value.data, nextOffset: 4 } }).success).toBe(false);
    expect(enforceToolResult(evidence, { ...value, data: { ...value.data, text: "", nextOffset: 2 } }).success).toBe(false);
  });
  it("normalizes directory scope with the dispatch path rules", () => {
    const directory = { id: "d", toolId: "files.get_structure", arguments: { rootPath: "/a//b/" } };
    expect(enforceToolResult(directory, { callId: directory.id, toolId: directory.toolId, success: true,
      data: { rootPath: "/a/b", tree: "/a/b/", truncated: false, warnings: [] } }).success).toBe(true);
  });
  it("rejects non-JSON values even inside extensible historical metadata", () => {
    const evidence = { id: "e", toolId: "evidence.read", arguments: { evidenceId: "a".repeat(64) } };
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const metadata of [{ value: NaN }, { value: Infinity }, { value: BigInt(1) }, cyclic, { value: () => "secret" }]) {
      const checked = enforceToolResult(evidence, { callId: evidence.id, toolId: evidence.toolId, success: true,
        data: { evidenceId: evidence.arguments.evidenceId, historical: true, metadata, text: "", offset: 0, totalCharacters: 0, nextOffset: null, instruction: "history" } });
      expect(checked.error?.code).toBe("TOOL_OUTPUT_INVALID");
    }
  });
});
