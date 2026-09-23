import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createPinia, setActivePinia } from "pinia";
import { cloudRequest } from "@/features/account/cloudClient";
import { useUpdateStore } from "./updateStore";
import { useOpsStore } from "@/stores/ops";
import { builtInSkillCatalog } from "@/features/skills/skillCatalog";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { createCustomSkill, resolveTaskSkills } from "@/features/skills/skillRegistry";
import { ownedSkills, pinTaskSkills } from "@/features/skills/ownedSkills";
import { executionCapabilityBlocker, readExecutionPermissions, saveExecutionPermissions } from "@/features/tools/executionPermissions";
import { buildToolContext, selectPlanningTools } from "@/features/tools/toolContext";
import { executeToolCall, parseToolCommand } from "@/features/tools/toolExecutor";
import type { OpsTask } from "@/types";
import { version as coreVersion } from "../../../package.json";
import { hydrateOfficialContent, officialSkills, officialToolEnabled, officialVersions, syncOfficialRelease, validateOfficialContent, type ContentKind } from "./officialContent";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/features/account/cloudClient", () => ({ cloudRequest: vi.fn() }));
const native = vi.mocked(invoke);
const fields = ["id", "name", "category", "description", "instructions", "version", "enabled", "matchRules", "allowedToolIds", "forbiddenToolIds"];
function skillItems(): Array<Record<string, unknown>> {
  return builtInSkillCatalog.map(skill => ({ ...Object.fromEntries(fields.filter(key => skill[key as keyof typeof skill] !== undefined).map(key => [key, skill[key as keyof typeof skill]])),
    allowShell: skill.allowShell !== false, allowedToolIds: skill.allowedToolIds ?? [], forbiddenToolIds: skill.forbiddenToolIds ?? [] }));
}
function envelope(kind: ContentKind, version = 1, items: unknown[] = kind === "skills" ? skillItems()
  : defaultToolCatalog.map(t => ({ id: t.id, enabled: true, min_implementation_version: t.version }))) {
  return { id: `${kind}-${version}`, kind, version, min_core_version: "0.3.0", sha256: "a".repeat(64),
    content: JSON.stringify({ schema_version: 1, kind, version, min_core_version: "0.3.0", required_tools: [], items }) };
}
const futureCoreVersion = `${Number(coreVersion.split(".")[0]) + 1}.0.0`;
function requiringCoreVersion(value: ReturnType<typeof envelope>, minimum: string) {
  return { ...value, min_core_version: minimum,
    content: JSON.stringify({ ...JSON.parse(value.content), min_core_version: minimum }) };
}
async function activate(value: ReturnType<typeof envelope>) {
  native.mockResolvedValueOnce(value).mockResolvedValueOnce({ ok: true });
  return syncOfficialRelease(value);
}
function configuredTools(version = 1) {
  const value = envelope("tools", version);
  const body = JSON.parse(value.content);
  body.schema_version = 2;
  body.items = defaultToolCatalog.map(t => ({ id: t.id, enabled: t.enabled, min_implementation_version: t.version,
    name: t.name, description: t.description, usageInstructions: t.usageInstructions,
    outputDescription: t.outputDescription, inputSchema: JSON.parse(JSON.stringify(t.inputSchema)) }));
  return { value, body, file: body.items.find((t: { id: string }) => t.id === "files.read_content") };
}
beforeEach(async () => {
  localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  await hydrateOfficialContent(); native.mockReset();
  setActivePinia(createPinia()); vi.mocked(cloudRequest).mockReset();
});

it("loads guidance-only publications and ignores legacy permission metadata", () => {
  const items = skillItems().map(({ allowShell: _shell, allowedToolIds: _allowed, forbiddenToolIds: _forbidden, ...skill }) => skill);
  const value = envelope("skills", 1, items);
  const body = JSON.parse(value.content);
  body.schema_version = 2;
  value.content = JSON.stringify(body);
  const current = validateOfficialContent(value).skills!;
  expect(current).toHaveLength(7);
  const legacy = validateOfficialContent(envelope("skills", 1, items.map(skill => ({
    ...skill, allowShell: false, allowedToolIds: ["retired.tool"], forbiddenToolIds: ["software.check"],
  })))).skills!;
  expect(legacy).toEqual(current);
  expect(legacy[0]).not.toHaveProperty("allowedToolIds");
  expect(legacy[0]).not.toHaveProperty("allowShell");
  expect(legacy[0]).not.toHaveProperty("forbiddenToolIds");
});
afterEach(async () => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); await hydrateOfficialContent(); });

