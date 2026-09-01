import { describe, expect, it } from "vitest";
import {
  buildSkillDirectory,
  buildSkillContext,
  createCustomSkill,
  createSkillConfiguration,
  parseSkillConfiguration,
  resolveSkillRegistry,
  suggestSkillsByRules,
} from "@/features/skills/skillRegistry";
import { validateSkillDefinition } from "@/features/skills/skillValidation";

describe("skill registry", () => {
  it("activates the SSH workflow without embedding it in the core orchestrator", () => {
    const skills = suggestSkillsByRules("使用 SSH 跳转到 192.168.1.237");
    expect(skills.map((skill) => skill.id)).toEqual(["ssh-terminal-jump"]);
    expect(skills[0]).toMatchObject({
      version: 4,
      category: "connectivity",
    });
    expect(buildSkillContext(skills)[0].instructions).toContain("server.resolve_connection");
    expect(buildSkillContext(skills)[0].instructions).toContain("TARGET_SSH_USERNAME");
    expect(buildSkillContext(skills)[0].instructions).toContain("同一服务器凭据组长期保存");
    expect(buildSkillContext(skills)[0].instructions).toContain("独立只读终端命令");
  });

  it("keeps unrelated requirements free of domain instructions", () => {
    expect(suggestSkillsByRules("查看当前内存使用情况")).toEqual([]);
    expect(suggestSkillsByRules("检查为什么 VSCode 不能通过 40122 连接服务器")).toEqual([]);
  });

  it("separates source acquisition from project build and can suggest both", () => {
    expect(suggestSkillsByRules("git clone git@example.com:team/app.git").map((skill) => skill.id))
      .toEqual(["project-source-acquisition"]);
    expect(suggestSkillsByRules("构建项目").map((skill) => skill.id))
      .toEqual(["project-build"]);
    expect(suggestSkillsByRules("克隆项目并构建").map((skill) => skill.id))
      .toEqual(["project-source-acquisition", "project-build"]);
  });

  it("models project dependency installation and build as separate recoverable stages", () => {
    const [skill] = suggestSkillsByRules("构建项目");
    const instructions = buildSkillContext([skill])[0].instructions;

    expect(skill).toMatchObject({ id: "project-build", version: 3 });
    expect(instructions).toContain("不把多个失败边界塞进同一个 Shell 步骤");
    expect(instructions).toContain("不得把依赖安装与构建写成 npm install && npm run build");
    expect(instructions).toContain("不得把全部 stdout/stderr 只重定向到文件");
    expect(instructions).toContain("定期复核停止或终端中断只表示没有取得真实退出结果");
    expect(instructions).toContain("按网络/DNS/TLS、认证、运行时版本");
  });

  it("models authenticated source acquisition as a staged workflow", () => {
    const [skill] = suggestSkillsByRules("拉取私有仓库 git@gitee.com:team/app.git");
    const instructions = buildSkillContext([skill])[0].instructions;

    expect(skill).toMatchObject({
      id: "project-source-acquisition",
      version: 11,
      forbiddenToolIds: ["server.resolve_connection", "server.connect"],
    });
    expect(instructions).toContain("最短的可执行计划");
    expect(instructions).toContain("GIT_HTTP_CREDENTIAL");
    expect(instructions).toContain('"kind":"git-https","role":"username"');
    expect(instructions).toContain('"kind":"git-https","role":"secret"');
    expect(instructions).toContain("只有一组时直接复用");
    expect(instructions).toContain("前台 PTY 回答 Git 的 Username/Password 提示");
    expect(instructions).toContain("主命令结果就是证据");
    expect(instructions).toContain("按真实错误恢复或停止");
  });

  it("provides a general software installation skill for common runtimes", () => {
    for (const requirement of ["安装git", "安装 Node.js 22", "安装 JDK 21", "安装 Docker 和 compose", "安装 nginx"]) {
      expect(suggestSkillsByRules(requirement).map((skill) => skill.id)).toContain("software-installation");
    }
    const skill = suggestSkillsByRules("安装 Docker").find((item) => item.id === "software-installation")!;
    const instructions = buildSkillContext([skill])[0].instructions;

    expect(instructions).toContain("/etc/os-release");
    expect(instructions).toContain("受信国内镜像/企业镜像");
    expect(instructions).toContain("不得直接执行 curl|sh/wget|bash");
    expect(instructions).toContain("仍在下载就提前校验");
    expect(instructions).toContain("git user.name/user.email 是提交作者信息");
    expect(instructions).toContain("Docker Engine、CLI、Compose 插件");
    expect(suggestSkillsByRules("安装 Git 并克隆项目").map((item) => item.id)).toEqual([
      "project-source-acquisition",
      "software-installation",
    ]);
  });

  it("provides file transfer and integrity guidance without embedding credentials", () => {
    const [skill] = suggestSkillsByRules("请进行跨服务器文件传输");
    const context = buildSkillContext([skill]);

    expect(skill).toMatchObject({ id: "file-transfer-integrity", version: 5 });
    expect(context[0].instructions).toContain("files.transfer_between_servers");
    expect(context[0].instructions).toContain("server.resolve_connection");
    expect(context[0].instructions).toContain("BatchMode 认证成功：使用该认证以前台 scp 直接传输");
    expect(context[0].instructions).toContain("使用源文件 basename 补成最终目标文件绝对路径");
    expect(context[0].instructions).toContain("不得比较 stat %F 的本地化文本");
    expect(context[0].instructions).toContain("不得把源文件检查、网络探测、认证探测、传输和最终验收压进一个");
    expect(context[0].instructions).toContain("overwrite 默认为 false");
    expect(context[0].instructions).toContain("目标文件字节数和 SHA-256 与源文件逐项一致");
    expect(context[0].instructions).toContain("TARGET_SSH_PASSWORD");
    expect(context[0].instructions).toContain("TARGET_SSH_USERNAME");
    expect(context[0].instructions).toContain("server-credential 引用只用于当前可见 PTY");
    expect(context[0].instructions).toContain("下一轮计划必须且只能调用 user.request_input");
    expect(context[0].instructions).toContain("文件传输工作流不得调用 server.connect");
    expect(context[0].instructions).not.toContain("${secret.PASSWORD}");
  });

  it("routes database queries and authentication handling through the database Skill", () => {
    for (const requirement of ["查看mysql有哪些数据库", "列出所有数据库", "检查 MariaDB 连接"]) {
      expect(suggestSkillsByRules(requirement).map((skill) => skill.id))
        .toContain("database-inspection-operations");
    }
    const [skill] = suggestSkillsByRules("查看mysql有哪些数据库");
    const instructions = buildSkillContext([skill])[0].instructions;

    expect(instructions).toContain("MYSQL_ROOT_PASSWORD");
    expect(instructions).toContain("ERROR 1045");
    expect(instructions).toContain("只有真实返回所需列表或结果才能完成");
    expect(instructions).toContain("禁止复用 SSH、Git、API");
  });

  it("uses semantic selection hints without business-specific core exclusions", () => {
    expect(suggestSkillsByRules("检查 /opt/ground_check 项目的前后端是否都在运行")).toEqual([]);
    const deployment = resolveSkillRegistry({ overrides: [], customSkills: [] })
      .find((skill) => skill.id === "application-deployment")!;

    expect(deployment).toMatchObject({
      version: 4,
      category: "deployment",
    });
    expect(deployment.description).not.toContain("前后端");
  });

  it("exposes all enabled Skills as a lightweight multi-select directory", () => {
    const directory = buildSkillDirectory(resolveSkillRegistry({ overrides: [], customSkills: [] }));
    expect(directory.map((skill) => skill.id)).toEqual([
      "ssh-terminal-jump",
      "project-source-acquisition",
      "software-installation",
      "project-build",
      "database-inspection-operations",
      "application-deployment",
      "file-transfer-integrity",
    ]);
    expect(directory[0]).toMatchObject({
      category: "connectivity",
      description: expect.stringContaining("SSH"),
      selectionHints: expect.any(Array),
    });
    expect(JSON.stringify(directory)).not.toContain("capabilities");
    expect(JSON.stringify(directory)).not.toContain("server.resolve_connection");
  });

  it("persists built-in overrides and user-created Skills as configuration", () => {
    const registry = resolveSkillRegistry({ overrides: [], customSkills: [] });
    registry[0].enabled = false;
    registry[0].category = "other";
    registry[0].instructions = "已配置的 SSH 流程";
    const custom = createCustomSkill("skill-release-audit");
    custom.name = "发布审计";
    custom.matchRules = ["发布审计", "regex:release\\s+audit"];
    custom.instructions = "先采集发布证据，再输出审计结论。";
    registry.push(custom);

    const serialized = JSON.parse(JSON.stringify(createSkillConfiguration(registry)));
    expect(serialized.overrides[0].baseVersion).toBe(4);
    const restored = resolveSkillRegistry(parseSkillConfiguration(serialized));
    expect(restored.find((skill) => skill.id === "ssh-terminal-jump")).toMatchObject({
      enabled: false,
      category: "other",
      instructions: "已配置的 SSH 流程",
    });
    expect(restored.find((skill) => skill.id === "skill-release-audit")).toMatchObject({
      category: "other",
    });
    expect(suggestSkillsByRules("请进行发布审计", restored).map((skill) => skill.id)).toEqual(["skill-release-audit"]);
  });

  it("migrates legacy custom Skills without a category into Other", () => {
    const restored = resolveSkillRegistry(parseSkillConfiguration({
      overrides: [],
      customSkills: [{
        id: "skill-legacy",
        name: "旧 Skill",
        description: "旧版未保存分类",
        instructions: "执行旧流程。",
        capabilities: [{ operation: "diagnose", effect: "read" }],
        matchRules: [],
      }],
    }));

    const legacy = restored.find((skill) => skill.id === "skill-legacy")!;
    expect(legacy.category).toBe("other");
    expect(legacy).not.toHaveProperty("capabilities");
    expect(createSkillConfiguration(restored).customSkills[0]).not.toHaveProperty("capabilities");
  });

  it("does not let a pre-v11 source override mask the typed-step contract", () => {
    const [source] = resolveSkillRegistry(parseSkillConfiguration({
      overrides: [{
        id: "project-source-acquisition",
        baseVersion: 5,
        enabled: false,
        instructions: "旧版自由文本认证流程",
      }],
      customSkills: [],
    })).filter((skill) => skill.id === "project-source-acquisition");

    expect(source.enabled).toBe(false);
    expect(source.version).toBe(11);
    expect(source.instructions).not.toContain("旧版自由文本认证流程");
    expect(source.instructions).toContain('"kind":"git-https","role":"username"');

    const sourceFromUnversionedConfig = resolveSkillRegistry(parseSkillConfiguration({
      overrides: [{ id: "project-source-acquisition", instructions: "更早版本的无版本覆盖" }],
      customSkills: [],
    })).find((skill) => skill.id === "project-source-acquisition")!;
    expect(sourceFromUnversionedConfig.instructions).not.toContain("更早版本的无版本覆盖");
    expect(sourceFromUnversionedConfig.version).toBe(11);
  });

  it("preserves a source override authored against the v11 contract", () => {
    const [source] = resolveSkillRegistry(parseSkillConfiguration({
      overrides: [{
        id: "project-source-acquisition",
        baseVersion: 11,
        instructions: "v11 compatible override",
      }],
      customSkills: [],
    })).filter((skill) => skill.id === "project-source-acquisition");

    expect(source.instructions).toBe("v11 compatible override");
    expect(buildSkillContext([source])[0].forbiddenToolIds).toEqual([
      "server.resolve_connection",
      "server.connect",
    ]);
  });

  it("replaces a pre-v3 project-build override while preserving its enablement", () => {
    const build = resolveSkillRegistry(parseSkillConfiguration({
      overrides: [{
        id: "project-build",
        baseVersion: 2,
        enabled: false,
        instructions: "旧版将依赖安装和构建合并执行",
      }],
      customSkills: [],
    })).find((skill) => skill.id === "project-build")!;

    expect(build).toMatchObject({ version: 3, enabled: false });
    expect(build.instructions).not.toContain("旧版将依赖安装和构建合并执行");
    expect(build.instructions).toContain("依赖安装：作为独立步骤执行");
  });

  it("migrates the disabled legacy combined project Skill to both split Skills", () => {
    const restored = resolveSkillRegistry(parseSkillConfiguration({
      overrides: [{
        id: "project-deployment",
        enabled: false,
        instructions: "旧的获取与构建混合说明",
      }],
      customSkills: [],
    }));

    expect(restored.filter((skill) => skill.id.startsWith("project-")).map((skill) => ({
      id: skill.id,
      enabled: skill.enabled,
      inheritedLegacyInstructions: skill.instructions.includes("旧的获取与构建混合说明"),
    }))).toEqual([
      { id: "project-source-acquisition", enabled: false, inheritedLegacyInstructions: false },
      { id: "project-build", enabled: false, inheritedLegacyInstructions: false },
    ]);
  });

  it("rejects invalid configurable regular expressions", () => {
    const skill = createCustomSkill("skill-invalid-rule");
    skill.matchRules = ["regex:(unclosed"];
    expect(validateSkillDefinition(skill)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "matchRules" }),
    ]));
  });
});
