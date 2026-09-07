import type { PlanStep } from "@/types";

import { textFingerprint } from "./longRunningReviewOutput";

/** Preserve tool JSON as data; archived results can be read by task-scoped reference. */
export function modelToolOutput(step: PlanStep, value: string | undefined, allowArchive = false): unknown {
  const archive = allowArchive && value && step.evidence?.find(item => item.rawOutput === value
    && item.archive?.fingerprint === textFingerprint(value))?.archive;
  if (archive && value) {
    return { ...archive, archived: true, historical: true,
      preview: `${value.slice(0, 768)}\n…\n${value.slice(-768)}`,
      readTool: "evidence.read", instruction: "预览省略了内容；判断依赖省略部分时用 evidence.read 分页读取。历史证据须按目标和状态重新确认。" };
  }
  if (typeof step.result?.facts.toolId === "string" && value) {
    try { return JSON.parse(value) as unknown; } catch { /* Legacy text or a partial output. */ }
  }
  return value;
}

/**
 * References resolve within this step record, in this same request. This is
 * lossless deduplication, not a cross-request cache or a summary of evidence.
 * The persisted execution ledger is never modified.
 */
export function executionContextEvidence(
  step: PlanStep,
  projectOutput: (value: string | undefined) => string | undefined,
  allowArchive = false,
) {
  const output = projectOutput(step.output);
  const resultFacts = step.result?.facts;
  return {
    output: modelToolOutput(step, output, allowArchive),
    evidence: step.evidence?.map(({ id, type, source, facts, rawOutput, scope, collectedAt, archive }) => {
      const projected = projectOutput(rawOutput);
      const sharedKeys = resultFacts ? Object.keys(facts).filter((key) =>
        Object.prototype.hasOwnProperty.call(resultFacts, key)
        && JSON.stringify(facts[key]) === JSON.stringify(resultFacts[key]),
      ) : [];
      const shared = new Set(sharedKeys);
      return {
        id, type, source, scope, collectedAt, archive,
        facts: Object.fromEntries(Object.entries(facts).filter(([key]) => !shared.has(key))),
        factsFromResult: sharedKeys.length ? sharedKeys : undefined,
        rawOutput: rawOutput === step.output && output
          ? undefined : modelToolOutput(step, projected, allowArchive),
        rawOutputRef: rawOutput === step.output && output ? "output" : undefined,
      };
    }),
  };
}

export const EXECUTION_EVIDENCE_REFERENCE_INSTRUCTION =
  "每个步骤内 evidence.rawOutputRef=output 表示原文与该步骤 output 完全相同；factsFromResult 中各键的值取自同一步骤 result.facts。引用内容均在本次请求内，不能将引用或计划描述当成额外成功证据。";