it("preserves user workflows, local contracts and running-task snapshots across official updates", async () => {
  const user = createCustomSkill("skill-personal");
  const before = officialSkills();
  const task = { activeSkillIds: [before[0]!.id] } as OpsTask;
  pinTaskSkills(task, before);
  const baseline = envelope("skills");
  const parsed = validateOfficialContent(baseline);
  expect(parsed.skills?.find(s => s.planningContract)?.planningContract).toEqual(before.find(s => s.planningContract)?.planningContract);
  const items = skillItems(); items[0]!.instructions = "Updated official instructions.";
  await activate(envelope("skills", 1, items));
  const after = ownedSkills({ overrides: [], customSkills: [user] });
  expect(after.find(s => s.id === user.id)?.instructions).toBe(user.instructions);
  expect(after[0]?.instructions).toBe("Updated official instructions.");
  expect(after[0]?.planningContract).toBeUndefined();
  expect(resolveTaskSkills(task, after)[0]?.instructions).toBe(before[0]?.instructions);
  expect(officialVersions().skills).toBe(1);
});

it("revokes tools in planning and dispatch without overwriting the user's grants", async () => {
  const id = "files.read_content";
  saveExecutionPermissions({ allowShell: true, toolIds: [id] });
  const permissions = readExecutionPermissions();
  const skill = createCustomSkill("skill-personal"); skill.allowedToolIds = [id];
  const task = { activeSkillIds: [skill.id] } as OpsTask; pinTaskSkills(task, [skill]);
  const value = envelope("tools"); const data = JSON.parse(value.content);
  data.items.find((t: { id: string }) => t.id === id).enabled = false; value.content = JSON.stringify(data);
  await activate(value);
  expect(readExecutionPermissions()).toEqual(permissions);
  expect(officialToolEnabled(id)).toBe(false);
  expect(selectPlanningTools(defaultToolCatalog, [skill])).toEqual([]);
  expect(executionCapabilityBlocker(task, { command: `opsark-tool ${id} {"path":"/tmp/a"}`, validation: "true" }, [skill])).toContain("已停用");
  const readRemoteFileContent = vi.fn();
  const result = await executeToolCall({ id: "c", toolId: id, arguments: { path: "/tmp/a" } }, defaultToolCatalog, { readRemoteFileContent, getRemoteFileStructure: vi.fn() });
  expect(result.error?.code).toBe("TOOL_DISABLED"); expect(readRemoteFileContent).not.toHaveBeenCalled();
});

it("applies published parameters to model context, parsing and direct dispatch with a stale catalog", async () => {
  const { value, body, file } = configuredTools();
  file.name = "小文件读取";
  Object.assign(file.inputSchema.properties.maxBytes, { default: 4096, maximum: 8192 });
  file.inputSchema.required.push("maxBytes");
  value.content = JSON.stringify(body);
  await activate(value);
  const context = buildToolContext(defaultToolCatalog).find(t => t.id === file.id)!;
  expect(context).toMatchObject({ name: "小文件读取", configurationVersion: 1, version: file.min_implementation_version,
    inputSchema: { properties: { maxBytes: { default: 4096, maximum: 8192 } } } });
  expect(parseToolCommand('opsark-tool files.read_content {"path":"/tmp/a"}', "parsed")?.arguments)
    .toEqual({ path: "/tmp/a", maxBytes: 4096 });
  expect(() => parseToolCommand('opsark-tool files.read_content {"path":"/tmp/a","maxBytes":0}', "invalid")).toThrow("最小值");
  const readRemoteFileContent = vi.fn().mockResolvedValue({ content: "synthetic", truncated: false });
  const call = { id: "direct", toolId: file.id, arguments: { path: "/tmp/a" } };
  const dependencies = { getRemoteFileStructure: vi.fn(), readRemoteFileContent };
  expect((await executeToolCall(call, defaultToolCatalog, dependencies)).success).toBe(true);
  expect(readRemoteFileContent).toHaveBeenCalledExactlyOnceWith({ path: "/tmp/a", maxBytes: 4096 });
  expect(call.arguments).toEqual({ path: "/tmp/a" });
  readRemoteFileContent.mockClear();
  const rejected = await executeToolCall({ ...call, arguments: { path: "/tmp/a", maxBytes: 8193 } }, defaultToolCatalog, dependencies);
  expect(rejected.success).toBe(false);
  expect(rejected.error?.message).toContain("最大值");
  expect(readRemoteFileContent).not.toHaveBeenCalled();
  expect(defaultToolCatalog.find(t => t.id === file.id)?.inputSchema).toMatchObject({ properties: { maxBytes: { default: 65536 } } });
});

