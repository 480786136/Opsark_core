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
    expect(buildSkillContext(skills)[0].instructions).toContain("server.resolve_connection");
    expect(buildSkillContext(skills)[0].instructions).toContain("独立只读终端命令");
  });

  it("keeps unrelated requirements free of domain instructions", () => {
    expect(suggestSkillsByRules("查看当前内存使用情况")).toEqual([]);
  });

  it("separates source acquisition from project build and can suggest both", () => {
    expect(suggestSkillsByRules("git clone git@example.com:team/app.git").map((skill) => skill.id))
      .toEqual(["project-source-acquisition"]);
    expect(suggestSkillsByRules("构建项目").map((skill) => skill.id))
      .toEqual(["project-build"]);
    expect(suggestSkillsByRules("克隆项目并构建").map((skill) => skill.id))
      .toEqual(["project-source-acquisition", "project-build"]);
  });

  it("provides file transfer and integrity guidance without embedding credentials", () => {
    const [skill] = suggestSkillsByRules("请进行跨服务器文件传输");
    const context = buildSkillContext([skill]);

    expect(skill.id).toBe("file-transfer-integrity");
    expect(context[0].instructions).toContain("files.transfer_between_servers");
    expect(context[0].instructions).toContain("server.resolve_connection");
    expect(context[0].instructions).toContain("优先在源服务器以前台 scp 直接传输");
    expect(context[0].instructions).toContain("只有源服务器到目标服务器的网络确实不通");
    expect(context[0].instructions).toContain("Opsark 已有证据证明能分别 SSH 连接源、目标两台服务器");
    expect(context[0].instructions).toContain("overwrite 默认为 false");
    expect(context[0].instructions).toContain("在目标服务器独立读取最终文件的字节数和 SHA-256");
    expect(context[0].instructions).not.toContain("${secret.");
  });

  it("exposes all enabled Skills as a lightweight multi-select directory", () => {
    const directory = buildSkillDirectory(resolveSkillRegistry({ overrides: [], customSkills: [] }));
    expect(directory.map((skill) => skill.id)).toEqual([
      "ssh-terminal-jump",
      "project-source-acquisition",
      "project-build",
      "file-transfer-integrity",
    ]);
    expect(directory[0]).toMatchObject({
      description: expect.stringContaining("SSH"),
      selectionHints: expect.any(Array),
    });
    expect(JSON.stringify(directory)).not.toContain("server.resolve_connection");
  });

  it("persists built-in overrides and user-created Skills as configuration", () => {
    const registry = resolveSkillRegistry({ overrides: [], customSkills: [] });
    registry[0].enabled = false;
    registry[0].instructions = "已配置的 SSH 流程";
    const custom = createCustomSkill("skill-release-audit");
    custom.name = "发布审计";
    custom.matchRules = ["发布审计", "regex:release\\s+audit"];
    custom.instructions = "先采集发布证据，再输出审计结论。";
    registry.push(custom);

    const serialized = JSON.parse(JSON.stringify(createSkillConfiguration(registry)));
    const restored = resolveSkillRegistry(parseSkillConfiguration(serialized));
    expect(restored.find((skill) => skill.id === "ssh-terminal-jump")).toMatchObject({
      enabled: false,
      instructions: "已配置的 SSH 流程",
    });
    expect(suggestSkillsByRules("请进行发布审计", restored).map((skill) => skill.id)).toEqual(["skill-release-audit"]);
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
