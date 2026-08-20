import { builtInSkillCatalog } from "@/features/skills/skillCatalog";
import { collectRuntimeSkillFacts } from "@/features/skills/skillRuntime";
import { normalizeSkillDefinition } from "@/features/skills/skillValidation";
import type {
  ModelSkillDefinition,
  ModelSkillDirectoryEntry,
  SkillConfiguration,
  SkillDefinition,
  SkillOverride,
} from "@/features/skills/types";
import type { OpsTask } from "@/types";

const EDITABLE_FIELDS = ["name", "description", "enabled", "matchRules", "instructions"] as const;
const LEGACY_PROJECT_SKILL_ID = "project-deployment";
const SPLIT_PROJECT_SKILL_IDS = new Set(["project-source-acquisition", "project-build"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function parseOverride(value: unknown): SkillOverride | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const result: SkillOverride = { id: value.id };
  if (typeof value.name === "string") result.name = value.name;
  if (typeof value.description === "string") result.description = value.description;
  if (typeof value.enabled === "boolean") result.enabled = value.enabled;
  const matchRules = stringArray(value.matchRules);
  if (matchRules) result.matchRules = matchRules;
  if (typeof value.instructions === "string") result.instructions = value.instructions;
  if (typeof value.updatedAt === "string") result.updatedAt = value.updatedAt;
  return result;
}

function parseCustomSkill(value: unknown): SkillDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const matchRules = stringArray(value.matchRules);
  if (
    typeof value.id !== "string" || !/^skill-[a-z0-9][a-z0-9-]*$/i.test(value.id)
    || typeof value.name !== "string" || typeof value.description !== "string"
    || typeof value.instructions !== "string" || !matchRules
  ) return undefined;
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    instructions: value.instructions,
    matchRules,
    enabled: value.enabled !== false,
    builtIn: false,
    version: Number.isInteger(value.version) ? Number(value.version) : 1,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

export function parseSkillConfiguration(value: unknown): SkillConfiguration {
  if (!isRecord(value)) return { overrides: [], customSkills: [] };
  return {
    overrides: Array.isArray(value.overrides)
      ? value.overrides.map(parseOverride).filter((item): item is SkillOverride => Boolean(item))
      : [],
    customSkills: Array.isArray(value.customSkills)
      ? value.customSkills.map(parseCustomSkill).filter((item): item is SkillDefinition => Boolean(item))
      : [],
  };
}

export function resolveSkillRegistry(
  configuration: SkillConfiguration,
  catalog: SkillDefinition[] = builtInSkillCatalog,
) {
  const overrideById = new Map(configuration.overrides.map((item) => [item.id, item]));
  const builtIns = catalog.map((definition) => {
    const directOverride = overrideById.get(definition.id);
    // v1 combined source acquisition and build. Preserve only its enablement during
    // migration; copying its mixed prose/rules would couple the new Skills again.
    const legacyOverride = SPLIT_PROJECT_SKILL_IDS.has(definition.id)
      ? overrideById.get(LEGACY_PROJECT_SKILL_ID)
      : undefined;
    const override = directOverride ?? (typeof legacyOverride?.enabled === "boolean" ? {
      id: definition.id,
      enabled: legacyOverride.enabled,
      ...(legacyOverride.updatedAt ? { updatedAt: legacyOverride.updatedAt } : {}),
    } : undefined);
    if (!override) return structuredClone(definition);
    return {
      ...structuredClone(definition),
      ...override,
      id: definition.id,
      builtIn: true,
      version: definition.version,
    };
  });
  const builtInIds = new Set(builtIns.map((skill) => skill.id));
  return [
    ...builtIns,
    ...configuration.customSkills
      .filter((skill) => !builtInIds.has(skill.id))
      .map((skill) => ({ ...structuredClone(skill), builtIn: false })),
  ];
}

export function createSkillConfiguration(
  skills: SkillDefinition[],
  catalog: SkillDefinition[] = builtInSkillCatalog,
): SkillConfiguration {
  const defaults = new Map(catalog.map((skill) => [skill.id, skill]));
  const overrides = skills.flatMap((skill) => {
    const defaultSkill = defaults.get(skill.id);
    if (!defaultSkill) return [];
    const override: SkillOverride = { id: skill.id };
    for (const field of EDITABLE_FIELDS) {
      if (JSON.stringify(skill[field]) !== JSON.stringify(defaultSkill[field])) {
        if (field === "enabled") override.enabled = skill.enabled;
        else if (field === "matchRules") override.matchRules = [...skill.matchRules];
        else override[field] = skill[field];
      }
    }
    if (Object.keys(override).length === 1) return [];
    override.updatedAt = skill.updatedAt;
    return [override];
  });
  return {
    overrides,
    customSkills: skills.filter((skill) => !defaults.has(skill.id)).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
      builtIn: false,
      version: skill.version,
      matchRules: [...skill.matchRules],
      instructions: skill.instructions,
      updatedAt: skill.updatedAt,
    })),
  };
}

