import type { SkillDefinition } from "@/features/skills/types";

/** Preserve every paragraph verbatim; only the domain owner selects its stage. */
export function deploymentPlanningContract(instructions: string): SkillDefinition["planningContract"] {
  const paragraphs = instructions.split(/\n(?=\d+\. )/);
  if (paragraphs.length !== 11) return undefined;
  return {
    sourceInstructions: instructions,
    globalInstructions: [paragraphs[0], ...[2, 3, 5, 6, 9, 10].map((index) => paragraphs[index])].join("\n"),
    acceptanceInstructions: paragraphs[8],
    stages: [
      {
        id: "discover", title: "项目发现", requiresTools: [],
        allowedToolIds: ["files.get_structure", "files.read_content", "user.request_input"],
        instructions: paragraphs[1], exitEvidence: "同一目标项目的真实文件内容；目录名不证明技术栈",
      },
      {
        id: "prepare", title: "环境准备与部署", requiresTools: ["files.read_content"],
        allowedToolIds: ["files.get_structure", "files.read_content", "software.check", "user.request_input"],
        instructions: `${paragraphs[1]}\n${paragraphs[4]}\n${paragraphs[7]}`, exitEvidence: "项目声明证明的软件需求及最终部署验收证据",
      },
    ],
  };
}
