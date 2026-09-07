import { describe, expect, it } from "vitest";
import { loadBuiltInSkills, loadSkillDefinition, skillSourceFingerprint } from "./skillFileLoader";
import { planningSkills } from "./skillPlanning";
import type { OpsTask } from "@/types";

const resources = import.meta.glob<string>("./definitions/**/*.{json,md}", { query: "?raw", import: "default", eager: true });
describe("file-backed Skill definitions", () => {
  it("keeps source identity stable across Windows line endings", () => {
    expect(skillSourceFingerprint("one\r\ntwo")).toBe(skillSourceFingerprint("one\ntwo"));
  });
  it("loads every catalog entry and preserves every paragraph in the stage contract", () => {
    const skills = loadBuiltInSkills();
    expect(skills).toHaveLength(7);
    for (const skill of skills) {
      expect(skill.instructions).toBe(resources[`./definitions/${skill.id}/instructions.md`]);
      const contract = skill.planningContract;
      if (!contract || contract.initialOnly) continue;
      const allRules = [contract.globalInstructions, contract.acceptanceInstructions, ...contract.stages.map(stage => stage.instructions)].join("\n");
      for (const paragraph of skill.instructions.split(/\n(?=\d+\. )/)) expect(allRules).toContain(paragraph.trim());
    }
  });
  it("rejects missing core text, invalid identities and external paths", () => {
    expect(() => loadSkillDefinition("../escape")).toThrow();
    const path = "./definitions/project-build/skill.json";
    const manifest = JSON.parse(resources[path]);
    for (const instructions of ["../other/instructions.md", "https://example.test/rules.md", "missing.md"]) {
      expect(() => loadSkillDefinition("project-build", { ...resources, [path]: JSON.stringify({ ...manifest, instructions }) })).toThrow();
    }
  });
  it("restores complete rules if an optional stage file is missing", () => {
    const files = { ...resources };
    delete files["./definitions/project-build/stages/discover.md"];
    const skill = loadSkillDefinition("project-build", files);
    expect(skill.planningContract).toBeUndefined();
    expect(skill.instructions).toBe(resources["./definitions/project-build/instructions.md"]);
  });
  it("uses full rules when the source was edited without updating the stage contract", () => {
    const path = "./definitions/project-build/instructions.md";
    const skill = loadSkillDefinition("project-build", { ...resources, [path]: resources[path] + "\nAdditional acceptance rule" });
    expect(skill.planningContract).toBeUndefined();
    expect(skill.instructions).toContain("Additional acceptance rule");
  });
  it("keeps stage rule text stable when matching evidence changes", () => {
    const current = { id: "task", serverId: "server", plan: [], phaseHistory: [] } as unknown as OpsTask;
    const skill = loadSkillDefinition("project-build");
    const projected = planningSkills(current, [skill])[0];
    expect(projected.instructions).not.toContain('"observed"');
    expect(projected.planningEvidence).toMatchObject({ stageId: "discover", observed: [] });
  });
});
