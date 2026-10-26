import type { ExecutionIntentSemantic } from "@/types";
import { sha256Utf8 } from "./planPreparation";

/** A deterministic contract for an ordinary, approved Shell append. This is not
 * a Shell interpreter: any syntax outside this small, literal grammar opts out. */
export interface BoundedFileAppendContract {
  version: 1;
  kind: "bounded_file_append";
  filePath: string;
  backupPath: string;
  beforeSha256: string;
  afterSha256: string;
  commandSha256: string;
}
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const pathSafe = (value: string) => value.startsWith("/") && !/[\r\n\0\\]/.test(value)
  && !value.split("/").some(part => part === "." || part === "..");

function words(line: string, variables: Map<string, string>): string[] | undefined {
  const result: string[] = [];
  let index = 0;
  while (index < line.length) {
    if (/\s/.test(line[index])) { index++; continue; }
    let word = "", consumed = false;
    while (index < line.length && !/\s/.test(line[index])) {
      consumed = true;
      if (line[index] === "'") {
        const end = line.indexOf("'", index + 1);
        if (end < 0) return undefined;
        const literal = line.slice(index + 1, end);
        if (["|", ">>", "<<"].includes(literal)) return undefined;
        word += literal; index = end + 1;
      } else if (line[index] === '"') {
        const end = line.indexOf('"', index + 1);
        if (end < 0) return undefined;
        const value = line.slice(index + 1, end);
        if (value === "'") word += "'";
        else if (/^\$[A-Za-z_]\w*$/.test(value) && variables.has(value.slice(1))) word += variables.get(value.slice(1));
        else return undefined;
        index = end + 1;
      } else {
        if ("|<>".includes(line[index])) {
          if (word) return undefined;
          const operator = line[index] === "|" ? "|" : line.slice(index, index + 2);
          if (!["|", ">>", "<<"].includes(operator)) return undefined;
          index += operator.length;
          if (index < line.length && !/\s/.test(line[index])) return undefined;
          word = operator; break;
        }
        if (!/[A-Za-z0-9_./%+!=|<>-]/.test(line[index])) return undefined;
        word += line[index++];
      }
    }
    if (consumed) result.push(word);
  }
  return result;
}

export function parseBoundedFileAppend(command: string): BoundedFileAppendContract | undefined {
  if (command.length > 16_384 || /[\r\0]/.test(command)) return undefined;
  const lines = command.trim().split("\n"), variables = new Map<string, string>();
  let cursor = 0;
  if (lines[cursor++]?.trim() !== "set -eu") return undefined;
  while (cursor < lines.length) {
    const assignment = /^([A-Za-z_]\w*)=(.+)$/.exec(lines[cursor].trim());
    if (!assignment) break;
    const value = words(assignment[2], variables);
    if (value?.length !== 1 || variables.has(assignment[1])) return undefined;
    variables.set(assignment[1], value[0]); cursor++;
  }
  const first = lines[cursor++]?.trim();
  if (!first) return undefined;
  let before: string, filePath: string;
  const heredoc = /^(cmp -s -- .+ -) <<'([A-Za-z_][A-Za-z0-9_]*)'$/.exec(first);
  if (heredoc) {
    const pre = words(heredoc[1], variables);
    if (pre?.length !== 5 || pre[4] !== "-") return undefined;
    filePath = pre[3];
    const end = lines.indexOf(heredoc[2], cursor);
    if (end < 0) return undefined;
    before = lines.slice(cursor, end).join("\n") + (end > cursor ? "\n" : ""); cursor = end + 1;
  } else {
    const pre = words(first, variables);
    if (!pre || pre[0] !== "printf" || pre[1] !== "%s\\n") return undefined;
    const pipe = pre.indexOf("|");
    if (pipe < 3 || pre.length !== pipe + 4 || pre[pipe + 1] !== "cmp" || pre[pipe + 2] !== "-") return undefined;
    before = pre.slice(2, pipe).map(value => value + "\n").join(""); filePath = pre[pipe + 3];
  }
  const absence = words(lines[cursor++]?.trim() ?? "", variables);
  if (absence?.length !== 4 || absence.slice(0, 3).join(" ") !== "test ! -e") return undefined;
  const backupPath = absence[3];
  const copy = words(lines[cursor++]?.trim() ?? "", variables);
  if (copy?.join("\0") !== ["cp", "-p", "--", filePath, backupPath].join("\0")) return undefined;
  const append = words(lines[cursor++]?.trim() ?? "", variables);
  if (!append || append[0] !== "printf" || append[1] !== "%s\\n" || append.length < 5
    || append[append.length - 2] !== ">>" || append[append.length - 1] !== filePath || cursor !== lines.length
    || !pathSafe(filePath) || !pathSafe(backupPath) || filePath === backupPath) return undefined;
  const after = before + append.slice(2, -2).map(value => value + "\n").join("");
  return { version: 1, kind: "bounded_file_append", filePath, backupPath,
    beforeSha256: sha256Utf8(before), afterSha256: sha256Utf8(after), commandSha256: sha256Utf8(command) };
}

