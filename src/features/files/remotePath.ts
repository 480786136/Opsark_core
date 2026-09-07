export interface RemoteBreadcrumb {
  label: string;
  path: string;
}

/** 将远程路径统一为以 / 开头、不以 / 结尾的 POSIX 路径。 */
export function normalizeRemotePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.length ? `/${parts.join("/")}` : "/";
}

export function joinRemotePath(parent: string, name: string): string {
  return normalizeRemotePath(`${parent}/${name}`);
}

export function parentRemotePath(path: string): string {
  const normalized = normalizeRemotePath(path);
  if (normalized === "/") return "/";
  return normalizeRemotePath(normalized.slice(0, normalized.lastIndexOf("/")));
}

export function buildRemoteBreadcrumbs(path: string): RemoteBreadcrumb[] {
  const parts = normalizeRemotePath(path).split("/").filter(Boolean);
  return [
    { label: "/", path: "/" },
    ...parts.map((label, index) => ({
      label,
      path: `/${parts.slice(0, index + 1).join("/")}`,
    })),
  ];
}

/**
 * SFTP 文件名不允许改变目录层级，也不允许使用系统保留的导航名。
 * 返回错误码而不是界面文案，便于多语言层进行翻译。
 */
export function validateRemoteEntryName(name: string): "required" | "separator" | "reserved" | null {
  const value = name.trim();
  if (!value) return "required";
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) return "separator";
  if (value === "." || value === "..") return "reserved";
  return null;
}
