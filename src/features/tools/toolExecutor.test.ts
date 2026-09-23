import { describe, expect, it, vi } from "vitest";
import { executeToolCall, parseToolCommand, parseUserInputArguments } from "@/features/tools/toolExecutor";
import { ToolArgumentValidationError } from "@/features/tools/toolArgumentProtocol";
import { resolveToolRegistry } from "@/features/tools/toolRegistry";

describe("tool executor", () => {
  const selectField = {
    key: "target",
    label: "目标目录",
    description: "从已发现目录中选择需要继续检查的目标",
    type: "select",
    required: true,
    options: [
      { value: "/srv/app-a", label: "应用 A" },
      { value: "/srv/app-b", label: "应用 B" },
    ],
  };

  it("normalizes select forms without preselection or changing exact option strings", () => {
    const options = [
      { value: " /srv/app ", label: " 含空格的目录 " },
      { value: "/srv/app", label: "普通目录" },
    ];
    const request = parseUserInputArguments({
      title: "  选择检查目标  ", description: "  已发现两个目录  ",
      fields: [{ ...selectField, placeholder: "请选择目标", options }],
    });
    expect(request.title).toBe("选择检查目标");
    expect(request.description).toBe("已发现两个目录");
    expect(request.fields[0]).toMatchObject({ type: "select", options, placeholder: "请选择目标" });
    expect(request.fields[0]).not.toHaveProperty("value");
    expect(request.fields[0]).not.toHaveProperty("default");
    expect(request.fields[0]).not.toHaveProperty("credential");
    expect(request.fields[0].options).not.toBe(options);
    expect(parseUserInputArguments({ ...request })).toEqual(request);
    expect(parseUserInputArguments(JSON.parse(JSON.stringify(request)))).toEqual(request);
    expect(parseToolCommand(
      `opsark-tool user.request_input ${JSON.stringify(request)}`, "select-restored",
    )?.arguments).toEqual(request);
  });

  it.each([1, 100])("accepts %i known select candidates and an optional placeholder", (count) => {
    const options = Array.from({ length: count }, (_, index) => ({ value: `target-${index}`, label: `目标 ${index}` }));
    const request = parseUserInputArguments({ title: "选择目标", fields: [{ ...selectField, options }] });
    expect(request.fields[0].options).toEqual(options);
    expect(request.fields[0].placeholder).toBeUndefined();
  });

  it.each([
    { name: "missing options", patch: { options: undefined } },
    { name: "empty options", patch: { options: [] } },
    { name: "non-array options", patch: { options: "target-a" } },
    { name: "sparse options", patch: { options: Array(1) } },
    { name: "too many options", patch: { options: Array.from({ length: 101 }, (_, index) => ({ value: String(index), label: String(index) })) } },
    { name: "empty option value", patch: { options: [{ value: "", label: "目录" }] } },
    { name: "blank option value", patch: { options: [{ value: " \t ", label: "目录" }] } },
    { name: "non-string option value", patch: { options: [{ value: 1, label: "目录" }] } },
    { name: "empty option label", patch: { options: [{ value: "/srv/app", label: "" }] } },
    { name: "blank option label", patch: { options: [{ value: "/srv/app", label: " \t " }] } },
    { name: "missing option label", patch: { options: [{ value: "/srv/app" }] } },
    { name: "non-object option", patch: { options: ["/srv/app"] } },
    { name: "duplicate exact option values", patch: { options: [{ value: "/srv/app", label: "A" }, { value: "/srv/app", label: "B" }] } },
    { name: "options on text", patch: { type: "text" } },
    { name: "options on password", patch: { type: "password" } },
    { name: "options on number", patch: { type: "number" } },
    { name: "sensitive select field", patch: { key: "API_TOKEN" } },
    { name: "credential attached to select", patch: { credential: { group: "db", kind: "database", role: "username", target: "db.internal:3306" } } },
    { name: "default on field", patch: { default: "/srv/app-a" } },
    { name: "defaultValue on field", patch: { defaultValue: "/srv/app-a" } },
    { name: "selectedValue on field", patch: { selectedValue: "/srv/app-a" } },
    { name: "value on field", patch: { value: "/srv/app-a" } },
    { name: "preselected option", patch: { options: [{ value: "/srv/app", label: "目录", selected: true }] } },
    { name: "default option", patch: { options: [{ value: "/srv/app", label: "目录", default: true }] } },
  ])("rejects invalid select arguments in direct and command parsing: $name", ({ patch }) => {
    const request = { title: "选择目标", fields: [{ ...selectField, ...patch }] };
    expect(() => parseUserInputArguments(request)).toThrow();
    expect(() => parseToolCommand(
      `opsark-tool user.request_input ${JSON.stringify(request)}`, "select-invalid",
    )).toThrow();
  });

  it("rejects unexpected form and credential properties when called directly", () => {
    expect(() => parseUserInputArguments({ title: "选择目标", fields: [selectField], default: "/srv/app-a" }))
      .toThrow("不支持字段：default");
    expect(() => parseUserInputArguments({ title: "选择目标", description: 3, fields: [selectField] }))
      .toThrow("description 必须是字符串");
    expect(() => parseUserInputArguments({ title: "输入凭据", fields: [{
      key: "username", label: "账户", description: "连接数据库", type: "password", required: true,
      credential: { group: "db", kind: "database", role: "username", target: "db.internal:3306", default: "root" },
    }] })).toThrow("不支持字段：default");
  });

  it("routes select values as exact strings and rejects malformed forms before requesting input", async () => {
    const request = parseUserInputArguments({
      title: "选择操作目标", fields: [{ ...selectField, options: [{ value: "001", label: "实例 001" }] }],
    });
    const requestUserInput = vi.fn().mockResolvedValue({ title: request.title, values: { target: "001" } });
    const result = await executeToolCall({
      id: "select-valid", toolId: "user.request_input", arguments: { ...request },
    }, resolveToolRegistry([]), { getRemoteFileStructure: vi.fn(), requestUserInput });
    expect(requestUserInput).toHaveBeenCalledWith(request);
    expect(result).toMatchObject({ success: true, data: { values: { target: "001" } } });
    requestUserInput.mockClear();
    const invalid = await executeToolCall({
      id: "select-invalid", toolId: "user.request_input",
      arguments: { title: "选择操作目标", fields: [{ ...selectField, options: [] }] },
    }, resolveToolRegistry([]), { getRemoteFileStructure: vi.fn(), requestUserInput });
    expect(invalid.success).toBe(false);
    expect(requestUserInput).not.toHaveBeenCalled();
  });

  it("locally protects an explicitly declared credential username without changing its binding", () => {
    const fields = [
      { key: "mysql_user", label: "用户名", description: "数据库账户", type: "text", required: true,
        credential: { group: "db", kind: "database", role: "username", target: "db.internal:3306" } },
      { key: "MYSQL_PASSWORD", label: "密码", description: "数据库密码", type: "password", required: true,
        credential: { group: "db", kind: "database", role: "secret", target: "db.internal:3306" } },
    ];
    const command = () => `opsark-tool user.request_input ${JSON.stringify({ title: "数据库凭据", fields })}`;
    const call = parseToolCommand(command(), "local-repair")!;
    expect(call.arguments.fields).toEqual([{ ...fields[0], type: "password" }, fields[1]]);
    expect(fields[0].type).toBe("text");
    fields[1].credential.target = "other.internal:3306";
    expect(() => parseToolCommand(command(), "mismatch")).toThrow("必须完全一致");
    fields[1].credential.target = "db.internal:3306";
    fields[0].required = false;
    expect(() => parseToolCommand(command(), "optional-credential")).toThrow("必填");
  });
  it("accepts the logged select + socket credential form without model repair and preserves path case", () => {
    const fields = [
      { key: "AUTH", label: "认证方式", description: "选择已确认方式", type: "select", required: true,
        options: [{ value: "socket", label: "本机 socket" }] },
      ...["username", "secret"].map(role => ({ key: role === "username" ? "DB_USER" : "DB_PASSWORD", label: role,
        description: "凭据", type: "password", required: true,
        credential: { group: "db", kind: "database", role, target: "/Run/My DB/mysql.sock" } })),
    ];
    const command = `opsark-tool user.request_input ${JSON.stringify({ title: "数据库认证", fields })}`;
    const first = parseToolCommand(command, "socket")!;
    expect(first.arguments.fields).toEqual(fields);
    expect(parseToolCommand(`opsark-tool user.request_input ${JSON.stringify(first.arguments)}`, "again")!.arguments).toEqual(first.arguments);
  });
  it("reads task-scoped evidence pages and rejects task overrides", async () => {
    const evidenceId = "a".repeat(64);
    const readEvidence = vi.fn().mockResolvedValue({ text: "history", historical: true, nextOffset: null });
    const call = parseToolCommand(`opsark-tool evidence.read ${JSON.stringify({ evidenceId, offset: 12, limit: 20 })}`, "read")!;
    const result = await executeToolCall(call, resolveToolRegistry([]), { readEvidence, getRemoteFileStructure: vi.fn() });
    expect(readEvidence).toHaveBeenCalledWith(evidenceId, 12, 20);
    expect(result).toMatchObject({ success: true, data: { historical: true } });
    expect(() => parseToolCommand(`opsark-tool evidence.read ${JSON.stringify({ evidenceId, taskId: "other-task" })}`, "read")).toThrow();
    expect(() => parseToolCommand(`opsark-tool evidence.read ${JSON.stringify({ evidenceId, limit: 12001 })}`, "read")).toThrow();
  });
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
    expect(parseToolCommand(
      'opsark-tool files.get_structure {"rootPath":"/","maxDepth":3,"maxNodes":600,"includeHidden":false,"excludeDirectories":["/proc","/sys","/dev","/run","/var/lib/docker/overlay2"]}',
      "call-root-scan",
    )?.arguments.excludeDirectories).toEqual(["/proc", "/sys", "/dev", "/run", "/var/lib/docker/overlay2"]);
    expect(parseToolCommand("uname -a", "call-2")).toBeUndefined();
    expect(() => parseToolCommand("opsark-tool files.get_structure []", "call-3")).toThrow("JSON 对象");
    expect(() => parseToolCommand("opsark-tool files.get_structure", "call-4")).toThrow("唯一工具 ID");
    expect(() => parseToolCommand('opsark-tool unknown.tool {"value":1}', "call-5")).toThrow("不存在或未注册");
    expect(() => parseToolCommand('opsark-tool files.get_structure {"rootPath":"/opt/app","unknown":1}', "call-6")).toThrow("不支持字段");
    try {
      parseToolCommand('opsark-tool files.get_structure {"rootPath":"/opt/app","excludeDirectories":["/proc"]}', "call-outside");
      expect.unreachable("根路径外的绝对排除项应在计划预检时被拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolArgumentValidationError);
      expect((error as ToolArgumentValidationError).argumentPath).toBe("excludeDirectories");
    }
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

  it("preserves typed absence and leaves permission or transport errors as failures", async () => {
    const call = { id: "path-state", toolId: "files.get_structure", arguments: { rootPath: "/opt/app" } };
    const getRemoteFileStructure = vi.fn().mockResolvedValue({ pathStatus: "missing", tree: "", truncated: false, warnings: [] });
    const missing = await executeToolCall(call, resolveToolRegistry([]), { getRemoteFileStructure });
    expect(missing).toMatchObject({ success: true, data: { pathStatus: "missing", rootPath: "/opt/app" } });
    for (const message of ["[SFTP(3)] permission denied", "connection lost", "no such file (untyped error)"]) {
      getRemoteFileStructure.mockRejectedValueOnce(new Error(message));
      const failed = await executeToolCall(call, resolveToolRegistry([]), { getRemoteFileStructure });
      expect(failed).toMatchObject({ success: false, error: { message: expect.stringContaining(message) } });
      expect(failed.data).toBeUndefined();
    }
  });

  it("routes root scans with absolute virtual-filesystem exclusions", async () => {
    const getRemoteFileStructure = vi.fn().mockResolvedValue({
      tree: "/\n├── opt/\n└── var/",
      truncated: false,
      warnings: [],
    });

    const result = await executeToolCall({
      id: "call-root-scan",
      toolId: "files.get_structure",
      arguments: {
        rootPath: "/",
        maxDepth: 3,
        maxNodes: 600,
        includeHidden: false,
        excludeDirectories: ["/proc", "/sys", "/dev", "/run", "/var/lib/docker/overlay2"],
      },
    }, resolveToolRegistry([]), { getRemoteFileStructure });

    expect(result.success).toBe(true);
    expect(getRemoteFileStructure).toHaveBeenCalledWith(expect.objectContaining({
      rootPath: "/",
      excludeDirectories: expect.arrayContaining([
        "/proc", "/sys", "/dev", "/run", "/var/lib/docker/overlay2",
      ]),
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
    const outsideExcludeResult = await executeToolCall({
      id: "call-4",
      toolId: "files.get_structure",
      arguments: { rootPath: "/opt/app", excludeDirectories: ["/proc"] },
    }, resolveToolRegistry([]), dependency);

    expect(disabledResult.error?.code).toBe("TOOL_DISABLED");
    expect(invalidResult.error?.code).toBe("TOOL_EXECUTION_FAILED");
    expect(outsideExcludeResult.error?.code).toBe("TOOL_EXECUTION_FAILED");
    expect(dependency.getRemoteFileStructure).not.toHaveBeenCalled();
  });
});
