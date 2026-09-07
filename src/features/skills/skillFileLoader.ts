import type { SkillDefinition } from "./types";
import { SKILL_CATEGORY_IDS } from "./types";

const resources = import.meta.glob<string>("./definitions/**/*.{json,md}", { query: "?raw", import: "default", eager: true });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

/** Drift detection only, not a signature or security boundary. */
export function skillSourceFingerprint(text: string) {
  text = text.replace(/\r\n/g, "\n");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return `fnv1a:${text.length}:${(hash >>> 0).toString(16)}`;
}

/** Files are bundled at build time. Configuration never executes code or resolves external paths. */
export function loadSkillDefinition(id: string, files: Record<string, string> = resources): SkillDefinition {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Invalid Skill id: ${id}`);
  const read = (path: unknown): string => {
    if (typeof path !== "string" || !/^[a-z0-9][a-z0-9/._-]*\.md$/.test(path)
      || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`Invalid Skill resource: ${id}`);
    const text = files[`./definitions/${id}/${path}`];
    if (typeof text !== "string" || !text.trim()) throw new Error(`Missing Skill resource: ${id}/${path}`);
    return text;
  };
  const manifest: unknown = JSON.parse(files[`./definitions/${id}/skill.json`] ?? "null");
  if (!object(manifest) || manifest.schemaVersion !== 1 || manifest.id !== id
    || !["name", "description", "updatedAt"].every(key => typeof manifest[key] === "string" && !!manifest[key])
    || !SKILL_CATEGORY_IDS.includes(manifest.category as never)
    || !Number.isSafeInteger(manifest.version) || Number(manifest.version) < 1
    || typeof manifest.enabled !== "boolean" || manifest.builtIn !== true
    || !strings(manifest.matchRules)
    || (manifest.allowedToolIds !== undefined && !strings(manifest.allowedToolIds))
    || (manifest.forbiddenToolIds !== undefined && !strings(manifest.forbiddenToolIds))) throw new Error(`Invalid Skill manifest: ${id}`);
  const { schemaVersion: _schemaVersion, planningContract, ...metadata } = manifest;
  const instructions = read(manifest.instructions);
  const definition = { ...metadata, instructions } as unknown as SkillDefinition;
  if (object(planningContract) && Array.isArray(planningContract.stages)
    && planningContract.sourceFingerprint === skillSourceFingerprint(instructions)) {
    try {
      definition.planningContract = {
        ...planningContract,
        sourceInstructions: instructions,
        globalInstructions: read(planningContract.globalInstructions),
        acceptanceInstructions: read(planningContract.acceptanceInstructions),
        stages: planningContract.stages.map(stage => {
          if (!object(stage)) throw new Error("Invalid stage");
          return { ...stage, instructions: read(stage.instructions) };
        }),
      } as SkillDefinition["planningContract"];
    } catch {
      // Full instructions remain authoritative if an optional stage resource is unavailable.
      delete definition.planningContract;
    }
  }
  return definition;
}

export function loadBuiltInSkills(): SkillDefinition[] {
  const ids: unknown = JSON.parse(resources["./definitions/catalog.json"]);
  if (!strings(ids) || new Set(ids).size !== ids.length) throw new Error("Invalid Skill catalog");
  return ids.map(id => loadSkillDefinition(id));
}
