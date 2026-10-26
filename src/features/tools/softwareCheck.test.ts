import { describe, expect, it } from "vitest";
import {
  buildSoftwareCheckCommand,
  normalizeSoftwareCheckRequest,
  parseSoftwareCheckOutput,
  parseSoftwareCheckReceipt,
} from "@/features/tools/softwareCheck";

describe("software check", () => {
  it("normalizes bounded exact command names", () => {
    expect(normalizeSoftwareCheckRequest({ names: ["git", "node", "git"] })).toEqual({
      names: ["git", "node"], includeVersions: true,
    });
    expect(() => normalizeSoftwareCheckRequest({ names: ["git; id"] })).toThrow("软件名称");
  });

  it("builds and parses structured terminal evidence", () => {
    const command = buildSoftwareCheckCommand({ names: ["git"], includeVersions: true });
    expect(command).toContain("opsark_find_executable");
    expect(command).not.toContain("command -v");
    expect(command).toContain('"$path" --version');
    expect(command).toContain("OPSARK_SOFTWARE");
    expect(parseSoftwareCheckOutput([
      "OPSARK_SOFTWARE\tgit\tinstalled\t/usr/bin/git\tgit version 2.43.0",
      "OPSARK_SOFTWARE\tdocker\tmissing\t\t",
    ].join("\n"))).toEqual({ items: [
      { name: "git", installed: true, path: "/usr/bin/git", version: "git version 2.43.0" },
      { name: "docker", installed: false, path: undefined, version: undefined },
    ] });
  });

  it.each([
    "OPSARK_SOFTWARE\ttest\tinstalled\ttest\t",
    "OPSARK_SOFTWARE\tgrep\tinstalled\talias grep='grep --color=auto'\t",
    "OPSARK_SOFTWARE\tgit\tunknown\t\t",
    "OPSARK_SOFTWARE\tgit\tmissing\t/usr/bin/git\t",
    "OPSARK_SOFTWARE\tgit\tinstalled\t/usr/bin/git\tversion\textra",
  ])("rejects corrupt adapter fields without leaking returned text", output => {
    expect(() => parseSoftwareCheckOutput(output)).toThrow("无效");
  });

  it("keeps a final empty version and multiple final empty missing fields in machine stdout", () => {
    const stdout = "OPSARK_SOFTWARE\tgit\tinstalled\t/usr/bin/git\t\r\nOPSARK_SOFTWARE\tmissing-tool\tmissing\t\t\r\n";
    expect(parseSoftwareCheckReceipt({ names: ["git", "missing-tool"], includeVersions: false },
      { success: true, exitCode: 0, stdout, stdoutTruncated: false }).items).toEqual([
      { name: "git", installed: true, path: "/usr/bin/git", version: undefined },
      { name: "missing-tool", installed: false, path: undefined, version: undefined },
    ]);
    expect(() => parseSoftwareCheckOutput(stdout.trim())).toThrow("无效");
  });

  it.each([
    { stdout: undefined, stdoutTruncated: false },
    { stdout: "OPSARK_SOFTWARE\tgit\tinstalled\t/usr/bin/git\t\n", stdoutTruncated: true },
    { stdout: "OPSARK_SOFTWARE\tgit\tinstalled\t/usr/bin/git\t\n", stdoutTruncated: undefined },
    { stdout: "OPSARK_SOFTWARE\tother\tinstalled\t/usr/bin/other\t\n", stdoutTruncated: false },
    { stdout: "OPSARK_SOFTWARE\tgit\tinstalled\t/usr/bin/git\t\n".repeat(2), stdoutTruncated: false },
  ])("rejects missing, partial or wrong request coverage", receipt => {
    expect(() => parseSoftwareCheckReceipt({ names: ["git"] }, { success: true, exitCode: 0, ...receipt })).toThrow();
  });

  it("does not treat successful display text or a partial command as a machine receipt", () => {
    expect(() => parseSoftwareCheckReceipt({ names: ["git"] }, { success: true, exitCode: 1,
      stdout: "OPSARK_SOFTWARE\tgit\tinstalled\t/usr/bin/git\t\n", stdoutTruncated: false })).toThrow("未正常完成");
  });
});
