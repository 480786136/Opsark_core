import type { ExecutionEvidence } from "@/types";
import { compactReviewText, textFingerprint } from "./longRunningReviewOutput";
import { compactReviewOutput } from "./reviewPayload";
import { redactExecutionOutput } from "./secretTool";

export const SHORT_DECISION_OUTPUT_LIMIT = 2_048;
export const DECISION_OUTPUT_BUDGET = 12_000;

/** References only reuse byte-identical text present in this request. They do
 * not establish evidence freshness, a new observation, or new authority. */
export const SAME_REQUEST_TEXT_REFERENCE_INSTRUCTION = "terminalReferenceRef 指向本次请求 terminalContext.content 中完全相同的原文；来源、行数和 hasMore 仍以 terminalContext 为准。引用不代表新增证据，也不代表完整采集或当前状态。";

export function duplicateTerminalReference(reference: string | undefined, content: string | undefined) {
  if (!reference || reference !== content) return false;
  // The reference and its explicit interpretation must save actual serialized
  // UTF-8 bytes; short inputs remain unchanged, with no cosmetic compression.
  const encoder = new TextEncoder();
  return encoder.encode(JSON.stringify({ terminalReference: reference })).length
    > encoder.encode(JSON.stringify({ terminalReferenceRef: "terminalContext.content",
      contextReferenceInstruction: SAME_REQUEST_TEXT_REFERENCE_INSTRUCTION })).length;
}

export function redactDecisionText(value: string) {
  return redactExecutionOutput(value, {})
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
  let content = available ? (complete ? safe : compactReviewText(safe, available)) : undefined;
  if (!complete && available >= 256) {
    // Keep critical middle lines inside the same body/budget; duplicating them
    // in a separate salientLines array used to bypass the global output budget.
    const salient = compactReviewOutput(safe, available, Math.min(800, Math.floor(available / 3)))
      ?.salientLines?.filter(line => !content?.includes(line));
    if (salient?.length) {
      const appendix = compactReviewText(salient.join("\n"), Math.min(800, Math.floor(available / 3)));
      const separator = "\n[关键证据行]\n";
      content = `${compactReviewText(safe, available - appendix.length - separator.length)}${separator}${appendix}`;
    }
  }
  const references = evidence.filter(item => item.archive
    && (!item.archive.sourceEvidenceId || item.archive.sourceEvidenceId === item.id)
    && (!item.scope?.targetId || !item.archive.serverId || item.scope.targetId === item.archive.serverId)
    && item.archive.fingerprint === textFingerprint(item.rawOutput)).map(item => ({
    source: item.source, sourceEvidenceId: item.id, ...item.archive,
    readTool: allowArchive ? "evidence.read" : undefined,
  }));
  return {
    content,
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
export function decisionOutputProjector(allowArchive: boolean, budget = DECISION_OUTPUT_BUDGET, preferComplete = false) {
  let remaining = budget;
  return (value: string | undefined, evidence: ExecutionEvidence[] = [], limit = SHORT_DECISION_OUTPUT_LIMIT) => {
    // Reallocate the existing budget, never increase it. Fixed per-location
    // excerpts can hide a medium body's middle even with ample space left.
    // A zero limit remains an explicit metadata-only projection.
    const length = value ? redactDecisionText(value).length : 0;
    const allocation = preferComplete && limit > 0 && length <= 6_000 && length <= remaining
      ? Math.max(limit, length) : limit;
    const result = decisionOutput(value, evidence, Math.min(allocation, remaining), allowArchive);
    remaining = Math.max(0, remaining - (result?.content?.length ?? 0));
    return result;
  };
}

export const DECISION_EVIDENCE_INSTRUCTION = "成功与失败输出都是执行证据；contentState=excerpt/omitted 只表示上下文压缩，不表示尚未检查。优先补读现有证据，再决定是否需要重新执行。capturedPartial/truncated 表示采集本身不完整，不能与上下文省略混淆。历史失败描述一次执行尝试，不自动证明当前目标未满足；须结合相同目标下较新的验收证据判断。";
