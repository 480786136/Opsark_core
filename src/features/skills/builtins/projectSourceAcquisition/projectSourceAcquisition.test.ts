import { describe, expect, it } from "vitest";
import {
  GIT_HTTPS_CREDENTIAL_GROUP,
  gitHttpsCredentialFields,
} from "@/features/skills/builtins/projectSourceAcquisition/authentication";
import { projectSourceAcquisitionSkill } from "@/features/skills/builtins/projectSourceAcquisition/definition";
import { projectSourceAcquisitionContract } from "@/features/skills/builtins/projectSourceAcquisition/workflow";
import { compileSkillInstructions } from "@/features/skills/instructionBuilder";
import { validateSkillDefinition } from "@/features/skills/skillValidation";

const EXPECTED_STAGE_IDS = [
  "prepare",
  "authenticate",
  "acquire",
  "verify",
  "handle-error",
] as const;

describe("project-source-acquisition v12", () => {
  it("publishes the concise source acquisition contract", () => {
    expect(projectSourceAcquisitionSkill).toMatchObject({
      id: "project-source-acquisition",
      version: 12,
      builtIn: true,
      forbiddenToolIds: ["server.resolve_connection", "server.connect"],
    });
    expect(validateSkillDefinition(projectSourceAcquisitionSkill)).toEqual([]);
    expect(projectSourceAcquisitionSkill.instructions.length).toBeLessThanOrEqual(4_500);
  });

  it("keeps stages unique and in evidence-driven execution order", () => {
    const stageIds = projectSourceAcquisitionContract.stages.map(({ id }) => id);

    expect(stageIds).toEqual(EXPECTED_STAGE_IDS);
    expect(new Set(stageIds).size).toBe(stageIds.length);
  });

  it("declares one explicit Git HTTPS credential group with complementary roles", () => {
    expect(gitHttpsCredentialFields.map((field) => ({
      key: field.key,
      type: field.type,
      credential: field.credential,
    }))).toEqual([
      {
        key: "GIT_USERNAME",
        type: "password",
        credential: {
          group: GIT_HTTPS_CREDENTIAL_GROUP,
          kind: "git-https",
          role: "username",
          target: "REPOSITORY_HOST",
        },
      },
      {
        key: "GIT_HTTP_CREDENTIAL",
        type: "password",
        credential: {
          group: GIT_HTTPS_CREDENTIAL_GROUP,
          kind: "git-https",
          role: "secret",
          target: "REPOSITORY_HOST",
        },
      },
    ]);
  });

  it("keeps only the decisions, validation outcome and error routes needed by the model", () => {
    const first = compileSkillInstructions(projectSourceAcquisitionContract);
    const second = compileSkillInstructions(projectSourceAcquisitionContract);

    expect(first).toBe(second);
    expect(projectSourceAcquisitionSkill.instructions).toBe(first);
    for (const stageId of EXPECTED_STAGE_IDS) expect(first).toContain(`[${stageId}]`);
    expect(first).toContain("serverCredentialGroups");
    expect(first).toContain("kind=observe");
    expect(first).toContain("GIT_TERMINAL_PROMPT=0");
    expect(first).toContain("不得在同一轮生成 clone");
    expect(first).toContain("不得靠 description/expected");
    expect(first).toContain("主命令结果就是证据");
    expect(first).toContain("kind=change");
    expect(first).toContain("目标路径已存在时保留原内容");
    expect(first).toContain("远端明确拒绝已选凭据");
    expect(first).not.toContain("mktemp -d");
    expect(first).not.toContain("rmdir");
  });
});
