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

export interface SkillDefinition {
  id: string;
  name: string;
  category: SkillCategory;
  description: string;
  version: number;
  enabled: boolean;
  builtIn: boolean;
  /** Optional semantic-selection hints. Plain text and regex forms are both shown to the model as hints. */
  matchRules: string[];
  instructions: string;
  /** Trusted optional projection; a prose override invalidates this contract. */
  planningContract?: {
    sourceInstructions: string;
    globalInstructions: string;
    acceptanceInstructions: string;
    /** Only shrink the first discovery request; resume full rules after execution. */
    initialOnly?: boolean;
    stages: Array<{
      id: string;
      title: string;
      instructions: string;
      allowedToolIds: string[];
      /** Only executor-recorded successful tool results satisfy these conditions. */
      requiresTools: string[];
      exitEvidence: string;
    }>;
  };
  /**
   * Complete set of model-callable tools this Skill may need across its
   * workflow. Missing means legacy/unrestricted for backward compatibility;
   * an empty list means the Skill is intentionally Shell-only.
   */
  allowedToolIds?: string[];
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
  matchRules?: string[];
  instructions?: string;
  updatedAt?: string;
}

export interface SkillConfiguration {
  overrides: SkillOverride[];
  customSkills: SkillDefinition[];
}

export interface SkillValidationIssue {
  field: "name" | "description" | "matchRules" | "instructions";
  message: string;
}

export interface ModelSkillDefinition {
  id: string;
  name: string;
  description: string;
  version: number;
  instructions: string;
  allowedToolIds?: string[];
  forbiddenToolIds: string[];
}

export interface ModelSkillDirectoryEntry {
  id: string;
  name: string;
  category: SkillCategory;
  description: string;
  version: number;
  selectionHints: string[];
}
