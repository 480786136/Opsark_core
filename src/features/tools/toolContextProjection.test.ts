import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, defineStore, setActivePinia } from "pinia";
import { isProxy } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { providedToolEvidence } from "./toolEvidenceCapability";
import { buildPlanningToolContext, buildToolContext, selectPlanningTools } from "./toolContext";
import { parseToolOverrides, resolveToolRegistry } from "./toolRegistry";
import { defaultToolCatalog } from "./toolCatalog";
import { effectiveToolSemanticContract } from "./toolPreparation";
import { executeToolCall, parseToolAction } from "./toolExecutor";
import { hydrateOfficialContent, syncOfficialRelease } from "../support/officialContent";
import { saveExecutionPermissions } from "./executionPermissions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const native = vi.mocked(invoke);
beforeEach(async () => {
  localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  await hydrateOfficialContent(); native.mockReset(); setActivePinia(createPinia());
});
afterEach(async () => {
  localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  await hydrateOfficialContent();
});

describe("G09 模型输出契约投影与执行边界", () => {
  it("目标变更标记来自编译目录，普通编辑不能伪造；连接与用户填写保持可用", () => {
    const tools = resolveToolRegistry(parseToolOverrides([
      { id: "server.connect", requiresTargetChange: true },
      { id: "files.delete_confirmed", requiresTargetChange: false },
    ]));
    const directory = buildToolContext(tools);
    expect(directory.filter(tool => tool.requiresTargetChange).map(tool => tool.id)).toEqual([
      "files.transfer_between_servers", "files.confirm_deletion", "files.delete_confirmed",
    ]);
    for (const id of ["server.connect", "user.request_input", "evidence.read", "files.preview_deletion", "software.check"]) {
      expect(directory.find(tool => tool.id === id)).toBeDefined();
      expect(directory.find(tool => tool.id === id)).not.toHaveProperty("requiresTargetChange");
    }
    expect(directory.find(tool => tool.id === "files.delete_confirmed")?.inputSchema)
      .toEqual(defaultToolCatalog.find(tool => tool.id === "files.delete_confirmed")?.inputSchema);
  });
  it("Pinia代理可复制，所有规划字段保真且不修改真实执行语义", () => {
    const useFixtureStore = defineStore("tool-projection-fixture", { state: () => ({ tools: resolveToolRegistry([]) }) });
    const store = useFixtureStore();
    const original = JSON.stringify(store.tools);
    const originalContracts = store.tools.map(effectiveToolSemanticContract);
    expect(isProxy(store.tools)).toBe(true);
    expect(isProxy(store.tools[0].inputSchema)).toBe(true);
    const projected = buildToolContext(store.tools);
    const visible = store.tools.filter(tool => tool.enabled && (tool.modelExposure ?? "planner") === "planner");
    expect(projected.map(tool => tool.id)).toEqual(visible.map(tool => tool.id));
    for (let index = 0; index < projected.length; index++) {
      const tool = visible[index], context = projected[index];
      expect(context).toEqual({ id: tool.id, name: tool.name, description: tool.description, usageInstructions: tool.usageInstructions,
        inputSchema: tool.inputSchema, effect: tool.effect, outputDescription: tool.outputDescription,
        ...(providedToolEvidence(tool).length ? { providedEvidence: providedToolEvidence(tool) } : {}),
        ...(tool.requiresTargetChange === true ? { requiresTargetChange: true } : {}),
        planMode: tool.planMode ?? "regular", completionMode: tool.completionMode ?? "continue", version: tool.version });
      expect(context).not.toHaveProperty("outputSchema");
      expect(context.inputSchema).not.toBe(tool.inputSchema);
      expect(isProxy(context.inputSchema)).toBe(false);
      expect(tool.outputSchema).toBeDefined();
    }
    expect(JSON.stringify(store.tools)).toBe(original);
    expect(store.tools.map(effectiveToolSemanticContract)).toEqual(originalContracts);
    const copy = projected.find(tool => tool.id === "files.read_content")!;
    const source = store.tools.find(tool => tool.id === copy.id)!;
    (copy.inputSchema.properties as Record<string, Record<string, unknown>>).maxBytes.maximum = 1;
    expect(JSON.stringify(store.tools)).toBe(original);
    expect((source.inputSchema.properties as Record<string, Record<string, unknown>>).maxBytes.maximum).not.toBe(1);
  });

  it("省略输出schema不改变权限目录、禁用状态或内部工具可见性", () => {
    const tools = resolveToolRegistry([]);
    saveExecutionPermissions({ allowShell: false, toolIds: ["files.read_content", "software.check"] });
    tools.find(tool => tool.id === "software.check")!.enabled = false;
    const selected = selectPlanningTools(tools);
    const before = JSON.stringify(selected.map(effectiveToolSemanticContract));
    expect(buildPlanningToolContext(tools).map(tool => tool.id)).toEqual(["files.read_content"]);
    expect(JSON.stringify(selectPlanningTools(tools).map(effectiveToolSemanticContract))).toBe(before);
    expect(buildToolContext(tools).some(tool => ["secret.merge_command", "secret.metadata", "server.basic_info", "server.realtime_metrics", "software.check"].includes(tool.id))).toBe(false);
  });

  it("官方输入收紧仍同步投影、参数准备与派发，而完整输出契约仍留在Core", async () => {
    const tool = defaultToolCatalog.find(item => item.id === "files.read_content")!;
    const inputSchema = structuredClone(tool.inputSchema);
    Object.assign((inputSchema.properties as Record<string, Record<string, unknown>>).maxBytes, { default: 4, maximum: 8 });
    (inputSchema.required as string[]).push("maxBytes");
    const envelope = { id: "g09-tools-1", kind: "tools" as const, version: 1, min_core_version: "0.3.0", sha256: "a".repeat(64),
      content: JSON.stringify({ schema_version: 2, kind: "tools", version: 1, min_core_version: "0.3.0", items: [{ id: tool.id, enabled: true,
        min_implementation_version: tool.version, name: "小文件读取", description: tool.description, usageInstructions: tool.usageInstructions,
        outputDescription: tool.outputDescription, inputSchema }] }) };
    native.mockResolvedValueOnce(envelope).mockResolvedValueOnce({ ok: true });
    expect(await syncOfficialRelease(envelope)).toBe(true);
    const context = buildPlanningToolContext(defaultToolCatalog);
    expect(context).toHaveLength(1);
    expect(context[0]).toMatchObject({ id: tool.id, name: "小文件读取", version: tool.version, configurationVersion: 1,
      inputSchema: { properties: { maxBytes: { default: 4, maximum: 8 } }, required: expect.arrayContaining(["maxBytes"]) } });
    expect(context[0]).not.toHaveProperty("outputSchema");
    expect(parseToolAction({ type: "tool", toolId: tool.id, arguments: { path: "/fixture" } }, "g09-call")?.arguments).toEqual({ path: "/fixture", maxBytes: 4 });
    expect(() => parseToolAction({ type: "tool", toolId: tool.id, arguments: { path: "/fixture", maxBytes: 9 } }, "g09-invalid")).toThrow("最大值");
    expect(effectiveToolSemanticContract(tool).outputSchema).toBeDefined();
    const readRemoteFileContent = vi.fn().mockResolvedValue({ path: "/fixture", content: "data", totalBytes: 4, returnedBytes: 4, truncated: false, encoding: "utf-8" });
    const dependencies = { getRemoteFileStructure: vi.fn(), readRemoteFileContent };
    expect((await executeToolCall({ id: "g09-valid", toolId: tool.id, arguments: { path: "/fixture" } }, defaultToolCatalog, dependencies)).success).toBe(true);
    expect(readRemoteFileContent).toHaveBeenCalledExactlyOnceWith({ path: "/fixture", maxBytes: 4 });
    readRemoteFileContent.mockClear();
    const blocked = await executeToolCall({ id: "g09-too-big", toolId: tool.id, arguments: { path: "/fixture", maxBytes: 9 } }, defaultToolCatalog, dependencies);
    expect(blocked.success).toBe(false);
    expect(readRemoteFileContent).not.toHaveBeenCalled();
  });

  it("模型目录无输出schema时实际工具执行仍拒绝结构错误与跨目标返回", async () => {
    const tools = resolveToolRegistry([]);
    expect(buildToolContext(tools).find(tool => tool.id === "files.read_content")).not.toHaveProperty("outputSchema");
    const valid = { path: "/fixture", content: "data", totalBytes: 4, returnedBytes: 4, truncated: false, encoding: "utf-8" };
    for (const patch of [{ extra: "not-in-schema" }, { path: "/another-target" }, { returnedBytes: 3 }]) {
      const readRemoteFileContent = vi.fn().mockResolvedValue({ ...valid, ...patch });
      const result = await executeToolCall({ id: "g09-output", toolId: "files.read_content", arguments: { path: "/fixture", maxBytes: 4 } }, tools,
        { getRemoteFileStructure: vi.fn(), readRemoteFileContent });
      expect(readRemoteFileContent).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ success: false, error: { code: "TOOL_OUTPUT_INVALID", category: "output", dispatchState: "unknown" } });
      expect(result.data).toBeUndefined();
    }
  });
});
