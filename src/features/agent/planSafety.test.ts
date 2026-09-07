import { describe, expect, it } from "vitest";
import {
  analyzeFailureMask,
  analyzePlanStepSafety,
  formatPlanSafetyIssue,
  normalizeRecoverableFailureMasks,
} from "@/features/agent/planSafety";

describe("plan safety", () => {
  it.each([
    ["command || true", "command", "EMPTY_SUCCESS_FALLBACK"],
    ["command; true", "command", "UNCONDITIONAL_SUCCESS_TAIL"],
    ["set +e; mysql -e 'SHOW DATABASES'; echo $?", "command", "SET_PLUS_E_STATUS_LOST"],
    ["mysql -e 'SHOW DATABASES' | head -20", "command", "PIPELINE_STATUS_LOST"],
    ["ssh host true || echo failed", "command", "REMOTE_FAILURE_ECHOED"],
    ["test -f artifact || echo missing", "validation", "VALIDATION_FAILURE_ECHOED"],
    ["build || { echo failed; exit 0; }", "command", "FAILURE_BRANCH_EXIT_ZERO"],
    ["git clone 'https://user:${secret.GIT_HTTP_CREDENTIAL}@gitee.com/team/app.git'", "command", "SECRET_IN_URL"],
    ["git clone https://user:actual-token@gitee.com/team/app.git", "command", "URL_EMBEDDED_CREDENTIAL"],
    ["git clone https://developer%40example.com@gitee.com/team/app.git", "command", "URL_EMBEDDED_CREDENTIAL"],
    ["curl 'https://example.test/archive?access_token=actual-token'", "command", "URL_EMBEDDED_CREDENTIAL"],
    ["GIT_ASKPASS=/tmp/askpass git clone https://gitee.com/team/app.git", "command", "ASKPASS_CREDENTIAL_SCRIPT"],
    ["export GIT_HTTP_CREDENTIAL='${secret.GIT_HTTP_CREDENTIAL}'; git clone https://gitee.com/team/app.git", "command", "SECRET_ENV_ASSIGNMENT"],
    ["export GIT_HTTP_CREDENTIAL='actual-token'; git clone https://gitee.com/team/app.git", "command", "SECRET_ENV_ASSIGNMENT"],
    ["sshpass -p '${secret.SSH_PASSWORD}' ssh user@host true", "command", "INSECURE_CREDENTIAL_HELPER"],
    ["git config --global credential.helper store", "command", "CREDENTIAL_PERSISTENCE"],
  ] as const)("returns a structured finding for %s", (script, field, ruleId) => {
    expect(analyzeFailureMask(script, field)).toMatchObject({ field, ruleId });
  });

  it("repairs every explicit zero-exit failure branch and revalidates it", () => {
    const source = "first || { echo first; exit 0; }; second || { echo second; exit 0; }";
    const normalized = normalizeRecoverableFailureMasks(source);
    expect(normalized.match(/__opsark_preserved_failure_status=\$\?;/g)).toHaveLength(2);
    expect(analyzeFailureMask(normalized, "command")).toBeUndefined();
  });

  it("repairs Chinese-path scripts without corrupting UTF-16 slice offsets", () => {
    const source = `f="/测试/📦 附件"; deploy "$f" || { echo 失败; exit 0; }`;
    const normalized = normalizeRecoverableFailureMasks(source);
    expect(normalized).toContain(`f="/测试/📦 附件"`);
    expect(normalized).toContain(`exit "$__opsark_preserved_failure_status"`);
    expect(analyzeFailureMask(normalized, "command")).toBeUndefined();
  });

  it("does not rewrite quoted or ambiguous exit text", () => {
    for (const script of [
      "printf '%s' '|| { exit 0; }'",
      "command || echo 'exit 0'",
      "command; exit 0",
      "command || { echo failed; exit 2; }",
    ]) {
      expect(normalizeRecoverableFailureMasks(script)).toBe(script);
    }
  });

  it("identifies the exact field without exposing command contents", () => {
    const analysis = analyzePlanStepSafety(
      "mysql -uroot -pvery-secret -e 'SELECT 1'",
      "test -f result || echo missing",
    );
    expect(analysis).toMatchObject({
      safe: false,
      issue: { field: "validation", ruleId: "VALIDATION_FAILURE_ECHOED" },
    });
    const message = formatPlanSafetyIssue("数据库验收", analysis.issue!);
    expect(message).toContain("命令尚未发送到服务器");
    expect(message).toContain("validation（独立后置校验）");
    expect(message).not.toContain("very-secret");
  });

  it("returns command and validation findings together", () => {
    const analysis = analyzePlanStepSafety(
      "deploy || true",
      "test -f result || echo missing",
    );
    expect(analysis.safe).toBe(false);
    expect(analysis.issues).toEqual([
      expect.objectContaining({ field: "command", ruleId: "EMPTY_SUCCESS_FALLBACK" }),
      expect.objectContaining({ field: "validation", ruleId: "VALIDATION_FAILURE_ECHOED" }),
    ]);
    expect(analysis.issue).toEqual(analysis.issues[0]);
  });

  it("does not flag quoted failure syntax or a correctly propagated set +e status", () => {
    expect(analyzePlanStepSafety(
      "printf '%s' '|| true'",
      "printf '%s' 'test || echo missing'",
    ).safe).toBe(true);
    expect(analyzePlanStepSafety(
      "set +e; mysql -e 'SELECT 1'; rc=$?; exit \"$rc\"",
      "test -f result",
    ).safe).toBe(true);
    const classifiedStatus = "pgrep -f -- '/opt/app/backend' >/dev/null; rc=$?; case \"$rc\" in 0) echo RUNNING;; 1) echo NOT_RUNNING;; *) exit \"$rc\";; esac";
    expect(analyzePlanStepSafety(classifiedStatus, classifiedStatus).safe).toBe(true);
  });

  it("allows bare HTTPS Git URLs but keeps usernames in the controlled PTY channel", () => {
    expect(analyzePlanStepSafety(
      "timeout 20 git ls-remote https://gitee.com/team/app.git HEAD",
      "git -C /opt/app rev-parse --verify HEAD^{commit}",
    ).safe).toBe(true);
    expect(analyzePlanStepSafety(
      "timeout 20 git ls-remote https://developer%40example.com@gitee.com/team/app.git HEAD",
      "git -C /opt/app rev-parse --verify HEAD^{commit}",
    )).toMatchObject({
      safe: false,
      issue: { ruleId: "URL_EMBEDDED_CREDENTIAL" },
    });
  });

  it("explains that an AskPass rejection protects the credential before execution", () => {
    const issue = analyzeFailureMask(
      "GIT_ASKPASS=/tmp/askpass git clone https://gitee.com/team/app.git",
      "command",
    );
    expect(issue).toMatchObject({ ruleId: "ASKPASS_CREDENTIAL_SCRIPT" });
    expect(formatPlanSafetyIssue("拉取源码", issue!)).toContain("独立的 PTY 提示响应通道");
  });

  it("keeps existing non-URL secret placeholders available to domain-specific execution paths", () => {
    expect(analyzePlanStepSafety(
      "mysql -uroot -p'${secret.MYSQL_ROOT_PASSWORD}' -e 'SELECT 1'",
      "mysql -uroot -p'${secret.MYSQL_ROOT_PASSWORD}' -N -B -e 'SELECT 1' | grep -qx 1",
    ).safe).toBe(true);
    expect(analyzePlanStepSafety(
      "PWD=/opt git -C /opt/app status --short",
      "git -C /opt/app rev-parse --is-inside-work-tree",
    ).safe).toBe(true);
  });
});
