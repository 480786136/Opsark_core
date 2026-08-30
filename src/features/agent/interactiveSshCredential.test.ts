import { describe, expect, it } from "vitest";
import {
  resolveInteractivePtyCredential,
  resolveInteractiveSshPromptSecret,
} from "@/features/agent/interactiveSshCredential";

const metadata = [{
  key: "PASSWORD",
  description: "用于登录192.168.1.237的SSH密码",
  scope: "server" as const,
  serverId: "source",
}];

const gitMetadata = [{
  key: "GIT_HTTP_CREDENTIAL",
  description: "用于认证 gitee.com 私有 Git 仓库的密码或访问令牌",
  scope: "server" as const,
  serverId: "source",
}];

const savedGitGroupMetadata = [{
  key: "GIT_USERNAME",
  description: "用于 gitee.com 的 Git HTTPS 用户名",
  scope: "server" as const,
  serverId: "source",
  credentialGroupId: "gitee-main",
  credentialKind: "git-https" as const,
  credentialRole: "username" as const,
  credentialTarget: "gitee.com",
  credentialLabel: "Gitee 主账号",
}, {
  key: "GIT_HTTP_CREDENTIAL",
  description: "用于 gitee.com 的 Git HTTPS 访问令牌",
  scope: "server" as const,
  serverId: "source",
  credentialGroupId: "gitee-main",
  credentialKind: "git-https" as const,
  credentialRole: "secret" as const,
  credentialTarget: "gitee.com",
  credentialLabel: "Gitee 主账号",
}];

const savedSshGroupMetadata = [{
  key: "TARGET_SSH_USERNAME",
  description: "用于 192.168.1.237 的 SSH 用户名",
  scope: "server" as const,
  serverId: "source",
  credentialGroupId: "ssh-target",
  credentialKind: "ssh-password" as const,
  credentialRole: "username" as const,
  credentialTarget: "192.168.1.237",
  credentialLabel: "目标服务器 SSH",
}, {
  key: "TARGET_SSH_PASSWORD",
  description: "用于 192.168.1.237 的 SSH 密码",
  scope: "server" as const,
  serverId: "source",
  credentialGroupId: "ssh-target",
  credentialKind: "ssh-password" as const,
  credentialRole: "secret" as const,
  credentialTarget: "192.168.1.237",
  credentialLabel: "目标服务器 SSH",
}];

