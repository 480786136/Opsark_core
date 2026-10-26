import { describe, expect, it } from "vitest";
import { parseBoundedFileAppend, boundedFileAppendProbe, validateBoundedFileAppendObservation } from "./boundedFileReconciliation";
import { sha256Utf8 } from "./planPreparation";
import fixtures from "../../../shared/bounded-file-reconciliation-fixtures.json";

export const appendCommand = "set -eu\nf='/tmp/发布记录.txt'\nb='/tmp/发布记录.txt.bak'\nprintf '%s\\n' 'old' | cmp - \"$f\"\ntest ! -e \"$b\"\ncp -p -- \"$f\" \"$b\"\nprintf '%s\\n' 'new' >> \"$f\"";
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
function observation(command = appendCommand) {
  const c = parseBoundedFileAppend(command)!;
  return ["OPSARK_BOUNDED_FILE_V1", "exec-1", c.commandSha256, boot, "812", "731", "0", "CURRENT_BOOT", boot,
    "PROCESS_GROUPS", "  1", " 900", "FILE_DIGESTS", `${c.afterSha256}  ${c.filePath}`,
    `${c.beforeSha256}  ${c.backupPath}`, `${c.afterSha256}  ${c.filePath}`, `${c.beforeSha256}  ${c.backupPath}`, "END"].join("\n");
}
describe("bounded Shell append contract", () => {
  it("matches the native parser and exact read-command protocol through shared fixtures", () => {
    for (const example of fixtures.accepted) {
      const contract = parseBoundedFileAppend(example.command)!;
      expect(contract).toMatchObject({ filePath: example.filePath, backupPath: example.backupPath,
        beforeSha256: sha256Utf8(example.before), afterSha256: sha256Utf8(example.after) });
      expect(boundedFileAppendProbe(contract, example.executionId)).toBe(example.probe);
    }
    for (const command of fixtures.rejected) expect(parseBoundedFileAppend(command)).toBeUndefined();
  });
  it("derives exact file, backup and pre/post hashes from the frozen ordinary Shell", () => {
    const c = parseBoundedFileAppend(appendCommand)!;
    expect(c).toMatchObject({ kind: "bounded_file_append", filePath: "/tmp/发布记录.txt", backupPath: "/tmp/发布记录.txt.bak",
      beforeSha256: sha256Utf8("old\n"), afterSha256: sha256Utf8("old\nnew\n"), commandSha256: sha256Utf8(appendCommand) });
    const heredoc = appendCommand.replace("printf '%s\\n' 'old' | cmp - \"$f\"", "cmp -s -- \"$f\" - <<'EOF'\nold\nEOF");
    expect(parseBoundedFileAppend(heredoc)).toMatchObject({ beforeSha256: c.beforeSha256, afterSha256: c.afterSha256 });
    expect(boundedFileAppendProbe(c, "exec-1")).toContain("'/tmp/opsark-receipt-exec-1/done'");
    expect(() => boundedFileAppendProbe(c, "../other")).toThrow();
  });
  it("does not turn arbitrary Shell, changed backups, extra effects or expansion into a contract", () => {
    for (const command of ["printf done", appendCommand + "\nrm /other", appendCommand.replace("cp -p --", "cp -rf --"),
      appendCommand.replace("'new'", '"$(touch /other)"'), appendCommand.replace("set -eu", "set -e"),
      appendCommand.replace("'/tmp/发布记录.txt.bak'", "'/tmp/发布记录.txt'"),
      appendCommand.replace("| cmp", "'|' cmp"), appendCommand.replace(">>", "'>>'"), appendCommand.replace("/tmp/", "/tmp/../")]) {
      expect(parseBoundedFileAppend(command), command).toBeUndefined();
    }
  });
  it("requires complete execution identity, exited process group, matching live files and original backup", () => {
    const c = parseBoundedFileAppend(appendCommand)!;
    const valid = observation();
    expect(validateBoundedFileAppendObservation(c, "exec-1", valid)).toBe(true);
    for (const invalid of [valid.replace("exec-1", "exec-other"), valid.replace(c.commandSha256, "f".repeat(64)),
      valid.replace("\n0\nCURRENT_BOOT", "\n1\nCURRENT_BOOT"), valid.replace("\n 900", "\n 812"),
      valid.replace(`CURRENT_BOOT\n${boot}`, `CURRENT_BOOT\n${"f".repeat(36)}`), valid.replace(c.beforeSha256, "0".repeat(64)),
      valid.replace(c.afterSha256, c.beforeSha256), valid.replace("\nEND", ""), valid + "\nextra",
      valid.replace("FILE_DIGESTS", "FILE_DIGESTS\npartial")]) {
      expect(validateBoundedFileAppendObservation(c, "exec-1", invalid), invalid).toBe(false);
    }
  });
});
