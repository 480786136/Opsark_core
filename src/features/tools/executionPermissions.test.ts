import { beforeEach, expect, it } from "vitest";
import { createCustomSkill } from "@/features/skills/skillRegistry";
import { pinTaskSkills } from "@/features/skills/ownedSkills";
import { executionCapabilityBlocker, permissionStorageKey, permissionTools, readExecutionPermissions, saveExecutionPermissions } from "./executionPermissions";
import { selectPlanningTools } from "./toolContext";
import type { OpsTask } from "@/types";

const command = { command: 'opsark-tool files.read_content {"path":"/tmp/example"}', validation: "true" };
const shell = { command: "pwd", validation: "true" };
beforeEach(() => localStorage.clear());
it("preserves local capability defaults but fails closed on corrupt saved policies", () => {
  expect(readExecutionPermissions().allowShell).toBe(true);
  for (const corrupt of ["broken", "null", "{}", '{"allowShell":"true","toolIds":[]}']) {
    localStorage.setItem(permissionStorageKey, corrupt);
    expect(readExecutionPermissions()).toEqual({ allowShell: false, toolIds: [] });
  }
});
it("lets the model choose tools for user Skills within global grants", () => {
  const skill = { ...createCustomSkill("skill-test"), allowShell: false, allowedToolIds: ["files.read_content"] };
  const task = { activeSkillIds: [skill.id] } as OpsTask;
  expect(executionCapabilityBlocker(task, command, [skill])).toBeUndefined();
  expect(executionCapabilityBlocker(task, shell, [skill])).toBeUndefined();
  saveExecutionPermissions({ allowShell: true, toolIds: [] });
  expect(selectPlanningTools(permissionTools, [skill])).toEqual([]);
  expect(executionCapabilityBlocker(task, command, [skill])).toContain("未授权");
  saveExecutionPermissions({ allowShell: true, toolIds: ["files.read_content", "fake-tool"] });
  expect(readExecutionPermissions().toolIds).toEqual(["files.read_content"]);
  expect(selectPlanningTools(permissionTools, [skill]).map(t => t.id)).toEqual(["files.read_content"]);
  expect(executionCapabilityBlocker(task, command, [{ ...skill, allowedToolIds: [] }])).toBeUndefined();
});
it("global revocation overrides already pinned task permissions without changing its workflow", () => {
  const skill = { ...createCustomSkill("skill-test"), allowedToolIds: ["files.read_content"] };
  const task = { activeSkillIds: [skill.id] } as OpsTask;
  pinTaskSkills(task, [skill]);
  expect(executionCapabilityBlocker(task, shell, [])).toBeUndefined();
  saveExecutionPermissions({ allowShell: false, toolIds: [] });
  expect(executionCapabilityBlocker(task, shell, [])).toContain("Shell");
  expect(executionCapabilityBlocker(task, command, [])).toContain("未授权");
});
it("leaves malformed protocol errors to the existing non-executing failure handler", () => {
  expect(executionCapabilityBlocker({ activeSkillIds: [] } as unknown as OpsTask, { command: "opsark-tool ???", validation: "true" }, [])).toBeUndefined();
});
