import { builtInSkillCatalog } from "./skillCatalog";
import { createCustomSkill, createSkillConfiguration, parseSkillConfiguration } from "./skillRegistry";
import type { SkillConfiguration, SkillDefinition } from "./types";
import type { OpsTask } from "@/types";
import { officialSkills } from "@/features/support/officialContent";

/** Official content is separate from user edits; executable contracts remain compiled locally. */
export function ownedSkills(raw: unknown): SkillDefinition[] {
  const parsed = parseSkillConfiguration(raw);
  const users = parsed.customSkills.map(({ allowShell: _allowShell, allowedToolIds: _allowedToolIds,
    forbiddenToolIds: _forbiddenToolIds, ...skill }) => ({ ...skill, source: "user" as const, builtIn: false }));
  for (const override of parsed.overrides) {
    const base = builtInSkillCatalog.find(skill => skill.id === override.id);
    const id = `skill-migrated-${override.id}`;
    if (users.some(skill => skill.id === id)) continue;
    const legacy = { ...createCustomSkill(id), ...(base ?? {}), ...override, id,
      name: `${override.name || base?.name || override.id}（迁移副本）`, source: "user" as const, builtIn: false,
      enabled: false, version: 1, planningContract: undefined };
    // Strip trusted fields and preserve the old prose even when legacy overrides predate a contract.
    users.push({ ...createSkillConfiguration([legacy]).customSkills[0], source: "user", builtIn: false });
  }
  return [...officialSkills().map(skill => ({ ...skill, source: "system", builtIn: true } as SkillDefinition)), ...users];
}

export function loadOwnedSkills(): SkillDefinition[] {
  const key = "opsark.skillConfiguration";
  try {
    const serialized = localStorage.getItem(key);
    const raw = JSON.parse(serialized || "{}");
    if (serialized && raw.schemaVersion !== 2 && !localStorage.getItem(`${key}.v03.backup`)) {
      // Failure to back up must not silently discard original user overrides.
      try { localStorage.setItem(`${key}.v03.backup`, serialized); } catch { /* Keep original content in memory; persistence retries backup before replacing it. */ }
    }
    return ownedSkills(raw);
  } catch { return ownedSkills({}); }
}

export function createOwnedSkillConfiguration(skills: SkillDefinition[]): SkillConfiguration & { schemaVersion: 2 } {
  return { schemaVersion: 2, overrides: [], customSkills: createSkillConfiguration(skills.filter(skill => !skill.builtIn)).customSkills };
}

export function persistOwnedSkills(skills: SkillDefinition[]) {
  const key = "opsark.skillConfiguration", previous = localStorage.getItem(key);
  let isV2 = false;
  try { isV2 = JSON.parse(previous || "null")?.schemaVersion === 2; } catch { /* Preserve corrupt source before replacing it. */ }
  if (previous && !localStorage.getItem(`${key}.v03.backup`) && !isV2) {
    localStorage.setItem(`${key}.v03.backup`, previous);
  }
  localStorage.setItem(key, JSON.stringify(createOwnedSkillConfiguration(skills)));
}

export function enforceSystemSkills(skills: SkillDefinition[]) {
  return ownedSkills(createOwnedSkillConfiguration(skills));
}

export function pinTaskSkills(task: OpsTask, skills: SkillDefinition[]) {
  const previous = new Map((task.skillSnapshot ?? []).map(skill => [skill.id, skill]));
  task.skillSnapshot = (task.activeSkillIds ?? []).flatMap(id => {
    const skill = previous.get(id) ?? skills.find(skill => skill.id === id && skill.enabled);
    return skill ? [JSON.parse(JSON.stringify(skill)) as SkillDefinition] : [];
  });
}
