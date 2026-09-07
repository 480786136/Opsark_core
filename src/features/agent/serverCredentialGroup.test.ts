import { describe, expect, it } from "vitest";
import {
  allocateCredentialPairKeys,
  collectServerCredentialGroups,
  credentialUsernameValidationError,
  credentialGroupContext,
  inferCredentialInputPair,
} from "@/features/agent/serverCredentialGroup";
import type { SecretMetadata } from "@/types";

describe("server credential groups", () => {
  it("recognizes a Git username/token form as one durable credential pair", () => {
    expect(inferCredentialInputPair("Gitee HTTPS 凭据", [{
      key: "gitUsername", label: "Gitee 登录名", description: "用于 gitee.com Git 认证", type: "text", required: true,
    }, {
      key: "GIT_HTTP_CREDENTIAL", label: "Gitee 令牌", description: "用于 gitee.com 私有仓库", type: "password", required: true,
    }])).toMatchObject({
      kind: "git-https",
      target: "gitee.com",
      usernameField: { key: "gitUsername" },
      secretField: { key: "GIT_HTTP_CREDENTIAL" },
    });
  });

  it("recognizes the exact legacy Gitee form even when the password prose mentions an account", () => {
    expect(inferCredentialInputPair("提供Gitee HTTPS认证凭据", [{
      key: "GIT_USERNAME",
      label: "Gitee用户名",
      description: "https://gitee.com 平台账号的登录用户名，用于本次克隆认证。",
      type: "password",
      required: true,
    }, {
      key: "GIT_HTTP_CREDENTIAL",
      label: "Gitee密码或个人访问令牌",
      description: "https://gitee.com 平台账号的密码，或具有该仓库读取权限的个人访问令牌。",
      type: "password",
      required: true,
    }])).toMatchObject({
      kind: "git-https",
      target: "gitee.com",
      usernameField: { key: "GIT_USERNAME" },
      secretField: { key: "GIT_HTTP_CREDENTIAL" },
    });
  });

  it("uses explicit credential roles instead of ambiguous labels or descriptions", () => {
    const pair = inferCredentialInputPair("任意标题", [{
      key: "FIELD_A", label: "密码账号", description: "含 token 与 username 的歧义文本", type: "password", required: true,
      credential: { group: "git_auth", kind: "git-https", role: "username", target: "gitee.com" },
    }, {
      key: "FIELD_B", label: "账号密码", description: "含 account 与 credential 的歧义文本", type: "password", required: true,
      credential: { group: "git_auth", kind: "git-https", role: "secret", target: "gitee.com" },
    }]);

    expect(pair).toMatchObject({
      usernameField: { key: "FIELD_A" },
      secretField: { key: "FIELD_B" },
      kind: "git-https",
      target: "gitee.com",
    });
  });

  it("does not classify unrelated text input beside a password as a credential username", () => {
    expect(inferCredentialInputPair("部署配置", [{
      key: "region", label: "地域", description: "应用部署地域", type: "text", required: true,
    }, {
      key: "DEPLOY_TOKEN", label: "令牌", description: "制品库令牌", type: "password", required: true,
    }])).toBeUndefined();
  });

  it("accepts common SSH account names but rejects values that could alter a shell command", () => {
    expect(credentialUsernameValidationError("ssh-password", "deploy-user_01")).toBeUndefined();
    expect(credentialUsernameValidationError("ssh-password", "deploy;whoami")).toContain("SSH 用户名");
    expect(credentialUsernameValidationError("git-https", "developer@example.com")).toBeUndefined();
  });

  it("keeps multiple accounts in separate complete groups and exposes metadata only", () => {
    const metadata: SecretMetadata[] = [
      { key: "GIT_USERNAME", description: "Gitee 账号", scope: "server", serverId: "srv", credentialGroupId: "g1", credentialKind: "git-https", credentialRole: "username", credentialTarget: "gitee.com", credentialLabel: "Gitee 个人" },
      { key: "GIT_HTTP_CREDENTIAL", description: "Gitee 令牌", scope: "server", serverId: "srv", credentialGroupId: "g1", credentialKind: "git-https", credentialRole: "secret", credentialTarget: "gitee.com", credentialLabel: "Gitee 个人" },
      { key: "GIT_USERNAME_2", description: "Gitee 账号", scope: "server", serverId: "srv", credentialGroupId: "g2", credentialKind: "git-https", credentialRole: "username", credentialTarget: "gitee.com", credentialLabel: "Gitee 公司" },
      { key: "GIT_HTTP_CREDENTIAL_2", description: "Gitee 令牌", scope: "server", serverId: "srv", credentialGroupId: "g2", credentialKind: "git-https", credentialRole: "secret", credentialTarget: "gitee.com", credentialLabel: "Gitee 公司" },
    ];
    expect(collectServerCredentialGroups(metadata, "srv")).toHaveLength(2);
    expect(allocateCredentialPairKeys(metadata, "gitUsername", "GIT_HTTP_CREDENTIAL"))
      .toEqual({ usernameKey: "GIT_USERNAME_3", secretKey: "GIT_HTTP_CREDENTIAL_3" });
    const context = credentialGroupContext(metadata, "srv");
    expect(context[0]).toMatchObject({
      ref: "server-credential:g1",
      target: "gitee.com",
      usernamePlaceholder: "${secret.GIT_USERNAME}",
      secretPlaceholder: "${secret.GIT_HTTP_CREDENTIAL}",
    });
    expect(JSON.stringify(context)).not.toContain("developer@example.com");
  });

  it("ignores malformed groups instead of combining inconsistent fields", () => {
    const metadata: SecretMetadata[] = [
      { key: "USER", description: "user", scope: "server", serverId: "srv", credentialGroupId: "broken", credentialKind: "git-https", credentialRole: "username", credentialTarget: "gitee.com" },
      { key: "TOKEN", description: "token", scope: "server", serverId: "srv", credentialGroupId: "broken", credentialKind: "git-https", credentialRole: "secret", credentialTarget: "github.com" },
    ];

    expect(collectServerCredentialGroups(metadata, "srv")).toEqual([]);
  });
});
