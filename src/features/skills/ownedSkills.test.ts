import { beforeEach, expect, it } from "vitest";
import { builtInSkillCatalog } from "./skillCatalog";
import { createCustomSkill, resolveTaskSkills } from "./skillRegistry";
import { createOwnedSkillConfiguration, enforceSystemSkills, loadOwnedSkills, ownedSkills, persistOwnedSkills, pinTaskSkills } from "./ownedSkills";
import type { OpsTask } from "@/types";

beforeEach(() => localStorage.clear());
it("migrates v0.3 overrides to disabled user copies without changing system contracts", () => {
  const system = builtInSkillCatalog[0];
  const original = JSON.stringify({ overrides: [{ id: system.id, instructions: "Keep my legacy prose", enabled: false }], customSkills: [] });
  localStorage.setItem("opsark.skillConfiguration", original);
  const skills = loadOwnedSkills();
  expect(localStorage.getItem("opsark.skillConfiguration.v03.backup")).toBe(original);
  expect(skills.find(s => s.id === system.id)).toMatchObject({ instructions: system.instructions, enabled: system.enabled, source: "system" });
  expect(skills.find(s => s.id === `skill-migrated-${system.id}`)).toMatchObject({ instructions: "Keep my legacy prose", enabled: false, source: "user", builtIn: false });
  expect(skills.find(s => !s.builtIn)?.planningContract).toBeUndefined();
  persistOwnedSkills(skills);
  expect(createOwnedSkillConfiguration(loadOwnedSkills()).customSkills).toHaveLength(1);
});
it("strips system-authority fields from user documents and restores mutated system definitions", () => {
  const user = { ...createCustomSkill("skill-test"), builtIn: true, source: "system", planningContract: { trusted: true },
    allowShell: false, allowedToolIds: ["files.read_content"], forbiddenToolIds: ["software.check"], executor: "arbitrary-code" };
  const skills = ownedSkills({ customSkills: [user] });
  const parsed = skills.find(s => s.id === user.id)!;
  expect(parsed.builtIn).toBe(false); expect(parsed.source).toBe("user");
  expect(parsed.planningContract).toBeUndefined(); expect(parsed).not.toHaveProperty("executor");
  expect(parsed).not.toHaveProperty("allowShell"); expect(parsed).not.toHaveProperty("allowedToolIds");
  expect(parsed).not.toHaveProperty("forbiddenToolIds");
  skills[0].instructions = "tampered";
  expect(enforceSystemSkills(skills)[0].instructions).toBe(builtInSkillCatalog[0].instructions);
});
it("pins activated Skill versions for running tasks while new tasks get new versions", () => {
  const skill = createCustomSkill("skill-test");
  const task = { activeSkillIds: [skill.id] } as OpsTask;
  pinTaskSkills(task, [skill]);
  const updated = { ...skill, version: 2, instructions: "New workflow" };
  pinTaskSkills(task, [updated]);
  expect(resolveTaskSkills(task, [updated])[0].instructions).toBe(skill.instructions);
  const nextTask = { activeSkillIds: [skill.id] } as OpsTask;
  pinTaskSkills(nextTask, [updated]);
  expect(resolveTaskSkills(nextTask, [skill])[0].version).toBe(2);
});
it("backs up malformed legacy content before replacing it", () => {
  localStorage.setItem("opsark.skillConfiguration", "{broken");
  persistOwnedSkills(ownedSkills({}));
  expect(localStorage.getItem("opsark.skillConfiguration.v03.backup")).toBe("{broken");
});
