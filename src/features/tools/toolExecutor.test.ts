import { describe, expect, it, vi } from "vitest";
import { executeToolCall, parseToolCommand, parseUserInputArguments } from "@/features/tools/toolExecutor";
import { resolveToolRegistry } from "@/features/tools/toolRegistry";

describe("tool executor", () => {
  it("parses the model-facing tool command protocol", () => {
    expect(parseToolCommand(
      'opsark-tool files.get_structure {"rootPath":"/opt/app","maxDepth":4}',
      "call-1",
    )).toEqual({
      id: "call-1",
      toolId: "files.get_structure",
      arguments: { rootPath: "/opt/app", maxDepth: 4 },
    });
    expect(parseToolCommand(
      'opsark-tool --files.get_structure {"rootPath":"/opt/app"}',
      "call-legacy",
    )?.toolId).toBe("files.get_structure");
    expect(parseToolCommand("uname -a", "call-2")).toBeUndefined();
    expect(() => parseToolCommand("opsark-tool files.get_structure []", "call-3")).toThrow("JSON 对象");
    expect(() => parseToolCommand("opsark-tool files.get_structure", "call-4")).toThrow("唯一工具 ID");
    expect(() => parseToolCommand('opsark-tool unknown.tool {"value":1}', "call-5")).toThrow("不存在或未注册");
    expect(() => parseToolCommand('opsark-tool files.get_structure {"rootPath":"/opt/app","unknown":1}', "call-6")).toThrow("不支持字段");
    expect(() => parseToolCommand('opsark-tool user.request_input {"title":"凭据","fields":[{"key":"PASSWORD","label":"密码","description":"用途","type":"password","required":true,"extra":1}]}', "call-7")).toThrow("不支持字段");
  });

  it.each([
    [
      "换行串联的多个调用",
      'opsark-tool files.get_structure {"rootPath":"/opt/app"}\nopsark-tool files.get_structure {"rootPath":"/srv/app"}',
    ],
    [
      "同一行串联的多个调用",
      'opsark-tool files.get_structure {"rootPath":"/opt/app"} opsark-tool files.get_structure {"rootPath":"/srv/app"}',
    ],
    [
      "跨行参数对象",
      'opsark-tool files.get_structure {\n"rootPath":"/opt/app"\n}',
    ],
  ])("拒绝非原子的工具命令：%s", (_name, command) => {
    expect(() => parseToolCommand(command, "call-non-atomic")).toThrow("单行原子调用");
  });

  it("拒绝在一个工具调用中拼接多个 JSON 参数对象", () => {
    expect(() => parseToolCommand(
      'opsark-tool files.get_structure {"rootPath":"/opt/app"} {"rootPath":"/srv/app"}',
      "call-multiple-objects",
    )).toThrow("单个 JSON 对象");
  });

  it("拒绝把敏感凭据伪装成普通文本输入", () => {
    expect(() => parseUserInputArguments({
      title: "Gitee 凭据",
      fields: [{
        key: "GIT_HTTP_CREDENTIAL",
        label: "Gitee 令牌",
        description: "用于仓库认证",
        type: "text",
        required: true,
      }],
    })).toThrow("必须使用 password 类型");
  });

  it("parses a structured Git credential pair without inferring roles from prose", () => {
    const request = parseUserInputArguments({
      title: "Gitee HTTPS 凭据",
      fields: [{
        key: "GIT_USERNAME", label: "账号密码", description: "歧义文字", type: "password", required: true,
        credential: { group: "gitee_read", kind: "git-https", role: "username", target: "GITEE.COM" },
      }, {
        key: "GIT_HTTP_CREDENTIAL", label: "密码账号", description: "仍是歧义文字", type: "password", required: true,
        credential: { group: "gitee_read", kind: "git-https", role: "secret", target: "gitee.com" },
      }],
    });

    expect(request.fields.map((field) => field.credential)).toEqual([
      { group: "gitee_read", kind: "git-https", role: "username", target: "gitee.com" },
      { group: "gitee_read", kind: "git-https", role: "secret", target: "gitee.com" },
    ]);
    expect(parseToolCommand(
      `opsark-tool user.request_input ${JSON.stringify(request)}`,
      "call-structured-credential",
    )?.arguments).toEqual(request);
  });

  it.each([
    {
      name: "missing secret role",
      fields: [{
        key: "GIT_USERNAME", label: "用户名", description: "用途", type: "password", required: true,
        credential: { group: "git", kind: "git-https", role: "username", target: "gitee.com" },
      }],
      error: "恰好包含一个 username 和一个 secret",
    },
    {
      name: "duplicate username role",
      fields: ["A", "B"].map((key) => ({
        key, label: key, description: "用途", type: "password", required: true,
        credential: { group: "git", kind: "git-https", role: "username", target: "gitee.com" },
      })),
      error: "恰好包含一个 username 和一个 secret",
    },
    {
      name: "mismatched targets",
      fields: [{
        key: "A", label: "A", description: "用途", type: "password", required: true,
        credential: { group: "git", kind: "git-https", role: "username", target: "gitee.com" },
      }, {
        key: "B", label: "B", description: "用途", type: "password", required: true,
        credential: { group: "git", kind: "git-https", role: "secret", target: "github.com" },
      }],
      error: "kind 和 target 必须完全一致",
    },
    {
      name: "template target not replaced",
      fields: [{
        key: "A", label: "A", description: "用途", type: "password", required: true,
        credential: { group: "git", kind: "git-https", role: "username", target: "REPOSITORY_HOST" },
      }, {
        key: "B", label: "B", description: "用途", type: "password", required: true,
        credential: { group: "git", kind: "git-https", role: "secret", target: "REPOSITORY_HOST" },
      }],
      error: "必须是精确主机名或 IP 地址",
    },
    {
      name: "optional credential field",
      fields: [{
        key: "A", label: "A", description: "用途", type: "password", required: false,
        credential: { group: "git", kind: "git-https", role: "username", target: "gitee.com" },
      }, {
        key: "B", label: "B", description: "用途", type: "password", required: true,
        credential: { group: "git", kind: "git-https", role: "secret", target: "gitee.com" },
      }],
      error: "必须设为必填",
    },
  ])("rejects an invalid credential contract: $name", ({ fields, error }) => {
    expect(() => parseUserInputArguments({ title: "Git credential", fields })).toThrow(error);
    expect(() => parseToolCommand(
      `opsark-tool user.request_input ${JSON.stringify({ title: "Git credential", fields })}`,
      "call-invalid-credential-contract",
    )).toThrow(error);
  });

  it("routes bounded file content reading and software checks", async () => {
    const readRemoteFileContent = vi.fn().mockResolvedValue({
      path: "/opt/app/README.md",
      content: "# App",
      totalBytes: 5,
      returnedBytes: 5,
      truncated: false,
      encoding: "utf-8",
    });
    const checkSoftware = vi.fn().mockResolvedValue({
      items: [{ name: "git", installed: true, path: "/usr/bin/git", version: "git version 2.43" }],
    });
    const dependencies = { getRemoteFileStructure: vi.fn(), readRemoteFileContent, checkSoftware };

    const fileResult = await executeToolCall({
      id: "read-1", toolId: "files.read_content", arguments: { path: "/opt/app/README.md", maxBytes: 4096 },
    }, resolveToolRegistry([]), dependencies);
    const softwareResult = await executeToolCall({
      id: "software-1", toolId: "software.check", arguments: { names: ["git"] },
    }, resolveToolRegistry([]), dependencies);

    expect(fileResult.success).toBe(true);
    expect(readRemoteFileContent).toHaveBeenCalledWith({ path: "/opt/app/README.md", maxBytes: 4096 });
    expect(softwareResult.success).toBe(true);
    expect(checkSoftware).toHaveBeenCalledWith({ names: ["git"], includeVersions: true });
  });

  it("parses CLI-style tool arguments emitted by the planner", () => {
    expect(parseToolCommand(
      'opsark-tool server.resolve_connection --host "10.213.81.54" --port 22',
      "call-cli-1",
    )).toEqual({
      id: "call-cli-1",
      toolId: "server.resolve_connection",
      arguments: { host: "10.213.81.54", port: 22 },
    });
    expect(parseToolCommand(
      "opsark-tool files.get_structure --root-path=/opt/app --include-hidden false --max-depth 4",
      "call-cli-2",
    )?.arguments).toEqual({ rootPath: "/opt/app", includeHidden: false, maxDepth: 4 });
    expect(() => parseToolCommand(
      "opsark-tool server.resolve_connection --host one --host two",
      "call-cli-3",
    )).toThrow("参数重复");
    expect(() => parseToolCommand(
      "opsark-tool server.connect --host 192.168.1.237 --passwordSecretKey TARGET_SSH_PASSWORD",
      "call-cli-4",
    )).toThrow("同时提供 username 和 passwordSecretKey");
  });

  it("routes a validated file structure call", async () => {
    const getRemoteFileStructure = vi.fn().mockResolvedValue({
      tree: "/opt/app/\n└── package.json",
      truncated: false,
      warnings: [],
    });

    const result = await executeToolCall({
      id: "call-1",
      toolId: "files.get_structure",
      arguments: { rootPath: "/opt/app", excludeDirectories: ["uploads"] },
    }, resolveToolRegistry([]), { getRemoteFileStructure });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ tree: "/opt/app/\n└── package.json", rootPath: "/opt/app", truncated: false, warnings: [] });
    expect(getRemoteFileStructure).toHaveBeenCalledWith(expect.objectContaining({
      rootPath: "/opt/app",
      excludeDirectories: expect.arrayContaining([".git", "node_modules", "uploads"]),
    }));
  });

  it("requires a readable name and purpose for every user input parameter", async () => {
    const request = parseUserInputArguments({
      title: "补充部署信息",
      description: "用于生成部署计划",
      fields: [{
        key: "targetPort",
        label: "服务端口",
        description: "应用启动后对外监听的 TCP 端口",
        type: "number",
        required: true,
      }],
    });
    expect(request.fields[0]).toMatchObject({ label: "服务端口", required: true });
    expect(() => parseUserInputArguments({
      title: "补充信息",
      fields: [{ key: "token", label: "令牌", type: "password", required: true }],
    })).toThrow("用途说明");

    const requestUserInput = vi.fn().mockResolvedValue({ title: request.title, values: { targetPort: 8080 } });
    const result = await executeToolCall({
      id: "input-1",
      toolId: "user.request_input",
      arguments: request as unknown as Record<string, unknown>,
    }, resolveToolRegistry([]), { getRemoteFileStructure: vi.fn(), requestUserInput });
    expect(result.success).toBe(true);
    expect(requestUserInput).toHaveBeenCalledWith(request);
  });

  it("routes a validated cross-server transfer without exposing credentials", async () => {
    const transferFileBetweenServers = vi.fn().mockResolvedValue({
      sourcePath: "/root/build/app.rpm",
      targetPath: "/root/app.rpm",
      transferredBytes: 42,
      sha256: "abc",
      targetServerId: "server-b",
    });
    const result = await executeToolCall({
      id: "transfer-1",
      toolId: "files.transfer_between_servers",
      arguments: {
        sourcePath: "/root/build/app.rpm",
        targetServer: "10.0.0.2",
        targetPath: "/root/app.rpm",
      },
    }, resolveToolRegistry([]), {
      getRemoteFileStructure: vi.fn(),
      transferFileBetweenServers,
    });

    expect(result.success).toBe(true);
    expect(transferFileBetweenServers).toHaveBeenCalledWith(expect.objectContaining({
      targetServer: "10.0.0.2",
      overwrite: undefined,
    }));
  });

  it("routes a native managed SSH connection by secret key", async () => {
    const connectServer = vi.fn().mockResolvedValue({
      serverId: "server-new",
      name: "192.168.1.23",
      host: "192.168.1.23",
      port: 22,
      username: "root",
      connected: true,
      info: { os: "Linux" },
    });
    const result = await executeToolCall({
      id: "connect-1",
      toolId: "server.connect",
      arguments: {
        host: "192.168.1.23",
        username: "root",
        passwordSecretKey: "ssh_password",
      },
    }, resolveToolRegistry([]), { getRemoteFileStructure: vi.fn(), connectServer });

    expect(result.success).toBe(true);
    expect(connectServer).toHaveBeenCalledWith(expect.objectContaining({
      host: "192.168.1.23",
      port: 22,
      username: "root",
      passwordSecretKey: "SSH_PASSWORD",
    }));
    expect(JSON.stringify(result.data)).not.toContain("password");
  });

  it("resolves a target-scoped managed credential reference without exposing its value", async () => {
    const resolveServerConnection = vi.fn().mockResolvedValue({
      found: true,
      serverId: "target-1",
      host: "192.168.1.23",
      port: 22,
      username: "root",
      credentialAvailable: true,
      credentialRef: "managed-server:target-1",
    });
    const result = await executeToolCall({
      id: "lookup-1",
      toolId: "server.resolve_connection",
      arguments: { host: "192.168.1.23" },
    }, resolveToolRegistry([]), { getRemoteFileStructure: vi.fn(), resolveServerConnection });

    expect(result.success).toBe(true);
    expect(resolveServerConnection).toHaveBeenCalledWith({ host: "192.168.1.23", port: 22 });
    expect(JSON.stringify(result.data)).not.toContain("password");
  });

  it("rejects disabled tools and invalid arguments", async () => {
    const dependency = { getRemoteFileStructure: vi.fn() };
    const disabled = resolveToolRegistry([{ id: "files.get_structure", enabled: false }]);
    const disabledResult = await executeToolCall({
      id: "call-2",
      toolId: "files.get_structure",
      arguments: { rootPath: "/opt/app" },
    }, disabled, dependency);
    const invalidResult = await executeToolCall({
      id: "call-3",
      toolId: "files.get_structure",
      arguments: { rootPath: "relative" },
    }, resolveToolRegistry([]), dependency);

    expect(disabledResult.error?.code).toBe("TOOL_DISABLED");
    expect(invalidResult.error?.code).toBe("TOOL_EXECUTION_FAILED");
    expect(dependency.getRemoteFileStructure).not.toHaveBeenCalled();
  });
});
