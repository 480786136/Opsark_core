import type { PlanStep } from "@/types";
import { operationsObservation, operationsProgressIdentity } from "@/features/tools/operationsObservation";
import { taskStepEvidenceKey } from "./taskHistoryCheckpoint";
import { compactReviewText, textFingerprint } from "./longRunningReviewOutput";
import { decisionOutput, redactDecisionText, SHORT_DECISION_OUTPUT_LIMIT } from "./decisionEvidence";

export const OPERATIONS_SUMMARY_BUDGET = 6000;
const safe = (value: unknown): unknown => typeof value === "string" ? compactReviewText(redactDecisionText(value), 300)
  : Array.isArray(value) ? value.map(safe)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item)])) : value;

function inspectionItems(items: Record<string, unknown>[]) {
  const selected = items.slice(0, 3);
  // A text field can contain the entire port/service table. Do not silently
  // clip it like a label while retaining the collector's coverageComplete flag.
  const textLimit = Math.min(SHORT_DECISION_OUTPUT_LIMIT, Math.floor(3600 / Math.max(1, selected.length)));
  return selected.map(item => {
    const { text, ...fields } = item;
    const projected = safe(fields) as Record<string, unknown>;
    if (typeof text !== "string") return { ...projected, ...(text === undefined ? {} : { text: safe(text) }) };
    const output = decisionOutput(text, [], textLimit);
    const { content, ...metadata } = output ?? { content: text, contentState: "complete" };
    return { ...projected, text: content, textProjection: metadata };
  });
}

/** Pure projection. Original output, provenance, approvals and recovery records remain intact. */
export function operationsPlanningContext(steps: PlanStep[]) {
  const refs = new Map<string, string>();
  const unique = new Map<string, PlanStep>();
  steps.forEach(step => unique.set(taskStepEvidenceKey(step), step));
  const entries = [...unique.values()].flatMap(step => {
    const data = operationsObservation(step);
    return data ? [{ step, data, progress: textFingerprint(JSON.stringify([step.attemptContext, operationsProgressIdentity(step)])) }] : [];
  });
  const repeats = new Map<string, number>();
  entries.forEach(({ progress }) => repeats.set(progress, (repeats.get(progress) ?? 0) + 1));
  const observations: Array<Record<string, unknown>> = [];
  const bodies = new Map<string, string>();
  let omitted = 0;
  let used = 0;
  for (const { step, data, progress } of [...entries].reverse()) {
    const { finishedAt, elapsedMs: _elapsed, ...facts } = data;
    // Dedup only equivalent observation bodies on the same target. Different
    // values/scopes stay distinct, even if loop detection regards them as polling.
    const identity = textFingerprint(JSON.stringify({ target: step.attemptContext, facts }));
    const existing = bodies.get(identity);
    if (existing) { refs.set(taskStepEvidenceKey(step), existing); continue; }
    const requestText = JSON.stringify(safe(data.request));
    const summary: Record<string, unknown> = {
      stepId: step.id, toolId: step.action?.type === "tool" ? step.action.toolId : undefined,
      targetContext: step.attemptContext,
      request: requestText.length <= 1200 ? safe(data.request) : undefined,
      requestOmitted: requestText.length > 1200 || undefined,
      status: data.status, coverageComplete: data.coverageComplete, truncated: data.truncated,
      sampledAt: finishedAt, repeatedObservationCount: repeats.get(progress),
      scannedEntries: data.scannedEntries, matchedEntries: data.matchedEntries, skippedCount: data.skippedCount,
      // Reasons are from the retained diagnostic sample, never counts for all skipped paths.
      skippedReasons: [...new Set(data.skipped.map(item => item.reason))],
      skippedSample: safe(data.skipped.slice(0, 3)), omittedSkippedDetails: Math.max(0, data.skippedCount - Math.min(3, data.skipped.length)),
      items: inspectionItems(data.items), omittedItems: Math.max(0, data.items.length - 3),
    };
    const size = JSON.stringify(summary).length;
    if (observations.length >= 12 || used + size > OPERATIONS_SUMMARY_BUDGET) { omitted++; continue; }
    used += size;
    const ref = `operationsEvidence.observations[${observations.length}]`;
    refs.set(taskStepEvidenceKey(step), ref); bodies.set(identity, ref); observations.push(summary);
  }
  return { refs, context: entries.length ? {
    observations, omittedObservations: omitted,
    instruction: "这里只是已执行检查的事实摘要；status=complete、coverageComplete 和 observationStatus=matched 只表示检查已执行，不证明 expected 或用户目标达成。items[].textProjection.contentState=excerpt/omitted 或 omittedItems>0 表示上下文省略，不能因未看到某端口/进程就断言不存在，应按步骤 output.references 补读已有证据。items/skippedSample 不完整时同样先补读。相同正文可引用同一摘要，但采样时间不等于当前状态；较新观察与先前成功矛盾时，以较新事实重新判断，进程重新出现应先核对托管服务或父进程，不循环 kill。repeatedObservationCount 仅提示重复取证，不是业务完成判断。重复 capacity 基线不能定位空间归属；depth 限制应调整扫描深度或范围，不重复浅扫描；reportDepth 仅控制汇总展示。一次调用只有一个 path/service/url，描述必须对应实际参数。下一阶段针对具体覆盖缺口获取新证据；已有部分证据足以回答时给出有边界的结论，不必穷尽全盘。",
  } : undefined };
}

export function inspectionDecisionStep(step: PlanStep): PlanStep {
  if (!operationsObservation(step) || !step.result) return step;
  const { toolId, evidenceComplete, inspectionStatus, truncated } = step.result.facts;
  return { ...step,
    result: { ...step.result, facts: { toolId, evidenceComplete, inspectionStatus, truncated } },
    evidence: step.evidence?.map(item => ({ ...item, facts: {} })),
  };
}
