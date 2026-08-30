export interface SkillSuggestion {
  label: string;
  prompt: string;
}

export const SKILL_CATEGORY_IDS = [
  "connectivity",
  "source-control",
  "environment",
  "build",
  "data",
  "deployment",
  "transfer",
  "other",
] as const;

export type SkillCategory = typeof SKILL_CATEGORY_IDS[number];

export const SKILL_OPERATION_IDS = [
  "connect",
  "acquire",
  "install",
  "build",
  "inspect",
  "diagnose",
  "change",
  "deploy",
  "transfer",
] as const;

export type SkillOperation = typeof SKILL_OPERATION_IDS[number];

export const SKILL_EFFECT_IDS = ["read", "write"] as const;
export type SkillEffect = typeof SKILL_EFFECT_IDS[number];

/** A machine-checkable boundary for when a Skill may be selected. */
export interface SkillCapability {
  operation: SkillOperation;
  effect: SkillEffect;
}

export interface SkillDefinition {
  id: string;
  name: string;
  category: SkillCategory;
  description: string;
  version: number;
  enabled: boolean;
  builtIn: boolean;
  /** Selection is valid only when the classified request matches one complete capability pair. */
  capabilities: SkillCapability[];
  /** Optional semantic-selection hints. Plain text and regex forms are both shown to the model as hints. */
  matchRules: string[];
  instructions: string;
  /** Tools that this workflow must never dispatch, even when a model emits them. */
  forbiddenToolIds?: string[];
  suggestions?: SkillSuggestion[];
  updatedAt: string;
}

export interface SkillOverride {
  id: string;
  /** Built-in version against which this override was authored. */
  baseVersion?: number;
  name?: string;
  category?: SkillCategory;
  description?: string;
  enabled?: boolean;
  capabilities?: SkillCapability[];
  matchRules?: string[];
  instructions?: string;
  updatedAt?: string;
}

export interface SkillConfiguration {
  overrides: SkillOverride[];
  customSkills: SkillDefinition[];
}

export interface SkillValidationIssue {
  field: "name" | "description" | "capabilities" | "matchRules" | "instructions";
  message: string;
}

export interface ModelSkillDefinition {
  id: string;
  name: string;
  description: string;
  version: number;
  capabilities: SkillCapability[];
  instructions: string;
  forbiddenToolIds: string[];
}

export interface ModelSkillDirectoryEntry {
  id: string;
  name: string;
  category: SkillCategory;
  description: string;
  version: number;
  capabilities: SkillCapability[];
  selectionHints: string[];
}
