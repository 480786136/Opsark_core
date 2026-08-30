import type { SkillDefinition, SkillValidationIssue } from "@/features/skills/types";

const LIMITS = { name: 80, description: 1000, instructions: 8000 } as const;

export function validateSkillMatchRule(rule: string) {
  const value = rule.trim();
  if (!value) return undefined;
  if (!value.startsWith("regex:")) return undefined;
  try {
    new RegExp(value.slice("regex:".length), "i");
    return undefined;
  } catch (error) {
    return `正则表达式无效：${String(error)}`;
  }
}

export function validateSkillDefinition(skill: SkillDefinition): SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];
  for (const field of ["name", "description", "instructions"] as const) {
    const value = skill[field].trim();
    if (!value) issues.push({ field, message: "此字段不能为空" });
    else if (value.length > LIMITS[field]) issues.push({ field, message: `不能超过 ${LIMITS[field]} 个字符` });
  }
  const invalidRule = skill.matchRules.map(validateSkillMatchRule).find(Boolean);
  if (invalidRule) issues.push({ field: "matchRules", message: invalidRule });
  if (!skill.capabilities.length) issues.push({ field: "capabilities", message: "至少需要一项能力边界" });
  return issues;
}

export function normalizeSkillDefinition(skill: SkillDefinition): SkillDefinition {
  return {
    ...skill,
    name: skill.name.trim(),
    description: skill.description.trim(),
    instructions: skill.instructions.trim(),
    capabilities: [...new Map(skill.capabilities.map((capability) => [
      `${capability.operation}:${capability.effect}`,
      capability,
    ])).values()],
    matchRules: [...new Set(skill.matchRules.map((rule) => rule.trim()).filter(Boolean))],
    updatedAt: new Date().toISOString(),
  };
}
