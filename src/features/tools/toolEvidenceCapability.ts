import type { PlanEvidenceKind, PlanStep } from "@/types";
import type { ToolDefinition } from "./types";
import { RECOVERY_RULE_VERSION, RecoveryProtocolError } from "@/services/recoveryRules";

/** Evidence kinds describe result data, never execution permission or completeness. */
export type ToolEvidenceKind = PlanEvidenceKind;

/** Omission is legacy; null, unknown kinds and duplicates are not declarations. */
export function assertPlanEvidenceRequirements(
  step: Partial<Pick<PlanStep, "id" | "action" | "evidenceRequirements">>, stepIndex = 0,
): void {
  const value: unknown = step.evidenceRequirements;
  if (value === undefined || (Array.isArray(value) && value.length <= 1
    && value.every(kind => kind === "file_content") && (!value.length || step.action?.type === "tool"))) return;
  throw new RecoveryProtocolError({ code: "PLAN_EVIDENCE_REQUIREMENTS_INVALID", stepIndex, stepId: step.id,
    fieldPath: `steps[${stepIndex}].evidenceRequirements`, ruleVersion: RECOVERY_RULE_VERSION, allowedRepairPaths: [],
    expected: "证据需求必须为无重复的数组，当前仅支持 file_content；该类型仅适用于具有正文输出契约的工具，Shell 使用空数组。请重新生成完整候选并重新审批，不得删除正文需求绕过能力核对。" });
}

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/** A description or an optional/nested `content` member is not a body contract.
 * Keep this intentionally narrow: other result layouts need an explicit adapter,
 * not guesses based on tool names or recursive property-name searches. */
export function providedToolEvidence(tool: ToolDefinition): readonly ToolEvidenceKind[] {
  const schema = tool.outputSchema;
  if (!schema || schema.type !== "object" || !object(schema.properties) || !Array.isArray(schema.required)) return [];
  const properties = schema.properties;
  const required = schema.required;
  return ["path", "content"].every(key => required.includes(key)
    && object(properties[key]) && properties[key].type === "string") ? ["file_content"] : [];
}

const fileSubject = /文件|配置|文档|\b(?:files?|configuration|configs?|documents?)\b/i;
const body = /正文|文件内容|配置内容|文本内容|\b(?:file|configuration|config|document)\s+text\b|\b(?:contents?|body)\b/i;
const bodyMetadata = /^\s*(?:的)?(?:路径|大小|长度|摘要|哈希|校验和|元数据|是否|可读性|存在性)|^\s+(?:hash|checksum|length|size|path|metadata)\b/i;
const acquire = /读取|读出|获取|取得|获得|返回|展示|解析|\b(?:reads?|returns?|obtains?|acquires?|retrieves?|fetch(?:es)?|parses?|shows?)\b/i;
const negative = /不|无需|无须|禁止|避免|不能|未|\b(?:no|not|never|without|cannot|can't|don't|doesn't)\b/i;
const future = /下一步|后续|随后|之后|稍后|\b(?:later|next|subsequent|then)\b/i;

/** Legacy expected is prose, not a structured evidence declaration. Recognize
 * explicit, positive file-body acquisition outcomes only, with clause-local
 * negation/future handling. Titles, user root goals and unrelated plan members
 * cannot impose a body demand on an ordinary metadata preflight.
 * This bounded compatibility adapter is NOT a general natural-language verifier. */
export function requiredToolEvidence(step: Pick<PlanStep, "expected" | "description" | "evidenceRequirements">): readonly ToolEvidenceKind[] {
  if (step.evidenceRequirements?.includes("file_content")) return ["file_content"];
  if (!fileSubject.test(`${step.description ?? ""}\n${step.expected ?? ""}`)) return [];
  const clauses = (step.expected ?? "").split(/[。；;！!？?\n，,]|但是|但|\b(?:but|however|and)\b|并且|并/iu);
  return clauses.some(clause => {
    const verb = clause.search(acquire), match = body.exec(clause);
    if (verb < 0 || !match || match.index < verb) return false;
    // Acquiring a body's checksum/path is still metadata, not the body itself.
    if (bodyMetadata.test(clause.slice(match.index + match[0].length))) return false;
    // Restrict acquisition to the immediate claimed result. Negative/future
    // words after the body do not erase an already positive acquisition claim.
    const prefix = clause.slice(0, match.index);
    return !negative.test(prefix) && !future.test(prefix);
  }) ? ["file_content"] : [];
}

/** Shared by candidate admission, approval preparation and final dispatch. */
export function assertToolEvidenceCapability(
  step: Pick<PlanStep, "expected" | "description" | "id" | "action" | "evidenceRequirements">,
  tool: ToolDefinition,
  stepIndex = 0,
): void {
  assertPlanEvidenceRequirements(step, stepIndex);
  const required = requiredToolEvidence(step), provided = providedToolEvidence(tool);
  if (!required.some(kind => !provided.includes(kind))) return;
  // Static diagnostic: no user paths, prose, returned data or credential values.
  throw new RecoveryProtocolError({ code: "TOOL_EVIDENCE_CAPABILITY_MISMATCH", stepIndex, stepId: step.id,
    fieldPath: `steps[${stepIndex}].action`, matchedToken: "file_content", ruleVersion: RECOVERY_RULE_VERSION,
    expected: "当前步骤承诺取得文件正文，但所选工具的输出契约不保证返回文件路径和正文。应依据当前目录选择具备正文证据能力的工具，重新生成完整候选并重新审批；不得只补参数、改写预期掩盖缺口或将元数据当作正文。",
    allowedRepairPaths: [] });
}
