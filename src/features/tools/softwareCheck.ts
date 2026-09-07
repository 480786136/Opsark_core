import type { SoftwareCheckRequest, SoftwareCheckResult } from "@/features/tools/types";

const SAFE_SOFTWARE_NAME = /^[A-Za-z0-9+._-]+$/;
const OUTPUT_PREFIX = "OPSARK_SOFTWARE\t";

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function normalizeSoftwareCheckRequest(value: Record<string, unknown>): SoftwareCheckRequest {
  if (!Array.isArray(value.names) || value.names.length < 1 || value.names.length > 20) {
    throw new Error("names 必须包含 1 到 20 个软件名称");
  }
  const names = [...new Set(value.names.map((name) => typeof name === "string" ? name.trim() : ""))];
  if (names.some((name) => !SAFE_SOFTWARE_NAME.test(name))) {
    throw new Error("软件名称只能包含字母、数字、点、加号、下划线和连字符");
  }
  if (value.includeVersions !== undefined && typeof value.includeVersions !== "boolean") {
    throw new Error("includeVersions 必须是布尔值");
  }
  return { names, includeVersions: value.includeVersions !== false };
}

export function buildSoftwareCheckCommand(request: SoftwareCheckRequest) {
  const names = request.names.map(shellQuote).join(" ");
  const versionLine = request.includeVersions === false
    ? "version=''"
    : "version=$($path --version 2>&1 | sed -n '1p'); version=$(printf '%s' \"$version\" | tr '\\t\\r\\n' '   ')";
  return `for name in ${names}; do
  if path=$(command -v -- "$name" 2>/dev/null); then
    ${versionLine}
    printf 'OPSARK_SOFTWARE\\t%s\\tinstalled\\t%s\\t%s\\n' "$name" "$path" "$version"
  else
    printf 'OPSARK_SOFTWARE\\t%s\\tmissing\\t\\t\\n' "$name"
  fi
done`;
}

export function parseSoftwareCheckOutput(output: string): SoftwareCheckResult {
  const items = output.split(/\r?\n/).filter((line) => line.startsWith(OUTPUT_PREFIX)).map((line) => {
    const [, name, status, path, version] = line.split("\t");
    return {
      name,
      installed: status === "installed",
      path: path || undefined,
      version: version || undefined,
    };
  });
  if (!items.length) throw new Error("软件检查未返回可解析的结构化结果");
  return { items };
}
