import type { CandidateRejectionDiagnostic, PlanStep } from "@/types";
import { defaultToolCatalog } from "@/features/tools/toolCatalog";

const codes = new Set(["TOOL_ARGUMENT_INVALID", "TOOL_EVIDENCE_CAPABILITY_MISMATCH", "PLAN_EVIDENCE_REQUIREMENTS_INVALID", "PLAN_CANDIDATE_REJECTED", "MODEL_FORMAT_INVALID", "MODEL_OUTPUT_TRUNCATED", "MODEL_RECOVERY_SCOPE_REJECTED", "MODEL_OUTPUT_REPAIR_EXHAUSTED"]);
const knownTools = new Set(defaultToolCatalog.map(tool => tool.id));
const keywords = new Set(["minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "required", "type", "enum", "const", "pattern", "minimum", "maximum", "additionalProperties", "anyOf", "oneOf"]);

/** Bounded diagnostics survive storage without copying raw responses or values. */
export function parseCandidateRejection(value: unknown): CandidateRejectionDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || item.rejectedCandidateExecuted !== false || typeof item.code !== "string" || !codes.has(item.code)) return;
  const toolIds = Array.isArray(item.toolIds) ? [...new Set(item.toolIds.filter((id): id is string => typeof id === "string" && knownTools.has(id)))].slice(0, 4) : [];
  return { version: 1, code: item.code as CandidateRejectionDiagnostic["code"], rejectedCandidateExecuted: false,
    ...(typeof item.keyword === "string" && keywords.has(item.keyword) ? { keyword: item.keyword } : {}),
    ...(typeof item.stepIndex === "number" && Number.isSafeInteger(item.stepIndex) && item.stepIndex >= 0 && item.stepIndex < 10000 ? { stepIndex: item.stepIndex } : {}),
    ...(toolIds.length ? { toolIds } : {}) };
}

/** Only Core's rejected proposal metadata is projected, never its values or text. */
export function candidateRejectionFromPlan(repair: {
  candidateRejection?: unknown;
  diagnostic?: { code?: string; stepIndex?: number };
  errorCode?: string;
  fieldPath?: string;
  previousModelOutput?: readonly PlanStep[];
}): CandidateRejectionDiagnostic | undefined {
  const prior = parseCandidateRejection(repair.candidateRejection);
  if (prior) return prior;
  const index = repair.diagnostic?.stepIndex ?? Number(repair.fieldPath?.match(/^steps\[(\d+)\]/)?.[1] ?? NaN);
  const indexed = Number.isSafeInteger(index) && index >= 0 && index < 10000;
  const rejected = Array.isArray(repair.previousModelOutput) ? repair.previousModelOutput : [];
  const steps = indexed ? rejected.slice(index, index + 1) : rejected;
  return parseCandidateRejection({ version: 1, rejectedCandidateExecuted: false,
    code: repair.diagnostic?.code === "PLAN_EVIDENCE_REQUIREMENTS_INVALID" || repair.errorCode === "plan_evidence_requirements_invalid" ? "PLAN_EVIDENCE_REQUIREMENTS_INVALID"
      : repair.diagnostic?.code === "TOOL_EVIDENCE_CAPABILITY_MISMATCH" || repair.errorCode === "tool_evidence_capability_mismatch" ? "TOOL_EVIDENCE_CAPABILITY_MISMATCH"
      : repair.diagnostic?.code === "TOOL_ARGUMENT_INVALID" || repair.errorCode === "tool_schema_validation_failed" ? "TOOL_ARGUMENT_INVALID" : "PLAN_CANDIDATE_REJECTED",
    stepIndex: index, toolIds: steps.flatMap(step => step?.action?.type === "tool" ? [step.action.toolId] : []) });
}

export function candidateRejectionMessage(value: unknown): string {
  const diagnostic = parseCandidateRejection(value);
  if (!diagnostic) return "";
  const step = diagnostic.stepIndex === undefined ? "原候选" : `原候选第 ${diagnostic.stepIndex + 1} 步`;
  const reason = diagnostic.code === "TOOL_ARGUMENT_INVALID" ? diagnostic.keyword === "minItems" ? "工具参数列表条目不足" : "工具参数未通过校验"
    : diagnostic.code === "TOOL_EVIDENCE_CAPABILITY_MISMATCH" ? "工具缺少所承诺的文件正文证据能力"
    : diagnostic.code === "PLAN_EVIDENCE_REQUIREMENTS_INVALID" ? "证据需求声明未通过校验"
    : diagnostic.code === "MODEL_OUTPUT_TRUNCATED" ? "输出不完整"
    : diagnostic.code === "MODEL_RECOVERY_SCOPE_REJECTED" ? "未通过只读安全校验"
    : "未通过计划或响应契约校验";
  return `${step}${diagnostic.toolIds?.length ? `（${diagnostic.toolIds.join("、")}）` : ""}${reason}，该候选未执行。`;
}
