import { invoke } from "@tauri-apps/api/core";
import { builtInSkillCatalog } from "@/features/skills/skillCatalog";
import { SKILL_CATEGORY_IDS, type SkillDefinition } from "@/features/skills/types";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import type { ToolDefinition } from "@/features/tools/types";
import { validateCompatibleToolSchema } from "@/features/tools/toolParameterSchema";
import { version as coreVersion } from "../../../package.json";

export type ContentKind = "skills" | "tools";
export interface OfficialRelease { id: string; kind: ContentKind; version: number; min_core_version: string; sha256: string }
interface Envelope extends OfficialRelease { content: string }
type ToolConfiguration = Pick<ToolDefinition, "name" | "description" | "usageInstructions" | "outputDescription" | "inputSchema">;
interface ToolPolicy extends Partial<ToolConfiguration> { id: string; enabled: boolean; min_implementation_version: number }
const toolTextLimits = { name: 80, description: 1000, usageInstructions: 2000, outputDescription: 1000 } as const;
interface Loaded { release: OfficialRelease; skills?: SkillDefinition[]; tools?: ToolPolicy[] }
const active: Partial<Record<ContentKind, Loaded>> = {};
export let officialContentLoadError = "";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 200 && v.every(x => typeof x === "string" && x.length <= 500);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const tools = new Map(defaultToolCatalog.map(t => [t.id, t]));
const skillFields = new Set(["id", "name", "category", "description", "instructions", "version", "enabled", "matchRules", "allowShell", "allowedToolIds", "forbiddenToolIds"]);

function compatible(minimum: string) {
  if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(minimum)) return false;
  const a = coreVersion.split(".").map(Number), b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i]! > b[i]!; }
  return true;
}

/** Native code authenticates the origin and verifies the content hash before this schema check. */
export function validateOfficialContent(envelope: Envelope): Loaded {
  if (!object(envelope) || !["skills", "tools"].includes(envelope.kind) || !positive(envelope.version)
    || !/^[a-zA-Z0-9_-]{1,64}$/.test(envelope.id) || !/^[a-f0-9]{64}$/.test(envelope.sha256)
    || !compatible(envelope.min_core_version) || typeof envelope.content !== "string") throw new Error("官方内容与当前 Core 不兼容，请检查系统更新。");
  const data: unknown = JSON.parse(envelope.content);
  if (!object(data) || (data.schema_version !== 1 && !(envelope.kind === "tools" && data.schema_version === 2)) || data.kind !== envelope.kind || data.version !== envelope.version
    || data.min_core_version !== envelope.min_core_version || !Array.isArray(data.items) || !data.items.length || data.items.length > 200) throw new Error("官方内容格式无效。");
  const ids = new Set<string>();
  for (const item of data.items) {
    if (!object(item) || typeof item.id !== "string" || ids.has(item.id)) throw new Error("官方内容 ID 无效或重复。");
    ids.add(item.id);
  }
  const release: OfficialRelease = { id: envelope.id, kind: envelope.kind, version: envelope.version, min_core_version: envelope.min_core_version, sha256: envelope.sha256 };
  if (envelope.kind === "tools") {
    const items: ToolPolicy[] = data.items.map(item => {
      const fields = ["id", "enabled", "min_implementation_version", ...(data.schema_version === 2 ? [...Object.keys(toolTextLimits), "inputSchema"] : [])];
      if (Object.keys(item).some(key => !fields.includes(key))
        || typeof item.enabled !== "boolean" || !positive(item.min_implementation_version)) throw new Error("工具配置包含不支持的字段。");
      const policy: ToolPolicy = { id: item.id, enabled: item.enabled, min_implementation_version: item.min_implementation_version };
      if (data.schema_version === 2) {
        for (const [key, limit] of Object.entries(toolTextLimits)) {
          if (typeof item[key] !== "string" || !item[key].trim() || item[key].length > limit) throw new Error(`工具 ${item.id} 的 ${key} 无效。`);
          (policy as unknown as Record<string, unknown>)[key] = item[key];
        }
        const base = tools.get(item.id);
        if (base && base.version >= item.min_implementation_version) validateCompatibleToolSchema(item.inputSchema, base.inputSchema, item.id);
        else if (!object(item.inputSchema)) throw new Error("工具参数协议无效。");
        policy.inputSchema = clone(item.inputSchema);
      }
      return policy;
    });
    return { release, tools: items };
  }
  if (!Array.isArray(data.required_tools) || data.required_tools.some(item => !object(item) || typeof item.id !== "string"
    || !positive(item.min_implementation_version) || (tools.get(item.id)?.version ?? 0) < item.min_implementation_version)) throw new Error("官方 Skill 需要更新的工具实现，请先升级 Core。");
  const skills = data.items.map((item): SkillDefinition => {
    if (Object.keys(item).some(key => !skillFields.has(key)) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || item.id.startsWith("skill-")
      || !positive(item.version) || typeof item.enabled !== "boolean" || typeof item.allowShell !== "boolean"
      || !SKILL_CATEGORY_IDS.includes(item.category) || !strings(item.matchRules)
      || !strings(item.allowedToolIds) || !strings(item.forbiddenToolIds)
      || ["name", "description", "instructions"].some(key => typeof item[key] !== "string" || !item[key].trim())
      || item.name.length > 80 || item.description.length > 1000 || item.instructions.length > 8000) throw new Error("官方 Skill 格式无效。");
    if ([...item.allowedToolIds, ...item.forbiddenToolIds].some(id => !tools.has(id))) throw new Error("官方 Skill 需要当前 Core 尚未提供的工具，请先更新系统。");
    for (const rule of item.matchRules) { if (rule.startsWith("regex:")) new RegExp(rule.slice(6), "i"); }
    const base = builtInSkillCatalog.find(s => s.id === item.id);
    const skill: SkillDefinition = { ...clone(item), source: "system", builtIn: true, updatedAt: base?.updatedAt ?? "" };
    // Local contracts are valid only for their exact instructions and capability declarations.
    if (base && base.instructions === item.instructions && (base.allowShell !== false) === item.allowShell
      && JSON.stringify(base.allowedToolIds ?? []) === JSON.stringify(item.allowedToolIds)
      && JSON.stringify(base.forbiddenToolIds ?? []) === JSON.stringify(item.forbiddenToolIds)) {
      if (base.planningContract) skill.planningContract = clone(base.planningContract);
      if (base.suggestions) skill.suggestions = clone(base.suggestions);
    }
    return skill;
  });
  return { release, skills };
}