describe("interactive SSH credential selection", () => {
  it("reuses a complete server credential group in a new task without task confirmation", () => {
    expect(resolveInteractivePtyCredential({
      command: "GIT_TERMINAL_PROMPT=1 git clone https://gitee.com/team/app.git /opt/app",
      description: "使用服务器已保存的 ${secret.GIT_HTTP_CREDENTIAL}",
      expected: "仓库获取完成",
    }, [], {
      GIT_USERNAME: "saved-developer",
      GIT_HTTP_CREDENTIAL: "saved-token",
    }, savedGitGroupMetadata)).toEqual({
      status: "resolved",
      credential: {
        kind: "git-https",
        username: "saved-developer",
        secret: "saved-token",
        target: "gitee.com",
      },
    });
  });

  it("requires an explicit saved group when multiple accounts match the same host", () => {
    const secondGroup = savedGitGroupMetadata.map((item) => ({
      ...item,
      key: `${item.key}_2`,
      credentialGroupId: "gitee-company",
      credentialLabel: "Gitee 公司账号",
    }));
    const values = {
      GIT_USERNAME: "personal",
      GIT_HTTP_CREDENTIAL: "personal-token",
      GIT_USERNAME_2: "company",
      GIT_HTTP_CREDENTIAL_2: "company-token",
    };
    const step = {
      command: "git clone https://gitee.com/team/app.git /opt/app",
      description: "使用服务器已保存的 Gitee 凭据",
      expected: "仓库获取完成",
    };
    expect(resolveInteractivePtyCredential(step, [], values, [
      ...savedGitGroupMetadata,
      ...secondGroup,
    ])).toMatchObject({
      status: "blocked",
      code: "credential-group-ambiguous",
    });
    expect(resolveInteractivePtyCredential({
      ...step,
      description: "使用 server-credential:gitee-company 和 ${secret.GIT_HTTP_CREDENTIAL_2}",
    }, [], values, [...savedGitGroupMetadata, ...secondGroup])).toMatchObject({
      status: "resolved",
      credential: {
        username: "company",
        secret: "company-token",
      },
    });
  });
  it("uses an explicitly referenced confirmed secret for foreground scp", () => {
    expect(resolveInteractiveSshPromptSecret({
      command: "scp file root@192.168.1.237:/test/file",
      description: "使用 ${secret.PASSWORD} 响应目标 SSH 认证",
      expected: "传输完成",
    }, ["PASSWORD"], { PASSWORD: "private" }, metadata)).toBe("private");
  });

  it("reuses a server SSH credential group across tasks while only expanding the username at execution", () => {
    expect(resolveInteractivePtyCredential({
      command: "scp -- /tmp/app.tar ${secret.TARGET_SSH_USERNAME}@192.168.1.237:/opt/app.tar",
      description: "使用 server-credential:ssh-target 和 ${secret.TARGET_SSH_PASSWORD} 进行 SCP 认证",
      expected: "传输完成",
    }, [], {
      TARGET_SSH_USERNAME: "deploy",
      TARGET_SSH_PASSWORD: "private",
    }, savedSshGroupMetadata)).toEqual({
      status: "resolved",
      credential: {
        kind: "password",
        secret: "private",
        target: "192.168.1.237",
      },
    });
  });

  it("rejects an unsafe SSH username before it can be expanded into a shell command", () => {
    expect(resolveInteractivePtyCredential({
      command: "scp /tmp/app.tar ${secret.TARGET_SSH_USERNAME}@192.168.1.237:/opt/app.tar",
      description: "使用 server-credential:ssh-target 和 ${secret.TARGET_SSH_PASSWORD}",
      expected: "传输完成",
    }, [], {
      TARGET_SSH_USERNAME: "deploy;whoami",
      TARGET_SSH_PASSWORD: "private",
    }, savedSshGroupMetadata)).toMatchObject({
      status: "blocked",
      code: "credential-group-unresolved",
    });
  });

  it("matches a single target-scoped SSH password when the prose omits the placeholder", () => {
    expect(resolveInteractiveSshPromptSecret({
      command: "ssh -o BatchMode=no root@192.168.1.237 test -f /test/file",
      description: "验证目标文件",
      expected: "文件存在",
    }, ["PASSWORD"], { PASSWORD: "private" }, metadata)).toBe("private");
  });

  it("does not fall back to the only SSH credential when its target is another host", () => {
    expect(resolveInteractiveSshPromptSecret({
      command: "ssh -o BatchMode=no root@192.168.1.238 true",
      description: "验证目标连接",
      expected: "连接成功",
    }, ["PASSWORD"], { PASSWORD: "private" }, metadata)).toBeUndefined();
  });

  it("never injects a password into noninteractive or unrelated commands", () => {
    expect(resolveInteractiveSshPromptSecret({
      command: "ssh -o BatchMode=yes root@192.168.1.237 true",
      description: "认证探测",
      expected: "获得状态",
    }, ["PASSWORD"], { PASSWORD: "private" }, metadata)).toBeUndefined();
    expect(resolveInteractiveSshPromptSecret({
      command: "printf 'password:'",
      description: "普通输出",
      expected: "获得文本",
    }, ["PASSWORD"], { PASSWORD: "private" }, metadata)).toBeUndefined();
  });

  it("rejects an HTTPS URL username and keeps noninteractive probes credential-free", () => {
    expect(() => resolveInteractiveSshPromptSecret({
      command: "git clone https://developer@gitee.com/team/app.git /opt/.app.clone-1",
      description: "使用 ${secret.GIT_HTTP_CREDENTIAL} 响应 gitee.com 的 Git 认证提示",
      expected: "仓库获取完成",
    }, ["GIT_HTTP_CREDENTIAL"], { GIT_HTTP_CREDENTIAL: "git-token" }, gitMetadata))
      .toThrow("HTTPS URL userinfo 中包含用户名或凭据");

    expect(resolveInteractiveSshPromptSecret({
      command: "GIT_TERMINAL_PROMPT=0 git ls-remote https://gitee.com/team/app.git HEAD",
      description: "非交互认证探测",
      expected: "获得真实状态",
    }, ["GIT_HTTP_CREDENTIAL"], { GIT_HTTP_CREDENTIAL: "git-token" }, gitMetadata)).toBeUndefined();
  });

  it("requires Git HTTPS to provide the non-sensitive username before password injection", () => {
    expect(() => resolveInteractiveSshPromptSecret({
      command: "git clone https://gitee.com/team/app.git /opt/.app.clone-1",
      description: "使用 ${secret.GIT_HTTP_CREDENTIAL} 响应 gitee.com 的 Git 认证提示",
      expected: "仓库获取完成",
    }, ["GIT_HTTP_CREDENTIAL"], { GIT_HTTP_CREDENTIAL: "git-token" }, gitMetadata))
      .toThrow("未找到与它同表单提交或同服务器凭据组的 Git HTTPS 用户名");
  });

  it("pairs a raw Git HTTPS URL with username and token collected by the same input form", () => {
    const credential = resolveInteractivePtyCredential({
      command: "git clone https://gitee.com/team/app.git /opt/.app.clone-1",
      description: "使用 ${secret.GIT_HTTP_CREDENTIAL} 响应 gitee.com 的 Git 认证提示",
      expected: "仓库获取完成",
    }, ["GIT_HTTP_CREDENTIAL"], { GIT_HTTP_CREDENTIAL: "git-token" }, gitMetadata, {
      gitUsername: {
        value: "developer@example.com",
        label: "Gitee 登录名",
        description: "用于 gitee.com 仓库认证",
        type: "text",
        groupId: "input-1",
        groupTitle: "Gitee 认证",
        submittedAt: "2026-08-24T00:00:00.000Z",
      },
    }, {
      GIT_HTTP_CREDENTIAL: {
        key: "GIT_HTTP_CREDENTIAL",
        label: "Gitee 个人访问令牌",
        description: "用于 gitee.com 私有仓库认证",
        groupId: "input-1",
        groupTitle: "Gitee 认证",
        submittedAt: "2026-08-24T00:00:00.000Z",
      },
    });

    expect(credential).toEqual({
      status: "resolved",
      credential: {
        kind: "git-https",
        username: "developer@example.com",
        secret: "git-token",
        target: "gitee.com",
      },
    });
  });

  it("attaches the credential when git clone appears later in a multi-line shell plan", () => {
    const credential = resolveInteractivePtyCredential({
      command: [
        "set -e",
        "TMP_DIR=/opt/.app.clone-1",
        "export GIT_TERMINAL_PROMPT=1",
        "git clone --progress https://gitee.com/team/app.git \"$TMP_DIR\"",
      ].join("\n"),
      description: "使用 ${secret.GIT_HTTP_CREDENTIAL} 响应 gitee.com 的 Git 认证提示",
      expected: "仓库获取完成",
    }, ["GIT_HTTP_CREDENTIAL"], { GIT_HTTP_CREDENTIAL: "git-token" }, gitMetadata, {
      gitUsername: {
        value: "developer@example.com",
        label: "Gitee 登录名",
        description: "用于 gitee.com 仓库认证",
        type: "text",
        groupId: "input-1",
        groupTitle: "Gitee 认证",
        submittedAt: "2026-08-24T00:00:00.000Z",
      },
    }, {
      GIT_HTTP_CREDENTIAL: {
        key: "GIT_HTTP_CREDENTIAL",
        label: "Gitee 密码或访问令牌",
        description: "用于 gitee.com 私有仓库认证",
        groupId: "input-1",
        groupTitle: "Gitee 认证",
        submittedAt: "2026-08-24T00:00:00.000Z",
      },
    });

    expect(credential).toMatchObject({
      status: "resolved",
      credential: {
        kind: "git-https",
        username: "developer@example.com",
        secret: "git-token",
        target: "gitee.com",
      },
    });
  });

  it("binds the collected Gitee username and token to the reported clone command", () => {
    const submittedAt = "2026-08-24T10:25:00.000Z";
    expect(resolveInteractivePtyCredential({
      command: [
        "site_dir=/opt/ground_check",
        "if [ -e \"$site_dir\" ]; then test ! -d \"$site_dir/.git\"; fi",
        "GIT_TERMINAL_PROMPT=1 git clone https://gitee.com/songpenley/ground_check.git \"$site_dir\"",
      ].join("\n"),
      description: "使用已收集的用户480786136@qq.com与${secret.GIT_HTTP_CREDENTIAL}通过HTTPS认证重新克隆",
      expected: "克隆成功且 HEAD 提交非空",
    }, ["GIT_HTTP_CREDENTIAL"], { GIT_HTTP_CREDENTIAL: "gitee-token" }, gitMetadata, {
      gitUsername: {
        value: "480786136@qq.com",
        label: "GitHTTPS用户名",
        description: "用于 gitee.com 的 HTTPS Git 认证",
        type: "text",
        groupId: "gitee-input",
        groupTitle: "Gitee HTTPS 凭据",
        submittedAt,
      },
    }, {
      GIT_HTTP_CREDENTIAL: {
        key: "GIT_HTTP_CREDENTIAL",
        label: "GitHTTPS密码或访问令牌",
        description: "用于 gitee.com 私有仓库的密码或访问令牌",
        groupId: "gitee-input",
        groupTitle: "Gitee HTTPS 凭据",
        submittedAt,
      },
    })).toEqual({
      status: "resolved",
      credential: {
        kind: "git-https",
        username: "480786136@qq.com",
        secret: "gitee-token",
        target: "gitee.com",
      },
    });
  });

  it("does not combine a new repository token with a username from another input form", () => {
    expect(resolveInteractivePtyCredential({
      command: "git clone https://gitee.com/team/app.git /opt/.app.clone-1",
      description: "使用 ${secret.GIT_HTTP_CREDENTIAL} 响应 gitee.com 的 Git 认证提示",
      expected: "仓库获取完成",
    }, ["GIT_HTTP_CREDENTIAL"], { GIT_HTTP_CREDENTIAL: "new-token" }, gitMetadata, {
      gitUsername: {
        value: "stale-user",
        label: "Gitee 登录名",
        description: "用于 gitee.com 仓库认证",
        type: "text",
        groupId: "old-input",
        groupTitle: "Gitee 认证",
        submittedAt: "2026-08-23T00:00:00.000Z",
      },
    }, {
      GIT_HTTP_CREDENTIAL: {
        key: "GIT_HTTP_CREDENTIAL",
        label: "Gitee 个人访问令牌",
        description: "用于 gitee.com 私有仓库认证",
        groupId: "new-input",
        groupTitle: "Gitee 认证",
        submittedAt: "2026-08-24T00:00:00.000Z",
      },
    })).toMatchObject({
      status: "blocked",
      code: "credential-username-missing",
    });
  });

  it("prefers an explicit gitUsername key and rejects ambiguous fuzzy username fields", () => {
    const baseStep = {
      command: "git clone https://gitee.com/team/app.git /opt/app",
      description: "使用 ${secret.GIT_HTTP_CREDENTIAL} 认证 gitee.com 仓库",
      expected: "仓库获取完成",
    };
    const binding = {
      GIT_HTTP_CREDENTIAL: {
        key: "GIT_HTTP_CREDENTIAL",
        label: "Gitee 令牌",
        description: "用于 gitee.com 仓库认证",
        groupId: "input-1",
        groupTitle: "Gitee 认证",
        submittedAt: "2026-08-24T00:00:00.000Z",
      },
    };
    const common = {
      type: "text" as const,
      groupId: "input-1",
      groupTitle: "Gitee 认证",
      submittedAt: "2026-08-24T00:00:00.000Z",
    };
    expect(resolveInteractivePtyCredential(
      baseStep,
      ["GIT_HTTP_CREDENTIAL"],
      { GIT_HTTP_CREDENTIAL: "token" },
      gitMetadata,
      {
        gitUsername: { ...common, value: "correct-user", label: "Git 用户名", description: "gitee.com 登录名" },
        contactAccount: { ...common, value: "wrong-user", label: "仓库账号", description: "gitee.com 用户名" },
      },
      binding,
    )).toMatchObject({
      status: "resolved",
      credential: { username: "correct-user" },
    });

    expect(resolveInteractivePtyCredential(
      baseStep,
      ["GIT_HTTP_CREDENTIAL"],
      { GIT_HTTP_CREDENTIAL: "token" },
      gitMetadata,
      {
        firstContact: { ...common, value: "first", label: "仓库用户名", description: "gitee.com 登录名" },
        secondContact: { ...common, value: "second", label: "仓库账号", description: "gitee.com 登录名" },
      },
      binding,
    )).toMatchObject({
      status: "blocked",
      code: "credential-username-missing",
    });
  });

  it("rejects username or secret values containing terminal control characters", () => {
    const step = {
      command: "git clone https://gitee.com/team/app.git /opt/app",
      description: "使用 ${secret.GIT_HTTP_CREDENTIAL} 认证 gitee.com 仓库",
      expected: "仓库获取完成",
    };
    const submittedInputs = {
      gitUsername: {
        value: "developer\rwhoami",
        label: "Git 用户名",
        description: "用于 gitee.com 仓库认证",
        type: "text" as const,
        groupId: "input-1",
        groupTitle: "Gitee 认证",
        submittedAt: "2026-08-24T00:00:00.000Z",
      },
    };
    const bindings = {
      GIT_HTTP_CREDENTIAL: {
        key: "GIT_HTTP_CREDENTIAL",
        label: "Gitee 令牌",
        description: "用于 gitee.com 仓库认证",
        groupId: "input-1",
        groupTitle: "Gitee 认证",
        submittedAt: "2026-08-24T00:00:00.000Z",
      },
    };
    expect(resolveInteractivePtyCredential(
      step,
      ["GIT_HTTP_CREDENTIAL"],
      { GIT_HTTP_CREDENTIAL: "token" },
      gitMetadata,
      submittedInputs,
      bindings,
    )).toMatchObject({
      status: "blocked",
      code: "credential-username-missing",
    });
    submittedInputs.gitUsername.value = "developer";
    expect(resolveInteractivePtyCredential(
      step,
      ["GIT_HTTP_CREDENTIAL"],
      { GIT_HTTP_CREDENTIAL: "token\nwhoami" },
      gitMetadata,
      submittedInputs,
      bindings,
    )).toMatchObject({
      status: "blocked",
      code: "credential-reference-unresolved",
    });
  });

  it("supports a one-command empty credential helper override without persisting credentials", () => {
    expect(resolveInteractivePtyCredential({
      command: "git -c credential.helper= ls-remote https://gitee.com/team/app.git HEAD",
      description: "使用 ${secret.GIT_HTTP_CREDENTIAL} 响应 gitee.com 的 Git 认证提示",
      expected: "返回 HEAD",
    }, [], {
      GIT_USERNAME: "developer",
      GIT_HTTP_CREDENTIAL: "git-token",
    }, savedGitGroupMetadata)).toEqual({
      status: "resolved",
      credential: {
        kind: "git-https",
        username: "developer",
        secret: "git-token",
        target: "gitee.com",
      },
    });
  });

  it.each([
    "git clone https://developer:${secret.GIT_HTTP_CREDENTIAL}@gitee.com/team/app.git /opt/app",
    "GIT_ASKPASS=/tmp/askpass git clone https://developer@gitee.com/team/app.git /opt/app",
    "export GIT_HTTP_CREDENTIAL=${secret.GIT_HTTP_CREDENTIAL}; git clone https://developer@gitee.com/team/app.git /opt/app",
  ])("does not inject a second copy of a credential into an unsafe command: %s", (command) => {
    expect(() => resolveInteractiveSshPromptSecret({
      command,
      description: "使用 ${secret.GIT_HTTP_CREDENTIAL} 响应 gitee.com 的 Git 认证提示",
      expected: "仓库获取完成",
    }, ["GIT_HTTP_CREDENTIAL"], { GIT_HTTP_CREDENTIAL: "git-token" }, gitMetadata))
      .toThrow("命令尚未发送到 PTY");
  });

  it("fails closed when repository authentication is requested without an explicit binding", () => {
    expect(() => resolveInteractiveSshPromptSecret({
      command: "git ls-remote https://gitee.com/team/app.git HEAD",
      description: "检查仓库认证",
      expected: "获得 HEAD",
    }, ["GIT_HTTP_CREDENTIAL"], { GIT_HTTP_CREDENTIAL: "git-token" }, gitMetadata))
      .toThrow("没有唯一可绑定到 gitee.com 的凭据组或敏感变量");
  });

  it("allows a public anonymous Git clone when no authentication is requested", () => {
    expect(resolveInteractivePtyCredential({
      command: "git clone https://gitee.com/open-source/public.git /opt/public",
      description: "克隆公开仓库",
      expected: "工作树存在",
    }, [], {}, [])).toEqual({
      status: "not-required",
      reason: "anonymous-git",
    });
  });

  it("blocks an explicit credential reference when Git prompts are disabled", () => {
    expect(resolveInteractivePtyCredential({
      command: "GIT_TERMINAL_PROMPT=0 git ls-remote https://gitee.com/team/private.git HEAD",
      description: "使用 ${secret.GIT_HTTP_CREDENTIAL} 认证私有仓库",
      expected: "返回 HEAD",
    }, ["GIT_HTTP_CREDENTIAL"], { GIT_HTTP_CREDENTIAL: "git-token" }, gitMetadata)).toMatchObject({
      status: "blocked",
      code: "interactive-prompt-disabled",
    });
  });

  it("blocks a missing server credential group instead of starting without a password", () => {
    expect(resolveInteractivePtyCredential({
      command: "git clone https://gitee.com/team/private.git /opt/private",
      description: "使用 server-credential:missing-gitee 认证",
      expected: "仓库获取完成",
    }, [], {}, [])).toMatchObject({
      status: "blocked",
      code: "credential-group-unresolved",
    });
  });
});
