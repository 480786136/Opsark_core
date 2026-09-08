import type { OpsTask } from "@/types";
import type { SkillDefinition, SkillEvidenceRequirement } from "./types";
import { currentEvidenceSteps, mayHaveChangedState, taskAttemptContext } from "@/features/agent/attemptState";
import { activeRoundSteps } from "@/features/agent/taskGoal";
import { collectPlanningEvidence, matchPlanningEvidence, planningEvidenceSatisfies } from "./planningEvidence";

type Contract = NonNullable<SkillDefinition["planningContract"]>;
const nonempty = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonempty);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function validRequirement(value: unknown): value is SkillEvidenceRequirement {
  if (!record(value) || !nonempty(value.kind)) return false;
  // Unknown selectors must not silently weaken a custom contract.
  if (Object.keys(value).some(key => !["kind", "toolIds", "complete", "scope", "facts", "minCount"].includes(key))) return false;
  return (value.toolIds === undefined || strings(value.toolIds))
    && (value.complete === undefined || typeof value.complete === "boolean")
    && (value.scope === undefined || nonempty(value.scope))
    && (value.minCount === undefined || (Number.isSafeInteger(value.minCount) && Number(value.minCount) > 0))
    && (value.facts === undefined || (record(value.facts) && Object.values(value.facts).every(item =>
      typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))));
}

function validContract(contract: Contract) {
  if (!nonempty(contract.globalInstructions) || !nonempty(contract.acceptanceInstructions)
    || !Array.isArray(contract.stages) || !contract.stages.length
    || (contract.initialOnly !== undefined && typeof contract.initialOnly !== "boolean")
    || (contract.afterMutation !== undefined && contract.afterMutation !== "full")
    || (contract.evidenceAdapters !== undefined && (!Array.isArray(contract.evidenceAdapters)
      || contract.evidenceAdapters.some(adapter => adapter !== "project_manifest")))) return false;
  const ids = new Set<string>();
  return contract.stages.every((stage, index) => {
    if (!record(stage) || !nonempty(stage.id) || ids.has(stage.id) || !nonempty(stage.title)
      || !nonempty(stage.instructions) || !nonempty(stage.exitEvidence)
      || !strings(stage.requiresTools) || !strings(stage.allowedToolIds)) return false;
    ids.add(stage.id);
    for (const requirements of [stage.requiresEvidence, stage.exitRequirements]) {
      if (requirements !== undefined && (!Array.isArray(requirements) || !requirements.every(validRequirement))) return false;
    }
    if (stage.producesEvidence !== undefined && !strings(stage.producesEvidence)) return false;
    if (stage.requiresTools.length && !stage.requiresEvidence?.length) return false;
    // Every transition has machine-checkable exits. The final stage stays open.
    return index === contract.stages.length - 1 || Boolean(stage.exitRequirements?.length);
  });
}

/** Ordered information loading only. Never sets task/step completion or executes a plan. */
export function planningSkills(task: OpsTask, skills: SkillDefinition[]): SkillDefinition[] {
  const history = activeRoundSteps(task);
  const current = currentEvidenceSteps(task, true);
  const tools = new Set(current.map(step => step.result?.facts.toolId));
  return skills.map(skill => {
    const contract = skill.planningContract;
    if (!contract || contract.sourceInstructions !== skill.instructions || !skill.allowedToolIds
      || !validContract(contract)) return skill;
    if (contract.initialOnly && history.some(step => ["completed", "failed"].includes(step.status))) return skill;
    const expanded = history.some(step => step.status === "completed"
      && step.attemptContext === taskAttemptContext(task)
      && step.result?.executionStatus === "success" && step.result.facts.toolId === "context.expand"
      && step.result.facts.expandedSkillId === skill.id);
    if (task.plan.some(step => step.status === "failed") || expanded
      || (contract.afterMutation === "full" && history.some(mayHaveChangedState))) return skill;

    const evidence = collectPlanningEvidence(task, contract.evidenceAdapters);
    let stageIndex = -1;
    for (let index = 0; index < contract.stages.length; index++) {
      const stage = contract.stages[index];
      if (!stage.requiresTools.every(tool => tools.has(tool))
        || !planningEvidenceSatisfies(evidence, stage.requiresEvidence)) return skill;
      // A stage's exits are what it must collect, not entry conditions.
      if (!stage.exitRequirements?.length || !planningEvidenceSatisfies(evidence, stage.exitRequirements)) {
        stageIndex = index;
        break;
      }
    }
    // All information stages exited: full rules still govern final acceptance.
    if (stageIndex < 0) return skill;
    const stage = contract.stages[stageIndex];
    const requirements = [...(stage.requiresEvidence ?? []), ...(stage.exitRequirements ?? [])];
    const matches = new Map(requirements.flatMap(requirement => matchPlanningEvidence(evidence, requirement))
      .map(item => [JSON.stringify([item.kind, item.scope]), item]));
    const directory = contract.stages.map((entry, index) =>
      `${entry.id}: ${entry.title} (${index < stageIndex ? "退出证据已满足" : index === stageIndex ? "当前" : "后续"})`,
    ).join("\n");
    return {
      ...skill,
      planningEvidence: { stageId: stage.id,
        observed: [...matches.values()].map(({ evidenceId, kind, scope, facts }) => ({ evidenceId, kind, scope, facts })) },
      allowedToolIds: [...new Set([...stage.allowedToolIds.filter(id => skill.allowedToolIds!.includes(id)), "context.expand"])],
      instructions: [contract.globalInstructions, contract.acceptanceInstructions,
        `当前阶段 ${stage.id}：\n${stage.instructions}`,
        `阶段产物：${stage.exitEvidence}`,
        `阶段条件：${JSON.stringify({ requires: stage.requiresEvidence, exits: stage.exitRequirements })}；匹配证据见上下文 skillEvidence。`,
        `阶段目录：\n${directory}`,
        `阶段不代表整体完成，证据仅覆盖所列资源。版本兼容与执行方式仍需读取原文判断。Shell 证据、其他项目格式或规则不足时，用 context.expand {"skillId":"${skill.id}","reason":"缺失信息"} 展开完整规则和工具；权限不变。`,
      ].join("\n\n"),
    };
  });
}
