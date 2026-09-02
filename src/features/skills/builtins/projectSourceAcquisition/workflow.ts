import type { SkillInstructionContract } from "@/features/skills/instructionBuilder";
import { sourceAuthenticationBranches } from "@/features/skills/builtins/projectSourceAcquisition/authentication";

export const projectSourceAcquisitionContract: SkillInstructionContract = {
  preamble: [
    "只负责把 Git 项目源码获取到用户指定的最终目录并验证可用；不安装依赖、不构建、不部署。",
    "根据已有真实证据生成最短的可执行计划；未知条件会改变后续操作时，先检查该条件，下一轮再继续。",
  ],
  stages: [
    {
      id: "prepare",
      title: "确认获取目标和环境",
      enterWhen: "尚未确认仓库 URL、最终目录或目标现状",
      actions: [
        "从用户需求中确定原始仓库 URL、最终绝对目录和可选 ref；已经明确的 URL/路径直接写入步骤说明，不要为它单独生成 printf/echo 命令步骤",
        "用 kind=observe 的只读步骤检查 Git 可用性、目标父目录可写性和最终目录是否已存在；主命令结果就是证据，不再生成重复 validation",
        "已有目录不得自动删除或覆盖；如果是同源仓库，仅在用户要求更新时进入更新流程",
      ],
      evidence: ["仓库 URL 与最终目录", "Git 和写入条件", "目标目录状态"],
    },
    {
      id: "authenticate",
      title: "选择仓库认证方式",
      enterWhen: "仓库需要认证或认证状态尚未明确",
      actions: [
        "HTTPS 认证状态未知时，本轮只能生成 kind=observe 的有界匿名探测：使用原始 URL、设置 GIT_TERMINAL_PROMPT=0，并执行 git ls-remote；不得在同一轮生成 clone、凭据收集或其他依赖探测结果的步骤",
        "只有匿名探测的真实结构化结果明确证明需要认证后，才优先复用当前服务器中 target 匹配的完整 Git HTTPS 凭据组；步骤必须用 server-credential 引用或敏感变量占位符显式表达认证要求，不得靠 description/expected 中的自然语言暗示认证",
        "有多个匹配账号时请用户选择；没有匹配组时才同表单收集用户名和密码或令牌",
        "凭据只由执行器通过前台 PTY 回答 Git 的 Username/Password 提示；计划命令保留不含凭据的原始 URL",
      ],
      evidence: ["无需凭据，或唯一已选 server-credential 引用"],
      branches: sourceAuthenticationBranches,
    },
    {
      id: "acquire",
      title: "获取源码到最终目录",
      enterWhen: "目标路径可用，且仓库访问方式已确定",
      actions: [
        "用 kind=change 在可见 PTY 中前台执行 Git 获取命令并等待真实退出；使用用户要求的 ref、depth、submodule 或 LFS 选项",
        "新仓库应在本步成功时位于用户指定的最终目录；可直接获取到最终目录，也可使用不泄漏中间状态的安全等价实现",
      ],
      evidence: ["Git 命令真实退出码", "最终源码目录"],
    },
    {
      id: "verify",
      title: "验收最终仓库",
      enterWhen: "Git 获取命令已成功退出",
      actions: [
        "仅从最终绝对目录检查它是 Git 工作树、origin 与原始 URL 一致、HEAD 存在，并在用户指定 ref 时校验该 ref",
        "获取变更步骤的 validation 直接使用上述最终目录检查；如果验收被单独规划为 kind=observe，则直接使用该主命令结果，不再生成第二条校验",
      ],
      evidence: ["工作树、origin、HEAD 和请求 ref 的真实结果"],
    },
    {
      id: "handle-error",
      title: "按真实错误恢复或停止",
      enterWhen: "任一检查、认证、获取或验收步骤失败",
      actions: [
        "需要认证时进入凭据选择；远端明确拒绝凭据时停止并请用户更新或更换账号，不重复尝试同一凭据",
        "目标路径已存在时保留原内容并报告冲突；网络、DNS 或 TLS 失败时报告原始错误，只对明确的短暂错误做有限重试",
        "Git 命令或最终验收失败时不宣告完成；仅清理本任务明确创建的临时内容，然后基于新证据生成一次针对性调整",
      ],
      evidence: ["可操作的错误分类，或明确的完成验收结果"],
    },
  ],
  globalRules: [
    "保留用户的原始仓库 URL 和协议，不在 URL、命令、环境变量或文件中写入用户名、密码、令牌或敏感占位符。",
    "Git HTTPS 凭据只从当前服务器的 serverCredentialGroups 选择或通过 user.request_input 收集；不使用 server.resolve_connection 或 server.connect。",
    "不覆盖或删除用户已有目录，不把临时目录当作最终结果，不把真实失败改写为成功。",
  ],
};
