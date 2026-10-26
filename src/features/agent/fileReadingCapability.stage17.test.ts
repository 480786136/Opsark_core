import { describe, expect, it } from "vitest";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { buildToolContext } from "@/features/tools/toolContext";
import { preparePlanForApproval } from "./planPreparation";
import { candidateRegenerationContext } from "@/services/modelRecovery";
import type { PlanStep, ServerProfile } from "@/types";

const server = { id: "s", host: "fixture.invalid", port: 22, username: "deploy" } as ServerProfile;
const context = { taskId: "t", permission: "observe" as const, server, servers: [server] };
const step = (toolId: string, args: Record<string, unknown>): PlanStep => ({ id: "read", kind: "observe", title: "读取JSON配置正文",
  description: "读取当前配置", expected: "获得正文用于后续修改", command: "", validation: "", risk: "low", status: "pending",
  action: { type: "tool", toolId, arguments: args } });
describe("read evidence and deletion preview have distinct contracts", () => {
  it("reproduces the empty-path rejection without deleting or rewriting the proposal", () => {
    const original = step("files.preview_deletion", { paths: [] });
    expect(() => preparePlanForApproval([original], context)).toThrow();
    expect(original.action).toMatchObject({ toolId: "files.preview_deletion", arguments: { paths: [] } });
  });
  it("keeps valid deletion preview valid, while never converting its metadata to content", () => {
    const proposal = { ...step("files.preview_deletion", { paths: ["/srv/config.json"] }),
      description: "获取文件候选元数据，不读取正文", expected: "获得路径、大小和摘要，不含配置正文" };
    const preview = preparePlanForApproval([proposal], context);
    expect(preview.compatibilitySteps[0]?.action).toMatchObject({ toolId: "files.preview_deletion" });
    const tool = defaultToolCatalog.find(t => t.id === "files.preview_deletion")!;
    expect(JSON.stringify(tool.outputSchema)).not.toContain('"content"');
    expect(tool.outputDescription).toContain("不含content");
    const read = preparePlanForApproval([step("files.read_content", { path: "/srv/config.json" })], context);
    expect(read.compatibilitySteps[0]?.action).toMatchObject({ toolId: "files.read_content" });
  });
  it("puts the required capability distinction into the actual planner directory and regeneration, preserving original ownership", () => {
    const tools = buildToolContext(defaultToolCatalog);
    expect(tools.find(t => t.id === "files.read_content")?.usageInstructions).toContain("不能代替正文");
    const original = { tools, _modelRecovery: { operationId: "original", startedAtMs: 123 }, executionConstraints: { changePolicy: "confirm_changes" } };
    const repair = JSON.parse(candidateRegenerationContext(JSON.stringify(original), { rejectedToolIds: ["files.preview_deletion"] }));
    expect(repair.outputRecovery.instruction).toContain("不要只补参数");
    expect(repair._modelRecovery).toEqual(original._modelRecovery);
    expect(repair.executionConstraints).toEqual(original.executionConstraints);
    expect(repair.tools).toEqual(tools);
  });
});
