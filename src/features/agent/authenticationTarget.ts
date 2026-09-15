/** Authentication targets are identifiers, never commands or credential-bearing URLs. */
export function normalizeAuthenticationTarget(kind: string, value: string): string {
  const target = value.trim();
  if (!target || /[\u0000-\u001f\u007f-\u009f]/u.test(target)) {
    throw new Error("认证目标不能为空或包含控制字符");
  }
  if (kind === "database" && target.startsWith("/")) {
    if (target === "/" || target.endsWith("/") || /[?#*\[\]{}$`\\]/u.test(target)
      || target.split("/").slice(1).some(part => !part || part === "." || part === "..")) {
      throw new Error("socket 目标必须是明确的绝对路径，不能包含通配符、变量或路径跳转");
    }
    // Unix paths are case-sensitive. Spaces are legitimate path characters.
    return target;
  }
  if (/[\s/@?#]/u.test(target) || target.includes("://")) {
    throw new Error("认证目标必须是不含凭据的主机或服务标识；数据库 socket 可使用绝对路径");
  }
  if (kind === "database") {
    const endpoint = target.match(/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:]+\]):([0-9]{1,5})$/i);
    if (!endpoint || Number(endpoint[1]) < 1 || Number(endpoint[1]) > 65535) {
      throw new Error("数据库目标必须是已确认的主机:端口或 socket 绝对路径");
    }
  }
  return target.toLowerCase();
}
