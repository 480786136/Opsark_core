import { describe, expect, it } from "vitest";
import {
  analyzeSkillCommandFailure,
  analyzeSkillOutputSignals,
} from "@/features/skills/validationAdapters";

describe("validation output signals", () => {
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
});
