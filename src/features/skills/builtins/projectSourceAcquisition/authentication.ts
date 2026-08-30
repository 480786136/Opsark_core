import type { SkillInstructionBranch } from "@/features/skills/instructionBuilder";

export const GIT_HTTPS_CREDENTIAL_GROUP = "git_https_repository";

export const gitHttpsCredentialFields = [{
  key: "GIT_USERNAME",
  label: "Git HTTPS 用户名",
  description: "用于 REPOSITORY_HOST 的 Git HTTPS 登录用户名。",
  type: "password",
  required: true,
  credential: {
    group: GIT_HTTPS_CREDENTIAL_GROUP,
    kind: "git-https",
    role: "username",
    target: "REPOSITORY_HOST",
  },
}, {
  key: "GIT_HTTP_CREDENTIAL",
  label: "Git HTTPS 密码或访问令牌",
  description: "用于 REPOSITORY_HOST 仓库读取认证的密码或个人访问令牌。",
  type: "password",
  required: true,
  credential: {
    group: GIT_HTTPS_CREDENTIAL_GROUP,
    kind: "git-https",
    role: "secret",
    target: "REPOSITORY_HOST",
  },
}] as const;

const credentialRequest = JSON.stringify({
  title: "Git HTTPS 凭据",
  description: "收集 REPOSITORY_HOST 的仓库读取凭据，并按当前服务器长期保存。",
  fields: gitHttpsCredentialFields,
});

export const sourceAuthenticationBranches: readonly SkillInstructionBranch[] = [
  {
    id: "public",
    when: "原始 URL 可直接读取",
    actions: ["不收集凭据，直接获取源码"],
  },
  {
    id: "saved-credential",
    when: "HTTPS 需要认证，且当前服务器已有 target 匹配的完整 Git HTTPS 凭据组",
    actions: ["只有一组时直接复用", "有多组时请用户选择一组，不交叉组合字段"],
  },
  {
    id: "request-credential",
    when: "HTTPS 需要认证，但当前服务器没有匹配凭据组",
    actions: [
      `调用 opsark-tool user.request_input ${credentialRequest}`,
      "将 REPOSITORY_HOST 替换为仓库 URL 的精确主机，提交后使用工具返回的凭据引用",
    ],
  },
  {
    id: "rejected",
    when: "远端明确拒绝已选凭据",
    actions: ["停止重试同一凭据，请用户更新该组或选择另一组"],
  },
  {
    id: "ssh",
    when: "原始 URL 为 SSH",
    actions: ["使用已有 SSH Agent 或受信公钥；缺少公钥认证时报告配置需求"],
  },
] as const;
