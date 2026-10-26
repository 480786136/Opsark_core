import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { buildSoftwareCheckCommand, parseSoftwareCheckOutput } from "./softwareCheck";
import { enforceToolResult } from "./toolResultContract";
import { buildToolEvidenceFacts } from "./toolEvidence";

const run = command => execFileSync(process.platform === "win32" ? "wsl.exe" : "/bin/sh",
  process.platform === "win32" ? ["-d", "Ubuntu-22.04", "--", "/bin/sh", "-s"] : ["-s"],
  { input: command, encoding: "utf8", timeout: 15000, maxBuffer: 1048576, stdio: ["pipe", "pipe", "pipe"] });

describe.skipIf(process.env.OPSARK_LOCAL_POSIX !== "1")("软件探测实际 POSIX 执行", () => {
  it("内建及 alias/function 不污染路径，实际输出可通过契约并被验收消费", () => {
    const names = ["test", "printf", "grep", "git"];
    const raw = run(`alias grep='grep --color=auto'
git() { printf 'wrong function must not execute'; }
${buildSoftwareCheckCommand({ names, includeVersions: false })}`);
    const call = { id: "actual-posix", toolId: "software.check", arguments: { names, includeVersions: false } };
    const result = enforceToolResult(call, { callId: call.id, toolId: call.toolId, success: true, data: parseSoftwareCheckOutput(raw) });
    expect(result.success).toBe(true);
    expect(result.data.items.filter(item => ["test", "printf", "grep"].includes(item.name)))
      .toHaveLength(3);
    for (const item of result.data.items.filter(item => item.installed)) expect(item.path).toMatch(/^\//);
    expect(result.data.items.find(item => item.name === "test").installed).toBe(true);
    expect(buildToolEvidenceFacts(call, result).evidenceComplete).toBe(true);
    expect(raw).not.toContain("alias");
    expect(raw).not.toContain("wrong function");
  }, 30000);

  it("相对/空 PATH、空格路径、目录、不可执行文件与纯内建均有准确的文件含义", () => {
    const names = ["fixture", "directory", "disabled", "read"];
    const raw = run(`opsark_fixture=$(mktemp -d /tmp/opsark-software-XXXXXX) || exit 1
case "$opsark_fixture" in /tmp/opsark-software-*) ;; *) exit 2 ;; esac
trap '/bin/rm -rf -- "$opsark_fixture"' EXIT
/bin/mkdir "$opsark_fixture/bin space" "$opsark_fixture/directory"
printf '#!/bin/sh\nprintf "fixture 1.0\\n"\n' > "$opsark_fixture/bin space/fixture"
/bin/chmod 700 "$opsark_fixture/bin space/fixture"
printf 'not executable' > "$opsark_fixture/disabled"
cd "$opsark_fixture" || exit 3
PATH='bin space:'
${buildSoftwareCheckCommand({ names, includeVersions: false })}`);
    const data = parseSoftwareCheckOutput(raw);
    expect(data.items[0]).toMatchObject({ name: "fixture", installed: true });
    expect(data.items[0].path).toMatch(/^\/tmp\/opsark-software-[^/]+\/bin space\/fixture$/);
    expect(data.items.slice(1).every(item => !item.installed && item.path === undefined)).toBe(true);
  }, 30000);

  it("对带空格的真实可执行路径加引号再获取版本", () => {
    const raw = run(`opsark_fixture=$(mktemp -d /tmp/opsark-software-XXXXXX) || exit 1
case "$opsark_fixture" in /tmp/opsark-software-*) ;; *) exit 2 ;; esac
trap '/bin/rm -rf -- "$opsark_fixture"' EXIT
/bin/mkdir "$opsark_fixture/bin space"
printf '#!/bin/sh\nprintf "fixture 1.0\\n"\n' > "$opsark_fixture/bin space/fixture"
/bin/chmod 700 "$opsark_fixture/bin space/fixture"
PATH="$opsark_fixture/bin space:/usr/bin:/bin"
${buildSoftwareCheckCommand({ names: ["fixture"], includeVersions: true })}`);
    expect(parseSoftwareCheckOutput(raw).items[0].version).toBe("fixture 1.0");
  }, 30000);
});
