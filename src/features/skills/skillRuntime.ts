import type { OpsTask } from "@/types";

type SkillFactCollector = (task: OpsTask) => Record<string, unknown>;

const collectProjectFacts: SkillFactCollector = (task) => {
  const steps = [
    ...(task.planHistory ?? []).flatMap((round) => round.plan),
    ...task.plan,
  ].filter((step) => step.status === "completed");
  const repositoryUrls = new Set<string>();
  const workingDirectories = new Set<string>();
  for (const step of steps) {
    const text = `${step.command}\n${step.output ?? ""}`;
    for (const match of text.matchAll(/(?:https?:\/\/|git@)[^\s'"<>]+/gi)) repositoryUrls.add(match[0]);
    for (const match of step.command.matchAll(/\bgit\s+clone\b[^;&\n]*?\s+(\/[^\s;&'"\n]+)/gi)) {
      workingDirectories.add(match[1].replace(/[),]+$/, ""));
    }
    for (const match of step.command.matchAll(/(?:^|[;&]\s*)cd\s+(?:'([^']+)'|"([^"]+)"|(\/[^\s;&]+))/gi)) {
      const directory = match[1] ?? match[2] ?? match[3];
      if (directory?.startsWith("/")) workingDirectories.add(directory.replace(/[),]+$/, ""));
    }
  }
  return {
    repositoryUrls: [...repositoryUrls].slice(0, 8),
    workingDirectories: [...workingDirectories].slice(0, 16),
  };
};

const factCollectors: Record<string, SkillFactCollector> = {
  "project-source-acquisition": collectProjectFacts,
  "project-build": collectProjectFacts,
};

export function collectRuntimeSkillFacts(skillId: string, task: OpsTask) {
  return factCollectors[skillId]?.(task);
}
