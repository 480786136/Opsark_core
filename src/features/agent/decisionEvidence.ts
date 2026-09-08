import type { ExecutionEvidence } from "@/types";
import { compactReviewText, textFingerprint } from "./longRunningReviewOutput";

export const SHORT_DECISION_OUTPUT_LIMIT = 2_048;
export const DECISION_OUTPUT_BUDGET = 12_000;

export function redactDecisionText(value: string) {
  return value
    .replace(/((?:--?)(?:password|passwd|pwd|token|access[_-]?token|api[_-]?key|secret|credential)(?:=|\s+))(?:("[^"]*")|('[^']*')|([^\s]+))/giu, "$1••••••••")
    .replace(/([?&](?:password|passwd|pwd|token|access[_-]?token|api[_-]?key|secret|credential)=)[^&#\s]+/giu, "$1••••••••")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/'"`:@]+:)[^@\s/'"`]+@/giu, "$1••••••••@");
}

/** Projection only. Omitted text is still evidence, not a missing observation. */
export function decisionOutput(
  value: string | undefined,
  evidence: ExecutionEvidence[] = [],
  limit = SHORT_DECISION_OUTPUT_LIMIT,
  allowArchive = false,
) {
  if (!value) return undefined;
  const safe = redactDecisionText(value);
  const available = Math.max(0, limit);
  const complete = safe.length <= available;
  const references = evidence.filter(item => item.archive
    && item.archive.fingerprint === textFingerprint(item.rawOutput)).map(item => ({
    source: item.source, sourceEvidenceId: item.id, ...item.archive,
    readTool: allowArchive ? "evidence.read" : undefined,
  }));
  return {
    content: available ? (complete ? safe : compactReviewText(safe, available)) : undefined,
    contentState: complete ? "complete" as const : available ? "excerpt" as const : "omitted" as const,
    totalCharacters: safe.length,
    omittedCharacters: Math.max(0, safe.length - available),
    fingerprint: textFingerprint(safe),
    references: references.length ? references : undefined,
    instruction: complete ? undefined : allowArchive && references.length
      ? "正文已省略；需要省略部分时先用 evidence.read 读取已有证据，不能仅因上下文省略而再次执行远程检查。"
      : "正文已省略但原始执行记录仍保留；省略不代表未采集。当前无可用补读工具，不得据此猜测状态或宣告完成。",
  };
}

/** One output budget shared by current steps, recent phases and history. */
export function decisionOutputProjector(allowArchive: boolean, budget = DECISION_OUTPUT_BUDGET) {
  let remaining = budget;
  return (value: string | undefined, evidence: ExecutionEvidence[] = [], limit = SHORT_DECISION_OUTPUT_LIMIT) => {
    const result = decisionOutput(value, evidence, Math.min(limit, remaining), allowArchive);
    remaining = Math.max(0, remaining - (result?.content?.length ?? 0));
    return result;
  };
}

export const DECISION_EVIDENCE_INSTRUCTION = "成功与失败输出都是执行证据；contentState=excerpt/omitted 只表示上下文压缩，不表示尚未检查。优先补读现有证据，再决定是否需要重新执行。capturedPartial/truncated 表示采集本身不完整，不能与上下文省略混淆。历史失败描述一次执行尝试，不自动证明当前目标未满足；须结合相同目标下较新的验收证据判断。";
