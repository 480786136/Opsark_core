import type { TerminalShortcutPreset } from "@/features/preferences/preferenceStore";

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const DANGEROUS_COMMAND = /(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm\s+-[^\n]*r[^\n]*f|mkfs(?:\.\w+)?|reboot|shutdown|poweroff|halt|dd\s+[^\n]*\bof=|chmod\s+-R\s+777|chown\s+-R)|curl[^\n|]*\|\s*(?:ba)?sh|wget[^\n|]*\|\s*(?:ba)?sh|\b(?:DROP|TRUNCATE)\s+(?:DATABASE|TABLE)\b/i;
const SENSITIVE_COMMAND = /(?:^|\s)(?:password|passwd|token|secret|api[_-]?key)\s*=|--password(?:=|\s)|\bmysql\s+[^\n]*-p\S+|\bexport\s+\S*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=/i;

export interface TerminalPasteAnalysis {
  content: string;
  dangerous: boolean;
  lineCount: number;
  requiresConfirmation: boolean;
}

export interface TerminalCommandDraft {
  value: string;
  recordable: boolean;
}

export type TerminalShortcutAction = "find" | "copy" | "clear" | "history";

function visiblePasteContent(data: string) {
  return data
    .split(BRACKETED_PASTE_START).join("")
    .split(BRACKETED_PASTE_END).join("")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/** 在任何内容写入 PTY 之前识别多行或高风险粘贴。 */
export function analyzeTerminalPaste(data: string): TerminalPasteAnalysis {
  const content = visiblePasteContent(data);
  const bracketed = data.includes(BRACKETED_PASTE_START) || data.includes(BRACKETED_PASTE_END);
  const lines = content.split("\n");
  const lineCount = Math.max(1, content.endsWith("\n") ? lines.length - 1 : lines.length);
  const dangerous = data.length > 1 && DANGEROUS_COMMAND.test(content);
  const multiline = /[\r\n]/.test(content);
  return {
    content,
    dangerous,
    lineCount,
    requiresConfirmation: bracketed ? multiline || dangerous : data.length > 1 && (multiline || dangerous),
  };
}

/** 只认可常见 Shell 提示符；无法确认时宁可不记录历史。 */
export function isRecognizedShellPrompt(line: string) {
  return /(?:^|\s)(?:[^\s@]+@[^\s:]+(?::[^\n]*)?|[^\n]+)[#$%]\s*$/.test(line.trimEnd());
}

export function updateCommandDraft(state: TerminalCommandDraft, data: string) {
  if (data.startsWith("\u001b") && !data.startsWith(BRACKETED_PASTE_START)) return { state };
  let value = state.value;
  let submitted: string | undefined;
  for (const character of visiblePasteContent(data)) {
    if (character === "\r" || character === "\n") {
      if (submitted === undefined) submitted = value.trim();
      value = "";
    } else if (character === "\u007f") {
      value = value.slice(0, -1);
    } else if (character === "\u0015" || character === "\u0003") {
      value = "";
    } else if (character >= " " && character !== "\u007f") {
      value += character;
    }
  }
  return { state: { ...state, value }, submitted };
}

export function canStoreTerminalCommand(command: string) {
  const normalized = command.trim();
  return normalized.length > 0 && normalized.length <= 2_000 && !SENSITIVE_COMMAND.test(normalized);
}

export function appendTerminalHistory(history: string[], command: string, maximum = 100) {
  if (!canStoreTerminalCommand(command) || history[history.length - 1] === command.trim()) return history;
  return [...history, command.trim()].slice(-maximum);
}

/** Commands that repaint the primary screen and can erase the visible history. */
export function shouldPreserveViewportBeforeCommand(command: string) {
  const normalized = command.trim();
  if (!/^(?:sudo\s+)?top(?:\s|$)/.test(normalized)) return false;
  return !/(?:^|\s)-(?:[^\s]*b[^\s]*)(?:\s|$)/.test(normalized);
}

export function matchesTerminalShortcut(event: KeyboardEvent, action: TerminalShortcutAction, preset: TerminalShortcutPreset) {
  if (event.type !== "keydown") return false;
  const key = event.key.toLowerCase();
  if (action === "history") return event.ctrlKey && !event.metaKey && key === "r";
  if (preset === "vscode") {
    return event.ctrlKey && event.shiftKey && (
      (action === "find" && key === "f")
      || (action === "copy" && key === "c")
      || (action === "clear" && key === "k")
    );
  }
  const primary = event.metaKey || event.ctrlKey;
  return primary && (
    (action === "find" && !event.shiftKey && key === "f")
    || (action === "copy" && event.shiftKey && key === "c")
    || (action === "clear" && !event.shiftKey && key === "k")
  );
}