export function createCustomSkill(id: string): SkillDefinition {
  return {
    id,
    name: "新建 Skill",
    description: "说明这个 Skill 负责处理的业务场景。",
    matchRules: [],
    instructions: "说明模型必须遵循的处理阶段、可用工具、阻断条件和最终验收要求。",
    enabled: true,
    builtIn: false,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}

export function resetSkillDefinition(skillId: string, skills: SkillDefinition[]) {
  const defaultSkill = builtInSkillCatalog.find((skill) => skill.id === skillId);
  if (!defaultSkill) return skills;
  return skills.map((skill) => skill.id === skillId ? structuredClone(defaultSkill) : skill);
}

function matchesRule(requirement: string, rule: string) {
  const normalized = rule.trim();
  if (!normalized) return false;
  if (!normalized.startsWith("regex:")) {
    return requirement.toLocaleLowerCase().includes(normalized.toLocaleLowerCase());
  }
  try {
    return new RegExp(normalized.slice("regex:".length), "i").test(requirement);
  } catch {
    return false;
  }
}

/** Optional deterministic suggestions for diagnostics and legacy migration; runtime selection is model-driven. */
export function suggestSkillsByRules(requirement: string, catalog: SkillDefinition[] = builtInSkillCatalog) {
  return catalog.filter((skill) => skill.enabled && skill.matchRules.some((rule) => matchesRule(requirement, rule)));
}

/**
 * Builds the lightweight directory used by the requirement model to select zero or more Skills.
 * Workflow instructions are deliberately excluded until the model has selected valid IDs.
 */
export function buildSkillDirectory(skills: SkillDefinition[]): ModelSkillDirectoryEntry[] {
  return skills
    .filter((skill) => skill.enabled)
    .map(({ id, name, description, version, matchRules }) => ({
      id,
      name,
      description,
      version,
      selectionHints: [...matchRules],
    }));
}

export function resolveTaskSkills(task: OpsTask, catalog: SkillDefinition[] = builtInSkillCatalog) {
  const ids = new Set(task.activeSkillIds ?? []);
  return catalog.filter((skill) => skill.enabled && ids.has(skill.id));
}

export function buildSkillContext(skills: SkillDefinition[]): ModelSkillDefinition[] {
  return skills.map(({ id, name, description, version, instructions }) => ({
    id, name, description, version, instructions,
  }));
}

export function collectSkillFacts(task: OpsTask, skills = resolveTaskSkills(task)) {
  return Object.fromEntries(skills.flatMap((skill) => {
    const facts = collectRuntimeSkillFacts(skill.id, task);
    return facts ? [[skill.id, facts] as const] : [];
  }));
}

export function normalizeSkillRegistry(skills: SkillDefinition[]) {
  return skills.map(normalizeSkillDefinition);
}
