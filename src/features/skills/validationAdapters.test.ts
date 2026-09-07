import { describe, expect, it } from "vitest";
import {
  analyzeSkillCommandFailure,
  analyzeSkillOutputSignals,
  parseSkillObservation,
} from "@/features/skills/validationAdapters";
import type { PlanStep } from "@/types";

describe("validation output signals", () => {
  it("does not certify the inspection shell itself as the target process", () => {
    const command = "ps -eo pid,args | awk '/java/ {print $0}'";
    const step = { command } as PlanStep;
    const result = parseSkillObservation("process", [
      "2577500 bash -c pid_file='/tmp/opsark-exec-test.pid'; setsid sh -lc 'ps -eo pid,args'",
      `2577554 sh -lc ${command}`,
    ], false, step);
    expect(result.status).toBe("unknown");
    expect(result.facts.processFound).toBeUndefined();
    expect(parseSkillObservation("process", ["42 /usr/bin/java -jar orders.jar"], false, step))
      .toMatchObject({ status: "matched", facts: { pids: [42] } });
    expect(parseSkillObservation("process", [], true, step).status).toBe("not_found");
  });
  it("captures Vite environment and chunk-size advisories", () => {
    const result = analyzeSkillOutputSignals([
      "NODE_ENV=production is not supported in the .env file.",
      "(!) Some chunks are larger than 500 kB after minification.",
      "✓ built in 36.66s",
    ]);

    expect(result.status).toBe("warning");
    expect(result.facts.warningCount).toBe(2);
    expect(result.facts.warningSamples).toEqual(expect.arrayContaining([
      expect.stringContaining("NODE_ENV=production"),
      expect.stringContaining("Some chunks are larger"),
    ]));
  });

  it("区分 Git 禁用交互提示和真实凭据被拒绝", () => {
    expect(analyzeSkillCommandFailure(
      "fatal: could not read Username for 'https://gitee.com': terminal prompts disabled",
    )).toMatchObject({
      facts: { category: "interactive_credential_required", credentialRejected: false },
    });
    expect(analyzeSkillCommandFailure(
      "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitee.com/team/app.git/'",
    )).toMatchObject({
      facts: { category: "credential_rejected", credentialRejected: true },
    });
    expect(analyzeSkillCommandFailure(
      "仓库认证未通过，远端再次请求密码或访问令牌；已停止本次命令。",
    )).toMatchObject({
      facts: { category: "credential_rejected", credentialRejected: true },
    });
  });

  it("不把 Maven failureaccess 依赖名误判为 EACCES 权限错误", () => {
    const result = analyzeSkillCommandFailure([
      "[INFO] Downloaded from central: https://repo.maven.apache.org/maven2/com/google/guava/failureaccess/1.0.1/failureaccess-1.0.1.jar",
      "[INFO] BUILD FAILURE",
      "[ERROR] Failed to execute goal: Fatal error compiling: java.lang.NoSuchFieldError: Class com.sun.tools.javac.tree.JCTree$JCImport does not have member field 'qualid'",
    ].join("\n"));

    expect(result).toMatchObject({
      reason: expect.stringContaining("JDK"),
      facts: {
        category: "jdk_tooling_incompatible",
        classification: {
          confidence: "high",
          sample: expect.stringContaining("NoSuchFieldError"),
        },
      },
    });
    expect(result.facts.category).not.toBe("permission_denied");
  });

  it("只在 EACCES 作为独立错误码或真实拒绝行时判定权限错误", () => {
    expect(analyzeSkillCommandFailure(
      "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied, mkdir '/opt/app'",
    )).toMatchObject({
      facts: { category: "permission_denied", classification: { confidence: "high" } },
    });
    expect(analyzeSkillCommandFailure(
      "assert.equal(packageName, 'failureaccess'); expected errno text EACCES in fixture\nBUILD FAILURE",
    )).toMatchObject({ facts: { category: "command_failed" } });
  });

  it("对常见确定性错误使用带证据行的精确分类", () => {
    expect(analyzeSkillCommandFailure("bash: pnpm: command not found"))
      .toMatchObject({ facts: { category: "command_not_found" } });
    expect(analyzeSkillCommandFailure("curl: (6) Could not resolve host: example.invalid"))
      .toMatchObject({ facts: { category: "network_failure" } });
    expect(analyzeSkillCommandFailure("HTTP/1.1 404 Not Found"))
      .toMatchObject({ facts: { category: "resource_not_found" } });
    expect(analyzeSkillCommandFailure("npm ERR! code ENOSPC\nno space left on device"))
      .toMatchObject({ facts: { category: "disk_full" } });
  });
});
