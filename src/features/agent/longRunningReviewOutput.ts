import { sanitizeTerminalOutput } from "@/utils/terminal";

export const LONG_RUNNING_OUTPUT_CONTEXT_LIMIT = 1_200;
export const LONG_RUNNING_GOAL_CONTEXT_LIMIT = 1_200;
export const LONG_RUNNING_COMMAND_CONTEXT_LIMIT = 800;
export const LONG_RUNNING_SALIENT_EVIDENCE_LIMIT = 600;

const OUTPUT_CURSOR_ANCHOR_LENGTH = 160;
const OUTPUT_LINE_LIMIT = 360;

export interface LongRunningOutputCursor {
  initialized: boolean;
  offset: number;
  anchor: string;
}

export interface LongRunningOutputWindow {
  mode: "initial" | "delta" | "resync";
  newCharacters: number;
  omittedCharacters: number;
  contentFingerprint: string;
  content: string;
}

export function textFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function compactReviewText(value: string | undefined, limit: number) {
  const text = (value ?? "").trim();
  if (text.length <= limit) return text;
  const marker = `\n…[已压缩，原始 ${text.length} 字符，指纹 ${textFingerprint(text)}]…\n`;
  const available = Math.max(0, limit - marker.length);
  const headLength = Math.ceil(available * 0.4);
  const tailLength = Math.max(0, available - headLength);
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

function compactLongLine(line: string) {
  if (line.length <= OUTPUT_LINE_LIMIT) return line;
  const marker = ` …[单行 ${line.length} 字符，指纹 ${textFingerprint(line)}]… `;
  const available = OUTPUT_LINE_LIMIT - marker.length;
  const headLength = Math.max(0, Math.ceil(available * 0.35));
  return `${line.slice(0, headLength)}${marker}${line.slice(-(available - headLength))}`;
}

function isProgressLine(line: string) {
  return /(?:\b\d{1,3}(?:\.\d+)?%|\bETA\b|\b(?:KiB|MiB|GiB)\/s\b|\[[#=>.\-\s]{4,}\])/i.test(line);
}

const SPINNER_CHARACTERS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;
const LEADING_TIMESTAMP = /^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?|\d{4}[-/]\d{1,2}[-/]\d{1,2}[T\s]\d{1,2}:\d{2}(?::\d{2})?)\s*/;
const SALIENT_LINE = /(?:\b(?:error|fatal|failed|failure|exception|oom|killed|timeout|unsupported|warning|installed|completed|success|succeed)\b|\bwarn:|\bout of memory\b|\bno space left\b|\bpermission denied\b|\baccess denied\b|\bconnection refused\b|\btimed? out\b|\bnot found\b|\bbuilt in\b|\bbuild finished\b|\bdownload(?:ed|ing)?\b|错误|失败|拒绝|超时|内存不足|已完成|安装完成|构建完成)/i;
const CRITICAL_LINE = /(?:\b(?:error|fatal|failed|failure|exception|oom|killed|timeout)\b|\bout of memory\b|\bno space left\b|\bpermission denied\b|\baccess denied\b|\bconnection refused\b|\btimed? out\b|错误|失败|拒绝|超时|内存不足)/i;
const NAMED_ERROR_LINE = /\b[A-Z][A-Za-z0-9_$]*(?:Error|Exception)\b/;

function isSalientLine(line: string) {
  return SALIENT_LINE.test(line) || NAMED_ERROR_LINE.test(line);
}

function isCriticalLine(line: string) {
  return CRITICAL_LINE.test(line) || NAMED_ERROR_LINE.test(line);
}

/**
 * Returns whether a terminal fragment contains a newly observable failure.
 * Progress bars, timestamps and spinner updates are intentionally ignored so
 * callers can keep monitoring locally without asking the model to repeat the
 * same advisory review.
 */
export function hasCriticalLongRunningEvidence(output: string) {
  return sanitizeTerminalOutput(output)
    .split("\n")
    .map(normalizeSemanticLine)
    .some((line) => line.length > 0 && isCriticalLine(line));
}

function normalizeSemanticLine(line: string) {
  return line
    .replace(SPINNER_CHARACTERS, "")
    .replace(LEADING_TIMESTAMP, "")
    .replace(/[\t ]+/g, " ")
    .trim();
}

function collapseRepeatedLines(lines: string[]) {
  const collapsed: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    let end = index + 1;
    while (end < lines.length && lines[end] === line) end += 1;
    const count = end - index;
    collapsed.push(count > 1 && line ? `${line} （重复 ${count} 次）` : line);
    index = end;
  }
  return collapsed;
}

function compactTerminalFragment(fragment: string, limit: number) {
  const sanitized = sanitizeTerminalOutput(fragment);
  const lines = sanitized.split("\n");
  const compacted: string[] = [];
  const lastCompacted = () => compacted[compacted.length - 1];
  let pendingProgress: string | undefined;
  for (const rawLine of lines) {
    const line = compactLongLine(rawLine.replace(/[\t ]+$/g, ""));
    if (isProgressLine(line)) {
      pendingProgress = line;
      continue;
    }
    if (pendingProgress !== undefined) {
      if (lastCompacted() !== pendingProgress) compacted.push(pendingProgress);
      pendingProgress = undefined;
    }
    if (!line && !lastCompacted()) continue;
    compacted.push(line);
  }
  if (pendingProgress !== undefined && lastCompacted() !== pendingProgress) compacted.push(pendingProgress);

  const normalized = collapseRepeatedLines(compacted).join("\n").trim();
  if (!normalized) return "（本轮无新增可读终端输出）";
  if (normalized.length <= limit) return normalized;
  const marker = `…[较早输出已省略，保留末尾 ${limit} 字符]…\n`;
  return `${marker}${normalized.slice(-(limit - marker.length))}`;
}

/** Uses cleaned semantic output so cursor animation and timestamp-only changes are not progress. */
export function semanticLongRunningOutputFingerprint(output: string) {
  const normalized = sanitizeTerminalOutput(output)
    .split("\n")
    .map(normalizeSemanticLine)
    .filter(Boolean);
  const semantic = normalized
    .filter((line, index) => line !== normalized[index - 1])
    .slice(-400)
    .join("\n");
  return textFingerprint(semantic.slice(-16_384));
}

function evidenceKey(line: string) {
  return line.replace(/\s+（重复\s+\d+\s+次）$/, "").toLocaleLowerCase();
}

/** Keeps compact cross-review errors, warnings and milestones even when delta output advances. */
export function mergeLongRunningSalientEvidence(previous: string[], output: string) {
  const lines = sanitizeTerminalOutput(output)
    .split("\n")
    .map(normalizeSemanticLine)
    .filter((line) => line && isSalientLine(line));
  const counts = new Map<string, { line: string; count: number; order: number }>();
  lines.forEach((line, order) => {
    const compacted = compactLongLine(line);
    const key = evidenceKey(compacted);
    const existing = counts.get(key);
    counts.set(key, {
      line: compacted,
      count: (existing?.count ?? 0) + 1,
      order,
    });
  });
  const current = [...counts.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ line, count }) => count > 1 ? `${line} （重复 ${count} 次）` : line);
  const merged = new Map<string, string>();
  for (const line of [...previous, ...current]) merged.set(evidenceKey(line), line);
  const values = [...merged.values()];
  const critical = values.filter(isCriticalLine).slice(-5);
  const informative = values.filter((line) => !isCriticalLine(line)).slice(-3);
  while ([...critical, ...informative].join("\n").length > LONG_RUNNING_SALIENT_EVIDENCE_LIMIT) {
    if (informative.length > 1) informative.shift();
    else if (critical.length > 1) critical.shift();
    else break;
  }
  return [...critical, ...informative];
}