export function officialVersions() { return { skills: active.skills?.release.version ?? 0, tools: active.tools?.release.version ?? 0 }; }
export function officialSkills() { return clone(active.skills?.skills ?? builtInSkillCatalog); }
export function officialToolEnabled(id: string) {
  const tool = tools.get(id);
  if (!tool) return false;
  if (!active.tools) return tool.enabled;
  const policy = active.tools.tools?.find(item => item.id === id);
  return !!policy?.enabled && tool.version >= policy.min_implementation_version;
}
export function effectiveOfficialTool(tool: ToolDefinition): ToolDefinition {
  const policy = active.tools?.tools?.find(item => item.id === tool.id);
  if (!policy || !officialToolEnabled(tool.id)) return { ...tool, enabled: tool.enabled && officialToolEnabled(tool.id) };
  const { id: _id, enabled: _enabled, min_implementation_version: _minimum, ...configuration } = policy;
  return { ...tool, ...clone(configuration), enabled: tool.enabled, ...(policy.inputSchema ? { configurationVersion: active.tools!.release.version } : {}) };
}
export function applyOfficialTools(catalog: ToolDefinition[]) { return catalog.map(effectiveOfficialTool); }

export async function hydrateOfficialContent() {
  delete active.skills; delete active.tools; officialContentLoadError = "";
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    const cached = await invoke<Envelope[]>("official_content_request", { operation: "cache" });
    for (const envelope of cached) {
      try {
        const loaded = validateOfficialContent(envelope);
        if (!active[envelope.kind] || active[envelope.kind]!.release.version < envelope.version) active[envelope.kind] = loaded;
      } catch { officialContentLoadError = "部分官方缓存不兼容，已保留可用版本；请检查更新。"; }
    }
  } catch (e) { officialContentLoadError = `官方缓存暂不可用，使用安装包内置内容：${String(e)}`; }
}

export async function syncOfficialRelease(release: OfficialRelease) {
  if (release.version <= (active[release.kind]?.release.version ?? 0)) return false;
  const envelope = await invoke<Envelope>("official_content_request", { operation: "download", kind: release.kind, releaseId: release.id });
  if (envelope.id !== release.id || envelope.kind !== release.kind || envelope.version !== release.version || envelope.sha256 !== release.sha256) throw new Error("官方发布已变化，请重新检查。");
  const loaded = validateOfficialContent(envelope);
  await invoke("official_content_request", { operation: "activate", kind: release.kind, releaseId: release.id });
  active[release.kind] = loaded;
  return true;
}
