import { compileSkillInstructions } from "@/features/skills/instructionBuilder";
import { projectSourceAcquisitionContract } from "@/features/skills/builtins/projectSourceAcquisition/workflow";
import type { SkillDefinition } from "@/features/skills/types";

export const projectSourceAcquisitionSkill: SkillDefinition = {
  id: "project-source-acquisition",
  name: "项目源码获取",
  category: "source-control",
  description: "将公开或私有 Git 仓库获取到指定目录，处理服务器级凭据复用、常见错误和最终仓库验收。",
  version: 12,
  enabled: true,
  builtIn: true,
  matchRules: [
    "git clone",
    "克隆代码仓库",
    "下载或获取项目源码",
    "拉取私有仓库",
    "更新代码仓库",
    "检出指定分支或提交",
    "regex:(?:克隆|获取|下载|拉取|检出|同步|更新).*(?:仓库|代码|源码|项目)|(?:仓库|代码|源码|项目).*(?:克隆|获取|下载|拉取|检出|同步|更新)",
  ],
  allowedToolIds: ["user.request_input"],
  forbiddenToolIds: ["server.resolve_connection", "server.connect"],
  instructions: compileSkillInstructions(projectSourceAcquisitionContract),
  planningContract: {
    sourceInstructions: compileSkillInstructions(projectSourceAcquisitionContract),
    initialOnly: true,
    globalInstructions: [...projectSourceAcquisitionContract.preamble, ...projectSourceAcquisitionContract.globalRules].join("\n"),
    acceptanceInstructions: compileSkillInstructions({
      preamble: [], globalRules: [],
      stages: projectSourceAcquisitionContract.stages.filter(({ id }) => id === "verify" || id === "handle-error"),
    }),
    stages: [{
      id: "prepare", title: "确认获取目标和环境", requiresTools: [],
      allowedToolIds: ["user.request_input"],
      exitEvidence: "仓库 URL、最终目录、Git 与目标目录状态",
      instructions: compileSkillInstructions({
        preamble: ["本轮仅执行准备检查。检查完成后加载完整认证、获取和验收流程；不得猜测匿名访问或认证结果。"],
        globalRules: [], stages: projectSourceAcquisitionContract.stages.filter(({ id }) => id === "prepare"),
      }),
    }],
  },
  updatedAt: "2026-08-25T12:00:00.000Z",
};
