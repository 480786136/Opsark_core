export interface SkillSuggestion {
  label: string;
  prompt: string;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  version: number;
  enabled: boolean;
  builtIn: boolean;
  /** Optional semantic-selection hints. Plain text and regex forms are both shown to the model as hints. */
  matchRules: string[];
  instructions: string;
  suggestions?: SkillSuggestion[];
  updatedAt: string;
}

export interface SkillOverride {
  id: string;
  name?: string;
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
}

export interface ModelSkillDirectoryEntry {
  id: string;
  name: string;
  description: string;
  version: number;
  selectionHints: string[];
}