export function boundedFileAppendContract(semantic: ExecutionIntentSemantic): BoundedFileAppendContract | undefined {
  return semantic.action.type === "shell" && semantic.runtimeClass === "bounded" && semantic.effect === "change"
    && semantic.executionScope === "isolated_exec" && semantic.targets.filter(target => target.role === "execution").length === 1
    ? parseBoundedFileAppend(semantic.action.command) : undefined;
}

/** Kept byte-identical to the native builder. The reader cannot run a validator
 * supplied by a model; it reads only the frozen paths and the executor receipt. */
export function boundedFileAppendProbe(contract: BoundedFileAppendContract, executionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(executionId)) throw new Error("原执行标识不合法，不能核对。");
  const receipt = quote(`/tmp/opsark-receipt-${executionId}/done`);
  const file = quote(contract.filePath), backup = quote(contract.backupPath);
  return `set -eu\ntest -f ${receipt} && test ! -L ${receipt}\ncat -- ${receipt}\nprintf '%s\\n' CURRENT_BOOT\ncat /proc/sys/kernel/random/boot_id\nprintf '%s\\n' PROCESS_GROUPS\ngroups=$(ps -eo pgid=) || exit 125\ngroup=$(awk 'NR==5 {print}' ${receipt}) || exit 125\ncase "$group" in ''|*[!0-9]*) exit 125;; esac\nprintf '%s\\n' "$groups" | awk -v p="$group" '$1 == p {found=1} END {print found ? p : 0}'\nprintf '%s\\n' FILE_DIGESTS\ntest -f ${file} && test ! -L ${file}\ntest -f ${backup} && test ! -L ${backup}\nsha256sum -- ${file} ${backup}\nsha256sum -- ${file} ${backup}\nprintf '%s\\n' END`;
}

export function validateBoundedFileAppendObservation(contract: BoundedFileAppendContract, executionId: string, output: string): boolean {
  const lines = output.trim().split(/\r?\n/);
  if (lines[0] !== "OPSARK_BOUNDED_FILE_V1" || lines[1] !== executionId || lines[2] !== contract.commandSha256
    || !/^[a-f0-9-]{36}$/.test(lines[3] ?? "") || !/^[1-9][0-9]*$/.test(lines[4] ?? "")
    || Number(lines[4]) < 2 || !/^[0-9]+$/.test(lines[5] ?? "") || lines[6] !== "0"
    || lines[7] !== "CURRENT_BOOT" || lines[8] !== lines[3] || lines[9] !== "PROCESS_GROUPS") return false;
  const boundary = lines.indexOf("FILE_DIGESTS", 10);
  if (boundary < 11 || lines.length !== boundary + 6 || lines[lines.length - 1] !== "END") return false;
  const groups = lines.slice(10, boundary).map(value => value.trim());
  if (groups.some(group => !/^[0-9]+$/.test(group)) || groups.includes(lines[4])) return false;
  return lines[boundary + 1] === `${contract.afterSha256}  ${contract.filePath}`
    && lines[boundary + 2] === `${contract.beforeSha256}  ${contract.backupPath}`
    && lines[boundary + 3] === lines[boundary + 1] && lines[boundary + 4] === lines[boundary + 2];
}
