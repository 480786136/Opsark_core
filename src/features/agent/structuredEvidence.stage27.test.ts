import { describe, expect, it } from "vitest";
import type { PlanStep, ServerProfile } from "@/types";
import { normalizePlanPreconditions } from "./planNormalizer";
import { preparePlanForApproval } from "./planPreparation";
import { resolveStepDispatch } from "./executionDispatch";
import { acceptStepApproval, hasCurrentStepApproval, requestStepApproval, stepMatchesExecutionIntent } from "./stepApproval";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";
import { buildToolContext } from "@/features/tools/toolContext";
import { assertPlanRepairScope, buildPlanNormalizationRepair } from "@/services/backend";
import { compactProtocolRepairContext, planSemanticFingerprint } from "@/services/planProtocolRepair";
import { candidateRejectionFromPlan, candidateRejectionMessage } from "@/services/candidateRejection";
import { readRecoveryProtocolError } from "@/services/recoveryRules";
import { planEvidenceContext } from "./modelParameters";

const server = { id: "fixture", host: "fixture.invalid", port: 22, username: "fixture" } as ServerProfile;
const context = { taskId: "fixture", permission: "safe" as const, server, servers: [server] };
const step = (toolId = "files.read_content"): PlanStep => ({ id: "s", kind: "observe", title: "读取", description: "检查对象",
  action: { type: "tool", toolId, arguments: toolId === "files.read_content" ? { path: "/fixture" } : { paths: ["/fixture"] } },
  command: "", validation: "", risk: "low", expected: "结果正确", evidenceRequirements: ["file_content"], status: "pending" });
const catchError = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } throw new Error("expected rejection"); };

