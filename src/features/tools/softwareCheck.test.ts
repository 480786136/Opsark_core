import { describe, expect, it } from "vitest";
import {
  buildSoftwareCheckCommand,
  normalizeSoftwareCheckRequest,
  parseSoftwareCheckOutput,
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
    expect(command).toContain("command -v");
    expect(command).toContain("OPSARK_SOFTWARE");
    expect(parseSoftwareCheckOutput([
      "OPSARK_SOFTWARE\tgit\tinstalled\t/usr/bin/git\tgit version 2.43.0",
      "OPSARK_SOFTWARE\tdocker\tmissing\t\t",
    ].join("\n"))).toEqual({ items: [
      { name: "git", installed: true, path: "/usr/bin/git", version: "git version 2.43.0" },
      { name: "docker", installed: false, path: undefined, version: undefined },
    ] });
  });
});
