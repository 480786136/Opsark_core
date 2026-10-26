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
    : "version=$(\"$path\" --version 2>&1 | sed -n '1p'); version=$(printf '%s' \"$version\" | tr '\\t\\r\\n' '   ')";
  // command -v can return a builtin name, an alias definition or a function.
  // This contract describes executable files, so resolve PATH entries directly.
  // A subshell preserves the user's interactive variables and shell functions.
  return `(
opsark_find_executable() {
  opsark_remaining="\${PATH-}"
  while :; do
    opsark_dir="\${opsark_remaining%%:*}"
    [ -n "$opsark_dir" ] || opsark_dir=.
    if [ -f "$opsark_dir/$1" ] && [ -x "$opsark_dir/$1" ]; then
      case "$opsark_dir" in
        /*) printf '%s/%s' "$opsark_dir" "$1" ;;
        *) opsark_cwd=$(pwd -P) || return 2
           printf '%s/%s/%s' "$opsark_cwd" "$opsark_dir" "$1" ;;
      esac
      return 0
    fi
    case "$opsark_remaining" in
      *:*) opsark_remaining="\${opsark_remaining#*:}" ;;
      *) return 1 ;;
    esac
  done
}
for name in ${names}; do
  if path=$(opsark_find_executable "$name"); then
    ${versionLine}
    printf 'OPSARK_SOFTWARE\\t%s\\tinstalled\\t%s\\t%s\\n' "$name" "$path" "$version"
  else
    opsark_status=$?
    if [ "$opsark_status" -eq 1 ]; then
      printf 'OPSARK_SOFTWARE\\t%s\\tmissing\\t\\t\\n' "$name"
    else
      printf 'OPSARK_SOFTWARE\\t%s\\terror\\t\\t\\n' "$name"
    fi
  fi
done
)`;
}

export function parseSoftwareCheckOutput(output: string): SoftwareCheckResult {
  const items = output.split(/\r?\n/).filter((line) => line.startsWith(OUTPUT_PREFIX)).map((line) => {
    const fields = line.split("\t");
    const [, name, status, path, version] = fields;
    if (fields.length !== 5 || !SAFE_SOFTWARE_NAME.test(name ?? "") || !["installed", "missing"].includes(status)
      || (status === "installed" && !path.startsWith("/")) || (status === "missing" && (path || version))) {
      throw new Error("软件检查返回了无效的名称、状态或路径字段");
    }
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

/** Parse machine stdout, never the trimmed terminal presentation or stderr. */
export function parseSoftwareCheckReceipt(request: SoftwareCheckRequest, receipt: {
  success: boolean; exitCode?: number; stdout?: string; stdoutTruncated?: boolean;
}): SoftwareCheckResult {
  if (!receipt.success || receipt.exitCode !== 0) throw new Error("软件检查命令未正常完成");
  if (typeof receipt.stdout !== "string" || receipt.stdoutTruncated !== false) {
    throw new Error("软件检查缺少完整标准输出，不能确认检查覆盖范围");
  }
  const result = parseSoftwareCheckOutput(receipt.stdout);
  const expected = new Set(request.names);
  const actual = new Set(result.items.map(item => item.name));
  if (result.items.length !== expected.size || actual.size !== expected.size
    || [...actual].some(name => !expected.has(name))) {
    throw new Error("软件检查返回的名称与本次请求不一致，不能确认检查覆盖范围");
  }
  return result;
}
