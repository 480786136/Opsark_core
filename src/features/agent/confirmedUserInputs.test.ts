import { describe, expect, it } from "vitest";
import { confirmedInputScope, confirmedUserInputsContext } from "@/features/agent/confirmedUserInputs";
import type { OpsTask, SubmittedTaskInput } from "@/types";

const taskIdentity = { id: "task-1", serverId: "server-1", rootGoal: "部署应用", title: "部署应用", plan: [] };

function submitted(value: string | number, submittedAt: string): SubmittedTaskInput {
  return {
    value,
    type: typeof value === "number" ? "number" : "select",
    label: "用户选择",
    description: "后续计划必须复用的决定",
    groupId: "input-form-1",
    groupTitle: "部署方案",
    submittedAt,
    scope: confirmedInputScope(taskIdentity, "input-form-1"),
  };
}

describe("confirmed user input context", () => {
  it("projects only bounded non-sensitive decisions and preserves exact ordinary values", () => {
    const source = {
      ...taskIdentity,
      submittedInputs: {
        image_registry: submitted("registry.aliyuncs.com/google_containers", "2026-09-15T07:50:52.000Z"),
        cni_manifest_source: submitted(" mirror_url ", "2026-09-15T07:50:53.000Z"),
        REGISTRY_TOKEN: submitted("LEGACY_SECRET_MUST_NOT_LEAK", "2026-09-15T07:50:54.000Z"),
        password_confirm: submitted("SECOND_SECRET_MUST_NOT_LEAK", "2026-09-15T07:50:55.000Z"),
        tokenizer_mode: submitted("unicode", "2026-09-15T07:50:56.000Z"),
      },
      // Secret binding metadata must never be inspected or serialized.
      submittedSecretBindings: {
        REGISTRY_TOKEN: { value: "BINDING_SECRET_MUST_NOT_LEAK" },
      },
    } as unknown as OpsTask;

    const context = confirmedUserInputsContext(source);
    const serialized = JSON.stringify(context);

    expect(context?.items.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "image_registry", value: "registry.aliyuncs.com/google_containers" },
      { key: "cni_manifest_source", value: " mirror_url " },
      { key: "tokenizer_mode", value: "unicode" },
    ]);
    expect(context?.instruction).toContain("不得重复询问");
    expect(serialized).not.toContain("LEGACY_SECRET_MUST_NOT_LEAK");
    expect(serialized).not.toContain("SECOND_SECRET_MUST_NOT_LEAK");
    expect(serialized).not.toContain("BINDING_SECRET_MUST_NOT_LEAK");
    expect(serialized).not.toContain("submittedSecretBindings");
  });

  it("bounds cumulative decisions while retaining the most recent entries", () => {
    const submittedInputs = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
      `choice_${index}`,
      submitted(`value-${index}-${"x".repeat(600)}`, `2026-09-15T07:${String(index).padStart(2, "0")}:00.000Z`),
    ]));

    const context = confirmedUserInputsContext({ ...taskIdentity, submittedInputs });

    expect(context?.totalItems).toBe(30);
    expect(context?.includedItems).toBeLessThanOrEqual(16);
    expect(context?.omittedItems).toBe(30 - (context?.includedItems ?? 0));
    expect(context?.items[context.items.length - 1]?.key).toBe("choice_29");
    expect(context?.items[context.items.length - 1]?.valueTruncated).toBe(true);
    expect(context?.index).toHaveLength(30);
    expect(context?.index[0].key).toBe("choice_0");
    expect(JSON.stringify(context?.items).length).toBeLessThan(6_100);
  });

  it("does not rebind decisions to another server or goal, and keeps legacy values non-authoritative", () => {
    const current = submitted("exact-value", "now");
    const legacy = { ...submitted("legacy-value", "now"), scope: undefined };
    const submittedInputs = { choice: current, old_choice: legacy };
    const context = confirmedUserInputsContext({ ...taskIdentity, submittedInputs });
    expect(context?.items).toHaveLength(1);
    expect(context?.index[1].status).toBe("unverified_legacy");
    expect(JSON.stringify(context)).not.toContain("legacy-value");
    for (const changes of [{ executionTargetServerId: "server-2" }, { rootGoal: "另一个目标" }, { id: "task-2" }]) {
      const changed = confirmedUserInputsContext({ ...taskIdentity, ...changes, submittedInputs });
      expect(changed?.items).toEqual([]);
      expect(changed?.index[0].status).toBe("out_of_scope");
      expect(JSON.stringify(changed)).not.toContain("exact-value");
    }
    expect(submittedInputs.choice.value).toBe("exact-value");
    expect(submittedInputs.old_choice.value).toBe("legacy-value");
  });

  it("prioritizes a referenced old decision while retaining an index of all decisions", () => {
    const submittedInputs = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
      `choice_${index}_key`, submitted(`value-${index}`, String(index).padStart(2, "0")),
    ]));
    const plan = [{ status: "pending", command: "use choice_0_key", description: "" }] as OpsTask["plan"];
    const context = confirmedUserInputsContext({ ...taskIdentity, plan, submittedInputs });
    expect(context?.items.some(item => item.key === "choice_0_key")).toBe(true);
    expect(context?.index).toHaveLength(30);
  });
});