it("fills nested defaults and preserves explicit false while enforcing published lengths and enums", async () => {
  const { value, body } = configuredTools();
  const software = body.items.find((t: { id: string }) => t.id === "software.check");
  software.inputSchema.properties.names.maxItems = 2;
  software.inputSchema.properties.names.items.enum = ["git", "node"];
  const form = body.items.find((t: { id: string }) => t.id === "user.request_input");
  form.inputSchema.properties.fields.items.properties.required.default = true;
  form.inputSchema.properties.title.maxLength = 10;
  value.content = JSON.stringify(body); await activate(value);
  expect(parseToolCommand('opsark-tool software.check {"names":["git"],"includeVersions":false}', "explicit")?.arguments.includeVersions).toBe(false);
  expect(() => parseToolCommand('opsark-tool software.check {"names":["python"]}', "enum")).toThrow("允许范围");
  const args = { title: "输入目标", fields: [{ key: "target", label: "目标", description: "操作目标", type: "text" }] };
  expect(parseToolCommand(`opsark-tool user.request_input ${JSON.stringify(args)}`, "nested")?.arguments.fields)
    .toEqual([{ ...args.fields[0], required: true }]);
  expect(() => parseToolCommand(`opsark-tool user.request_input ${JSON.stringify({ ...args, title: "x".repeat(11) })}`, "length"))
    .toThrow("长度超过限制");
});

it.each([
  (t: any) => { t.inputSchema.properties.maxBytes.maximum = 262145; },
  (t: any) => { t.inputSchema.properties.maxBytes.default = false; },
  (t: any) => { t.inputSchema.properties.maxBytes.type = "string"; },
  (t: any) => { t.inputSchema.properties.extra = { type: "string" }; },
  (t: any) => { t.inputSchema.required = []; },
  (t: any) => { t.inputSchema.additionalProperties = true; },
  (t: any) => { t.implementation = "replacement"; },
])("rejects incompatible parameter publications before activation and keeps the active version", async change => {
  await activate(envelope("tools"));
  native.mockClear();
  const { value, body, file } = configuredTools(2);
  change(file); value.content = JSON.stringify(body);
  native.mockResolvedValueOnce(value);
  await expect(syncOfficialRelease(value)).rejects.toThrow();
  expect(native).toHaveBeenCalledTimes(1);
  expect(officialVersions().tools).toBe(1);
});

it("hydrates parameter defaults from the persisted configuration", async () => {
  const { value, body, file } = configuredTools(2);
  file.inputSchema.properties.maxBytes.default = 2048;
  value.content = JSON.stringify(body);
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  native.mockResolvedValueOnce([value, envelope("tools", 1)]);
  await hydrateOfficialContent();
  expect(parseToolCommand('opsark-tool files.read_content {"path":"/tmp/a"}', "cached")?.arguments.maxBytes).toBe(2048);
  expect(officialVersions().tools).toBe(2);
});

it("checks normalized requests and compiled fallbacks against the published configuration", async () => {
  const { value, body, file } = configuredTools();
  delete file.inputSchema.properties.maxBytes.default;
  file.inputSchema.properties.maxBytes.maximum = 8192;
  file.inputSchema.properties.path.minLength = 8;
  value.content = JSON.stringify(body); await activate(value);
  const readRemoteFileContent = vi.fn();
  const dependencies = { getRemoteFileStructure: vi.fn(), readRemoteFileContent };
  for (const argumentsValue of [{ path: "/tmp/file" }, { path: " /tmp/a  ", maxBytes: 4096 }]) {
    const result = await executeToolCall({ id: "fallback", toolId: file.id, arguments: argumentsValue }, defaultToolCatalog, dependencies);
    expect(result.success).toBe(false);
  }
  expect(readRemoteFileContent).not.toHaveBeenCalled();
});