describe("第二十七批：结构化证据准入、审批与派发", () => {
  it("模糊正文预期仍按显式需求拒绝元数据工具", () => {
    expect(readRecoveryProtocolError(catchError(() => normalizePlanPreconditions([step("files.preview_deletion")])))?.code).toBe("TOOL_EVIDENCE_CAPABILITY_MISMATCH");
  });
  it("真正正文工具保留声明并通过准备和派发", () => {
    const accepted = preparePlanForApproval([step()], context).compatibilitySteps[0]!;
    expect(accepted.evidenceRequirements).toEqual(["file_content"]);
    expect(accepted.executionIntent?.semantic.evidenceRequirements).toEqual(["file_content"]);
    expect(resolveStepDispatch(accepted, [], "fixture").kind).toBe("tool");
  });
  it("显式空数组不能抹掉兼容文本中的正文需求", () => {
    const proposal = { ...step("files.preview_deletion"), description: "读取文件", expected: "获得文件正文", evidenceRequirements: [] };
    expect(() => normalizePlanPreconditions([proposal])).toThrow("TOOL_EVIDENCE_CAPABILITY_MISMATCH");
  });
  it("旧计划省略字段仍兼容并保持省略", () => {
    const proposal = step(); delete proposal.evidenceRequirements;
    const accepted = preparePlanForApproval([proposal], context).compatibilitySteps[0]!;
    expect(accepted.executionIntent?.semantic).not.toHaveProperty("evidenceRequirements");
    expect(stepMatchesExecutionIntent(accepted)).toBe(true);
  });
  it.each([null, "file_content", ["unknown"], ["file_content", "file_content"], [7]])("畸形声明被安全拒绝：%j", value => {
    const proposal = { ...step(), evidenceRequirements: value } as PlanStep;
    const error = catchError(() => normalizePlanPreconditions([proposal]));
    expect(readRecoveryProtocolError(error)).toMatchObject({ code: "PLAN_EVIDENCE_REQUIREMENTS_INVALID", allowedRepairPaths: [] });
    expect(resolveStepDispatch(proposal, [], "fixture").kind).toBe("invalid");
    const repair = buildPlanNormalizationRepair(error, [proposal]);
    expect(repair.errorCode).toBe("plan_evidence_requirements_invalid");
    const diagnostic = candidateRejectionFromPlan(repair);
    expect(diagnostic?.code).toBe("PLAN_EVIDENCE_REQUIREMENTS_INVALID");
    expect(candidateRejectionMessage(diagnostic)).toContain("证据需求");
    expect(JSON.stringify(diagnostic)).not.toContain("/fixture");
  });
  it("Shell不能凭声明获得工具的正文契约", () => {
    const proposal: PlanStep = { ...step(), action: { type: "shell", command: "cat /fixture" }, command: "cat /fixture" };
    expect(() => normalizePlanPreconditions([proposal])).toThrow("PLAN_EVIDENCE_REQUIREMENTS_INVALID");
    expect(resolveStepDispatch(proposal, [], "fixture").kind).toBe("invalid");
    expect(() => normalizePlanPreconditions([{ ...proposal, evidenceRequirements: [] }])).not.toThrow();
  });
  it("声明在审批等待期间被删除则拒绝批准", () => {
    const proposal = { ...step(), risk: "high" as const };
    requestStepApproval("safe", proposal); delete proposal.evidenceRequirements;
    expect(acceptStepApproval(proposal)).toBeUndefined();
  });
  it("审批后篡改正文声明使批准和派发同时失效", () => {
    const prepared = preparePlanForApproval([{ ...step(), risk: "high" }], context);
    const live = JSON.parse(JSON.stringify(prepared.compatibilitySteps[0])) as PlanStep;
    requestStepApproval("safe", live); expect(acceptStepApproval(live, prepared)).toBeDefined();
    expect(hasCurrentStepApproval(live)).toBe(true); live.evidenceRequirements = [];
    expect(hasCurrentStepApproval(live)).toBe(false); expect(stepMatchesExecutionIntent(live)).toBe(false);
    expect(resolveStepDispatch(live, [], "fixture").kind).toBe("invalid");
  });
  it("仅证据声明改变也会增加计划版本并改变语义指纹", () => {
    const before = preparePlanForApproval([step()], context);
    const changed = { ...step(), evidenceRequirements: [] };
    const after = preparePlanForApproval([changed], { ...context, previous: before });
    expect(after.planRevision).toBe(before.planRevision + 1); expect(after.steps[0]?.stepRevision).toBe(2);
    expect(planSemanticFingerprint([changed])).not.toBe(planSemanticFingerprint([step()]));
  });
  it("局部参数修复不得删除原正文需求，压缩上下文保真", () => {
    const invalid = step(); invalid.action = { type: "tool", toolId: "files.read_content", arguments: { path: "" } };
    const repair = buildPlanNormalizationRepair(catchError(() => normalizePlanPreconditions([invalid])), [invalid]);
    expect(() => assertPlanRepairScope(repair, [step()])).not.toThrow();
    expect(() => assertPlanRepairScope(repair, [{ ...step(), evidenceRequirements: [] }])).toThrow("evidenceRequirements");
    const compact = JSON.parse(compactProtocolRepairContext(planEvidenceContext("{}"), repair));
    expect(compact.planGenerationRepair.previousModelOutput[0].evidenceRequirements).toEqual(["file_content"]);
    expect(compact._planEvidenceContract).toEqual({ version: 1 });
  });
  it("模型目录能力取自输出契约，描述不能授予能力", () => {
    const tools = defaultToolCatalog.filter(t => ["files.read_content", "files.preview_deletion"].includes(t.id));
    const directory = buildToolContext(tools.map(t => ({ ...t, outputDescription: "返回正文" })));
    expect(directory.find(t => t.id === "files.read_content")?.providedEvidence).toEqual(["file_content"]);
    expect(directory.find(t => t.id === "files.preview_deletion")).not.toHaveProperty("providedEvidence");
    expect(directory.every(t => !("outputSchema" in t))).toBe(true);
  });
  it("旧未准备计划的模糊需求也在最终派发被拒绝", () => {
    expect(resolveStepDispatch(step("files.preview_deletion"), [], "fixture").kind).toBe("invalid");
  });
  it("版本标记保留原预算与操作归属", () => {
    const original = { _taskModelBudget: { taskMaxTotalTokens: 250000, roundMaxTotalTokens: 250000 }, _modelRecovery: { operationId: "same" } };
    expect(JSON.parse(planEvidenceContext(JSON.stringify(original)))).toEqual({ ...original, _planEvidenceContract: { version: 1 } });
  });
});
