export interface SkillInstructionBranch {
  id: string;
  when: string;
  actions: readonly string[];
}

export interface SkillInstructionStage {
  id: string;
  title: string;
  enterWhen: string;
  actions: readonly string[];
  evidence: readonly string[];
  branches?: readonly SkillInstructionBranch[];
  prohibitions?: readonly string[];
}

export interface SkillInstructionContract {
  preamble: readonly string[];
  stages: readonly SkillInstructionStage[];
  globalRules: readonly string[];
}

function numbered(items: readonly string[]) {
  return items.map((item, index) => `   ${index + 1}. ${item}`).join("\n");
}

/** Compiles maintainable workflow data into the existing model-facing Skill contract. */
export function compileSkillInstructions(contract: SkillInstructionContract) {
  const ids = contract.stages.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("Skill 阶段 ID 不能重复");
  const stages = contract.stages.map((stage, index) => {
    const sections = [
      `${index + 1}. [${stage.id}] ${stage.title}`,
      `   进入条件：${stage.enterWhen}`,
      `   执行契约：\n${numbered(stage.actions)}`,
      `   退出证据：\n${numbered(stage.evidence)}`,
    ];
    if (stage.branches?.length) {
      sections.push(`   状态分支：\n${stage.branches.map((branch) => (
        `   - [${branch.id}] ${branch.when}：${branch.actions.join("；")}`
      )).join("\n")}`);
    }
    if (stage.prohibitions?.length) sections.push(`   禁止：${stage.prohibitions.join("；")}`);
    return sections.join("\n");
  });
  return [
    ...contract.preamble,
    "",
    "阶段状态机（每轮只规划当前证据允许的最小阶段）：",
    stages.join("\n\n"),
    "",
    "全局硬约束：",
    numbered(contract.globalRules),
  ].join("\n");
}