it("does not activate failed downloads, incompatible payloads or failed persistence", async () => {
  await activate(envelope("skills"));
  native.mockRejectedValueOnce(new Error("offline"));
  await expect(syncOfficialRelease(envelope("skills", 2))).rejects.toThrow("offline");
  const bad = envelope("skills", 2, [{ ...skillItems()[0], planningContract: {} }]);
  native.mockResolvedValueOnce(bad);
  await expect(syncOfficialRelease(bad)).rejects.toThrow("格式无效");
  const next = envelope("skills", 2);
  native.mockResolvedValueOnce(next).mockRejectedValueOnce(new Error("disk full"));
  await expect(syncOfficialRelease(next)).rejects.toThrow("disk full");
  expect(officialVersions().skills).toBe(1);
  const incompatible = requiringCoreVersion(envelope("skills", 2), futureCoreVersion);
  expect(() => validateOfficialContent(incompatible)).toThrow("不兼容");
  const newerTools = envelope("skills", 2); const body = JSON.parse(newerTools.content);
  body.required_tools = [{ id: "files.read_content", min_implementation_version: 999 }]; newerTools.content = JSON.stringify(body);
  expect(() => validateOfficialContent(newerTools)).not.toThrow();
});

it("uses only higher versions and restores the latest compatible cache offline", async () => {
  await activate(envelope("tools", 2));
  native.mockClear();
  expect(await syncOfficialRelease(envelope("tools", 2))).toBe(false);
  expect(await syncOfficialRelease(envelope("tools", 1))).toBe(false);
  expect(native).not.toHaveBeenCalled();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const invalid = requiringCoreVersion(envelope("tools", 3), futureCoreVersion);
  native.mockResolvedValueOnce([invalid, envelope("tools", 2), envelope("tools", 1), envelope("skills")]);
  await hydrateOfficialContent();
  expect(officialVersions()).toEqual({ skills: 1, tools: 2 });
  expect(native).toHaveBeenCalledExactlyOnceWith("official_content_request", { operation: "cache" });
});

it.each(["skills", "tools"] as const)("checks %s compatibility against the current Core without weakening envelope validation", (kind) => {
  const compatible = requiringCoreVersion(envelope(kind), coreVersion);
  const future = requiringCoreVersion(envelope(kind), futureCoreVersion);
  expect(() => validateOfficialContent(compatible)).not.toThrow();
  expect(() => validateOfficialContent(future)).toThrow("不兼容");
  // A supported outer version cannot conceal a different requirement in the payload.
  expect(() => validateOfficialContent({ ...compatible, content: future.content })).toThrow("格式无效");
});

it("does not activate unknown tools or insufficient implementation versions", async () => {
  await activate(envelope("tools", 1, [{ id: "unknown.tool", enabled: true, min_implementation_version: 1 },
    { id: "files.read_content", enabled: true, min_implementation_version: 999 }]));
  expect(officialToolEnabled("unknown.tool")).toBe(false);
  expect(officialToolEnabled("files.read_content")).toBe(false);
  expect(officialToolEnabled("server.connect")).toBe(false);
});

it("keeps system guidance and applies tool revocation when the Skill channel fails", async () => {
  const value = envelope("tools"); const body = JSON.parse(value.content);
  body.items.find((t: { id: string }) => t.id === "files.read_content").enabled = false;
  value.content = JSON.stringify(body);
  const nextSkill = envelope("skills");
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  native.mockResolvedValueOnce(value).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("skill unavailable"));
  vi.mocked(cloudRequest).mockResolvedValue({ current_version: "0.3.0", min_cloud_version: "0.0.0", update_required: false,
    support_email: "", support_url: "", feedback_retention_days: 30, tools: value, system_skills: nextSkill,
    latest: { id: "binary", version: "0.3.1", platform: "macos", arch: "aarch64", notes: "Update", download_url: "https://example.test/download" } });
  const updates = useUpdateStore(); await updates.check();
  expect(updates.contentVersions).toEqual({ skills: 0, tools: 1 });
  expect(updates.contentError).toContain("skill unavailable");
  expect(updates.info?.latest?.version).toBe("0.3.1");
  expect(updates.busy).toBe(false);
  expect(useOpsStore().tools.find(t => t.id === "files.read_content")?.enabled).toBe(false);
});