export function initialLongRunningOutputCursor(): LongRunningOutputCursor {
  return { initialized: false, offset: 0, anchor: "" };
}

/**
 * Extracts only output produced since the last accepted review. If the terminal
 * buffer rolled over or was rewritten, it safely resynchronizes from a bounded tail.
 */
export function buildLongRunningOutputWindow(
  output: string,
  cursor: LongRunningOutputCursor,
  limit = LONG_RUNNING_OUTPUT_CONTEXT_LIMIT,
): { window: LongRunningOutputWindow; nextCursor: LongRunningOutputCursor } {
  const anchorStart = Math.max(0, cursor.offset - cursor.anchor.length);
  const cursorStillValid = cursor.offset <= output.length
    && output.slice(anchorStart, cursor.offset) === cursor.anchor;
  const mode: LongRunningOutputWindow["mode"] = !cursor.initialized
    ? "initial"
    : cursorStillValid ? "delta" : "resync";
  const fragment = mode === "delta" ? output.slice(cursor.offset) : output;
  const content = compactTerminalFragment(fragment, limit);
  const omittedCharacters = Math.max(0, fragment.length - content.length);
  return {
    window: {
      mode,
      newCharacters: fragment.length,
      omittedCharacters,
      contentFingerprint: textFingerprint(fragment),
      content,
    },
    nextCursor: {
      initialized: true,
      offset: output.length,
      anchor: output.slice(-OUTPUT_CURSOR_ANCHOR_LENGTH),
    },
  };
}
