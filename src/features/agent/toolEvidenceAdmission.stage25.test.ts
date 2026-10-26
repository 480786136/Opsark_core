import { describe, expect, it } from "vitest";
import frozen from "../../../tests/fixtures/tool-evidence-stage24.json";
import { preparePlanForApproval } from "./planPreparation";
import { normalizePlanPreconditions } from "./planNormalizer";
import { resolveStepDispatch } from "./executionDispatch";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { readRecoveryProtocolError } from "@/services/recoveryRules";
import { buildPlanNormalizationRepair, modelCandidateDiagnostic, PlanProtocolError } from "@/services/backend";
import { candidateRejectionFromPlan, candidateRejectionMessage } from "@/services/candidateRejection";
import type { PlanStep, ServerProfile } from "@/types";

const server = { id: "test", host: "fixture.invalid", port: 22, username: "deploy" } as ServerProfile;
const context = { taskId: "test", permission: "safe" as const, server, servers: [server] };
const original = (index = 0): PlanStep[] => JSON.parse(JSON.stringify(frozen[index]!["模型原文解析"].steps))
  .map((step: PlanStep, i: number) => ({ ...step, id: `frozen-${i}`, status: "pending", command: "" }));
function caught(fn: () => unknown): unknown { try { fn(); } catch (error) { return error; } throw new Error("Expected rejection"); }
const metadata = (): PlanStep => ({ ...original()[0]!, title: "预览文件", description: "获取删除候选元数据，不读取正文。",
  expected: "获得路径、大小、身份与摘要，不含配置正文。" });

describe("第二十五批：正文证据准入与真实候选回放", () => {
  it("原A候选在普通计划归一化和批准准备处均被拒，原动作不被改写", () => {
    const proposal = original(), before = JSON.stringify(proposal);
    for (const admit of [() => normalizePlanPreconditions(proposal), () => preparePlanForApproval(proposal, context)]) {
      const issue = readRecoveryProtocolError(caught(admit));
      expect(issue).toMatchObject({ code: "TOOL_EVIDENCE_CAPABILITY_MISMATCH", stepIndex: 0, allowedRepairPaths: [] });
    }
    expect(JSON.stringify(proposal)).toBe(before);
  });
  it("原B空paths仍优先保留参数错误，不把结构错误改报为能力问题", () => {
    expect(readRecoveryProtocolError(caught(() => normalizePlanPreconditions(original(1))))?.code).toBe("TOOL_ARGUMENT_INVALID");
  });
  it("合法元数据预览通过批准和派发，不静默替换工具", () => {
    const step = preparePlanForApproval([metadata()], context).compatibilitySteps[0]!;
    expect(resolveStepDispatch(step, [], "call")).toMatchObject({ kind: "tool", call: { toolId: "files.preview_deletion" } });
  });
  it("真正返回正文的动作通过批准和派发", () => {
    const step = { ...original()[0]!, action: { type: "tool" as const, toolId: "files.read_content", arguments: { path: "/srv/other.conf" } } };
    const prepared = preparePlanForApproval([step], context).compatibilitySteps[0]!;
    expect(resolveStepDispatch(prepared, [], "call")).toMatchObject({ kind: "tool", call: { toolId: "files.read_content" } });
  });
  it("历史未准备计划在派发边界同样不能把元数据当正文", () => {
    expect(resolveStepDispatch(original()[0]!, [], "call")).toMatchObject({ kind: "invalid" });
  });
  it("能力来自输出契约，工具改名仍拒绝；仅修改描述不能授予正文能力", () => {
    const definition = { ...defaultToolCatalog.find(t => t.id === "files.preview_deletion")!, id: "fixture.metadata", outputDescription: "返回完整文件正文" };
    const proposal = original();
    proposal[0]!.action = { type: "tool", toolId: definition.id, arguments: { paths: ["/srv/independent.txt"] } };
    expect(readRecoveryProtocolError(caught(() => normalizePlanPreconditions(proposal, "", [definition])))?.code).toBe("TOOL_EVIDENCE_CAPABILITY_MISMATCH");
  });
  it("拒绝原因进入完整候选重生成反馈，不能作为局部补参；安全原因链不带目标路径", () => {
    const steps = original();
    const failure = caught(() => normalizePlanPreconditions(steps));
    const repair = buildPlanNormalizationRepair(failure, steps);
    expect(repair.repairStrategy).toEqual({ type: "plan_protocol" });
    expect(repair.instruction).toContain("完整候选");
    const diagnostic = candidateRejectionFromPlan(repair);
    expect(diagnostic).toMatchObject({ code: "TOOL_EVIDENCE_CAPABILITY_MISMATCH", toolIds: ["files.preview_deletion"], rejectedCandidateExecuted: false });
    expect(candidateRejectionMessage(diagnostic)).toContain("正文");
    expect(JSON.stringify(modelCandidateDiagnostic(new PlanProtocolError(repair, "rejected")))).not.toContain("/opt/");
  });
});
