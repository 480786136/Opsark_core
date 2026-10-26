import type { OpsTask, PlanStep, SecretMetadata } from "@/types";
import { authenticationBlocker, authenticationFingerprint, describeAuthentication } from "./authenticationEvidence";
import { buildDatabaseAuthenticationCommand, type PostgresInspectionRequest } from "@/features/tools/databaseInspection";
import { ToolExecutionError } from "@/features/tools/toolFailure";

/** Resolve protected values only after checking the declared database identity.
 * A readonly collector must not become a way around the authentication gate. */
export function authorizeDatabaseInspection(task: OpsTask, step: PlanStep, request: PostgresInspectionRequest,
  metadata: SecretMetadata[], values: Record<string, string>) {
  const command = buildDatabaseAuthenticationCommand(request);
  const authenticationStep: PlanStep = { ...step, command, validation: "" };
  const descriptor = describeAuthentication(command);
  const deny = (message: string): never => { throw new ToolExecutionError(message, "permission", "not_sent"); };
  if (!descriptor?.target) deny("数据库采集缺少可核对的认证目标，尚未连接");
  let username = request.username ?? "", password: string | undefined;
  if (request.auth === "password") {
    const serverId = task.executionTargetServerId || task.serverId;
    const matching = (key: string | undefined, role: "username" | "secret") => metadata.filter(item => item.key === key
      && item.serverId === serverId && item.credentialKind === "database" && item.credentialRole === role
      && item.credentialTarget === descriptor!.target);
    const users = matching(request.usernameSecretKey, "username"), passwords = matching(request.passwordSecretKey, "secret");
    if (users.length !== 1 || passwords.length !== 1 || !users[0].credentialGroupId
      || users[0].credentialGroupId !== passwords[0].credentialGroupId) {
      deny("数据库用户名与密码必须来自同一已确认凭据组，并匹配当前服务器和精确端点");
    }
    username = values[request.usernameSecretKey!] ?? ""; password = values[request.passwordSecretKey!];
    if (!username || !password) deny("数据库凭据引用尚未填写，先通过受保护输入补齐用户名和密码");
  }
  const blocker = authenticationBlocker(task, authenticationStep, metadata);
  if (blocker) deny(`${blocker} 请先通过现有认证确认流程取得该连接的真实证据，再调用只读采集。`);
  return { authenticationStep, command, credentials: { username, ...(password === undefined ? {} : { password }) },
    fingerprint: authenticationFingerprint(task, authenticationStep),
    secretKeys: request.auth === "password" ? [request.usernameSecretKey!, request.passwordSecretKey!] : [] };
}
