import {
  compactReviewText,
  textFingerprint,
} from "@/features/agent/longRunningReviewOutput";
import type { ExecutionEvidence, PlanStep, StepResult } from "@/types";

const REVIEW_VALUE_STRING_LIMIT = 480;
const REVIEW_VALUE_ARRAY_LIMIT = 10;
const REVIEW_VALUE_OBJECT_LIMIT = 24;
const REVIEW_VALUE_DEPTH_LIMIT = 4;
const REVIEW_SALIENT_LINE_LIMIT = 360;

const REVIEW_SALIENT_LINE = /(?:\b(?:error|fatal|failed|failure|exception|warning|warn|timeout|timed out|refused|denied|unsupported|unhealthy|oom|killed)\b|no space left|out of memory|not found|caused by|nosuchfielderror|\[exit:\s*-?\d+\]|错误|失败|异常|警告|超时|拒绝|不支持|未找到|内存不足)/i;

function boundedStructuredValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return compactReviewText(value, REVIEW_VALUE_STRING_LIMIT);
  if (depth >= REVIEW_VALUE_DEPTH_LIMIT) {
    try {
      return compactReviewText(JSON.stringify(value), REVIEW_VALUE_STRING_LIMIT);
    } catch {
      return compactReviewText(String(value), REVIEW_VALUE_STRING_LIMIT);
    }
  }
  if (Array.isArray(value)) {
    if (value.length <= REVIEW_VALUE_ARRAY_LIMIT) {
      return value.map((item) => boundedStructuredValue(item, depth + 1));
    }
    const head = value.slice(0, 6).map((item) => boundedStructuredValue(item, depth + 1));
    const tail = value.slice(-3).map((item) => boundedStructuredValue(item, depth + 1));
    return [...head, { omittedItems: value.length - 9 }, ...tail];
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const result = Object.fromEntries(
      entries.slice(0, REVIEW_VALUE_OBJECT_LIMIT).map(([key, item]) => [
        key,
        boundedStructuredValue(item, depth + 1),
      ]),
    );
    if (entries.length > REVIEW_VALUE_OBJECT_LIMIT) {
      result.omittedFields = entries.length - REVIEW_VALUE_OBJECT_LIMIT;
    }
    return result;
  }
  return compactReviewText(String(value), REVIEW_VALUE_STRING_LIMIT);
}

function fitStructuredValue(value: unknown, limit: number) {
  const compacted = boundedStructuredValue(value);
  const serialized = JSON.stringify(compacted);
  if (serialized.length <= limit) return compacted;
  return {
    compactedJson: compactReviewText(serialized, limit),
    originalCharacters: serialized.length,
    fingerprint: textFingerprint(serialized),
  };
}

function salientOutputLines(value: string, limit: number) {
  const candidates = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && REVIEW_SALIENT_LINE.test(line))
    .map((line) => compactReviewText(line, REVIEW_SALIENT_LINE_LIMIT));
  const unique = [...new Map(candidates.map((line) => [line.toLocaleLowerCase(), line])).values()];
  const selected: string[] = [];
  let characters = 0;
  for (const line of unique.slice(-10).reverse()) {
    if (selected.length && characters + line.length + 1 > limit) break;
    selected.push(line);
    characters += line.length + 1;
  }
  return selected.reverse();
}

export function compactReviewOutput(
  output: string | undefined,
  contentLimit = 1_800,
  salientLimit = 800,
) {
  const value = output?.trim() ?? "";
  if (!value) return undefined;
  const content = compactReviewText(value, contentLimit);
  const salientLines = salientOutputLines(value, salientLimit);
  return {
    totalCharacters: value.length,
    omittedCharacters: Math.max(0, value.length - contentLimit),
    fingerprint: textFingerprint(value),
    content,
    salientLines: salientLines.length ? salientLines : undefined,
  };
}

export function reviewOutputMetadata(output: string | undefined) {
  const value = output?.trim() ?? "";
  if (!value) return undefined;
  return {
    totalCharacters: value.length,
    fingerprint: textFingerprint(value),
  };
}

export function compactReviewResult(result: StepResult | undefined, limit = 1_800) {
  if (!result) return undefined;
  const compacted = {
    executionStatus: result.executionStatus,
    observationStatus: result.observationStatus,
    exitCode: result.exitCode,
    facts: fitStructuredValue(result.facts, Math.max(480, limit - 600)),
    warnings: result.warnings.slice(-6).map((warning) => compactReviewText(warning, 360)),
    failureReason: result.failureReason
      ? compactReviewText(result.failureReason, 600)
      : undefined,
  };
  const serialized = JSON.stringify(compacted);
  if (serialized.length <= limit) return compacted;
  return {
    executionStatus: result.executionStatus,
    observationStatus: result.observationStatus,
    exitCode: result.exitCode,
    category: typeof result.facts.category === "string"
      ? compactReviewText(result.facts.category, 120)
      : undefined,
    failureReason: result.failureReason
      ? compactReviewText(result.failureReason, 600)
      : undefined,
    compactedResult: compactReviewText(serialized, limit),
  };
}

export function compactReviewEvidence(
  evidence: ExecutionEvidence[] | undefined,
  options: {
    maxItems?: number;
    rawOutputLimit?: number;
    mainOutputLimit?: number;
    validationOutputLimit?: number;
    factsLimit?: number;
  } = {},
) {
  if (!evidence?.length) return undefined;
  const maxItems = options.maxItems ?? 4;
  const rawOutputLimit = options.rawOutputLimit ?? 0;
  const factsLimit = options.factsLimit ?? 800;
  const selected = evidence.slice(-maxItems);
  return {
    totalItems: evidence.length,
    omittedItems: Math.max(0, evidence.length - selected.length),
<<<<<<< HEAD
    items: selected.map(({ type, source, facts, rawOutput, scope }) => {
=======
    items: selected.map(({ id, type, source, facts, rawOutput, scope, collectedAt, archive }) => {
>>>>>>> origin/master
      const outputLimit = source === "main"
        ? options.mainOutputLimit ?? rawOutputLimit
        : options.validationOutputLimit ?? rawOutputLimit;
      return {
<<<<<<< HEAD
=======
        id,
        collectedAt,
        archive,
>>>>>>> origin/master
        type,
        source,
        facts: fitStructuredValue(facts, factsLimit),
        scope,
        output: outputLimit > 0
          ? compactReviewOutput(rawOutput, outputLimit, Math.min(480, outputLimit))
          : undefined,
      };
    }),
  };
}

export function compactReviewPlanStep(
  step: PlanStep,
  options: { commandLimit?: number; validationLimit?: number; includeStatus?: boolean } = {},
) {
  return {
    title: compactReviewText(step.title, 180),
    description: compactReviewText(step.description, 320),
    command: compactReviewText(step.command, options.commandLimit ?? 640),
    commandFingerprint: textFingerprint(step.command),
    expected: compactReviewText(step.expected, 320),
    validation: compactReviewText(step.validation, options.validationLimit ?? 480),
    risk: step.risk,
    status: options.includeStatus === false ? undefined : step.status,
  };
}

export function reviewPlanSummary(steps: PlanStep[]) {
  const statusCounts = steps.reduce<Record<string, number>>((counts, step) => {
    counts[step.status] = (counts[step.status] ?? 0) + 1;
    return counts;
  }, {});
  return { totalSteps: steps.length, statusCounts };
}
