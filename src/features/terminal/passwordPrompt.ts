import { sanitizeTerminalOutput } from "@/utils/terminal";

const PASSWORD_PROMPT_PATTERNS = [
  /^\s*(?:\[sudo\]\s*)?(?:(?:enter|current|new)\s+)?password(?:\s+for\s+.+)?\s*:\s*$/i,
  /^\s*[^\r\n]{1,160}'s\s+password\s*:\s*$/i,
];

const PASSPHRASE_PROMPT_PATTERNS = [
  /^\s*(?:enter\s+)?passphrase\s+for\s+key\s+[^\r\n]+\s*:\s*$/i,
];

const USERNAME_PROMPT_PATTERNS = [
  /^\s*username\s+for\s+['"]?https?:\/\/[^\s'"\r\n]+['"]?\s*:\s*$/i,
];

export type InteractiveCredentialPromptKind = "username" | "password" | "passphrase";

export interface InteractiveCredentialPrompt {
  kind: InteractiveCredentialPromptKind;
  line: string;
  /** Normalized host named by an HTTPS or SSH password prompt. */
  target?: string;
  /** Offset after the prompt's colon, excluding trailing spaces/newlines. */
  end: number;
}

function promptKind(line: string): InteractiveCredentialPromptKind | undefined {
  if (USERNAME_PROMPT_PATTERNS.some((pattern) => pattern.test(line))) return "username";
  if (PASSPHRASE_PROMPT_PATTERNS.some((pattern) => pattern.test(line))) return "passphrase";
  if (PASSWORD_PROMPT_PATTERNS.some((pattern) => pattern.test(line))) return "password";
  return undefined;
}

function normalizePromptTarget(value: string) {
  return value.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLocaleLowerCase();
}

function promptTarget(line: string) {
  const httpsUrl = line.match(/https?:\/\/[^\s'"<>]+/i)?.[0];
  if (httpsUrl) {
    try {
      return normalizePromptTarget(new URL(httpsUrl).hostname);
    } catch {
      return undefined;
    }
  }
  const sshHost = line.match(/^\s*[^@\s'"<>]+@(\[[^\]]+\]|[A-Za-z0-9_.:-]+)'s\s+password\s*:/i)?.[1];
  return sshHost ? normalizePromptTarget(sshHost) : undefined;
}

/**
 * A terminal with echo disabled does not echo the Enter pressed after a Git
 * username. Git can therefore append its password prompt to the same physical
 * line. Split only when every resulting segment is independently a complete
 * credential prompt; ordinary diagnostics containing words such as
 * `using password: NO` remain unmatched.
 */
function promptSegments(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (promptKind(trimmed)) return [trimmed];
  for (let index = 1; index < trimmed.length; index += 1) {
    if (!/\s/.test(trimmed[index - 1]) || /\s/.test(trimmed[index])) continue;
    const left = trimmed.slice(0, index).trimEnd();
    if (!promptKind(left)) continue;
    const right = promptSegments(trimmed.slice(index));
    if (right.length) return [left, ...right];
  }
  return [];
}

/**
 * Extracts complete interactive credential prompts from a rolling PTY buffer.
 * Git writes its prompt without a trailing newline, so the final partial line
 * is deliberately inspected as well. `end` is stable when only CR/LF is later
 * appended, which lets the caller answer each prompt exactly once.
 */
export function findInteractiveCredentialPrompts(value: string): InteractiveCredentialPrompt[] {
  const sanitized = sanitizeTerminalOutput(value);
  const prompts: InteractiveCredentialPrompt[] = [];
  let offset = 0;
  for (const lineWithNewline of sanitized.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!lineWithNewline && offset >= sanitized.length) break;
    const line = lineWithNewline.replace(/[\r\n]+$/, "");
    let searchOffset = 0;
    for (const core of promptSegments(line)) {
      const start = line.indexOf(core, searchOffset);
      if (start < 0) continue;
      const kind = promptKind(core);
      if (kind) {
        prompts.push({ kind, line: core, target: promptTarget(core), end: offset + start + core.length });
      }
      searchOffset = start + core.length;
    }
    offset += lineWithNewline.length;
  }
  return prompts;
}

/** Counts real interactive prompts, excluding diagnostics such as "using password: NO". */
export function countInteractivePasswordPrompts(value: string) {
  return findInteractiveCredentialPrompts(value)
    .filter(({ kind }) => kind === "password")
    .length;
}
