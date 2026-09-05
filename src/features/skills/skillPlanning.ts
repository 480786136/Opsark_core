import type { OpsTask } from "@/types";
import type { SkillDefinition } from "@/features/skills/types";
import { currentEvidenceSteps, taskAttemptContext } from "@/features/agent/attemptState";
import { activeRoundSteps } from "@/features/agent/taskGoal";

/** Pure selection: never infer completion from plan prose, filenames or round count. */
export function planningSkills(task: OpsTask, skills: SkillDefinition[]): SkillDefinition[] {
  const current = currentEvidenceSteps(task);
  const tools = new Set(current.map((step) => step.result?.facts.toolId));
  const history = activeRoundSteps(task);
  const failed = task.plan.some((step) => step.status === "failed");
  return skills.map((skill) => {
    const contract = skill.planningContract;
    if (!contract || contract.sourceInstructions !== skill.instructions || !skill.allowedToolIds) return skill;
    if (contract.initialOnly && history.some((step) => ["completed", "failed"].includes(step.status))) return skill;
    const expanded = history.some((step) => step.status === "completed"
      && step.attemptContext === taskAttemptContext(task)
      && step.result?.facts.expandedSkillId === skill.id);
    // Failure recovery needs the entire workflow; expansion never changes permissions.
    if (failed || expanded) return skill;
    const stage = [...contract.stages].reverse().find((entry) => entry.requiresTools.every((tool) => tools.has(tool)));
    if (!stage) return skill;
    const directory = contract.stages.map((entry) =>
      `${entry.id}: ${entry.title}; 前置=${entry.requiresTools.join(",") || "无"}; 验收=${entry.exitEvidence}`,
    ).join("\n");
    return {
      ...skill,
      allowedToolIds: [...new Set([...stage.allowedToolIds.filter((id) => skill.allowedToolIds!.includes(id)), "context.expand"])],
      instructions: [contract.globalInstructions, contract.acceptanceInstructions,
        `当前阶段 ${stage.id}：\n${stage.instructions}`, `阶段目录：\n${directory}`,
        `阶段只决定信息加载，不证明整体完成。若证据通过 Shell 获得、目标不匹配或当前规则不足，调用 context.expand {"skillId":"${skill.id}","reason":"具体缺失信息"} 展开完整规则与该 Skill 原允许工具；权限和禁止工具不变。`,
      ].join("\n\n"),
    };
  });
}
