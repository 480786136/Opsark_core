import type { CommandExecutionPolicy, PlanStep } from "@/types";

export const BOUNDED_COMMAND_HARD_LIMIT_SECONDS = 90;
export const SCAN_COMMAND_HARD_LIMIT_SECONDS = 600;
export type LongRunningWorkload = "bounded" | "progressive" | "persistent_service";

const PROGRESSIVE_COMMAND_PATTERNS = [
  /\b(?:curl|wget)\b/,
  /\bgit\s+(?:clone|fetch|pull|submodule\s+update)\b/,
  /\b(?:scp|rsync)\b/,
  /\b(?:dnf|yum|apt|apt-get|zypper|pacman)\s+(?:install|update|upgrade|download)\b/,
  /\b(?:npm|pnpm|yarn|composer)\s+(?:ci|install|update)\b/,
  /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|compile|bundle|test)\b/,
  /\b(?:pip|pip3)\s+(?:install|download|wheel)\b/,
  /\b(?:mvn|mvnw)\b[^\n;]*(?:package|install|deploy)/,
  /\b(?:gradle|gradlew)\b[^\n;]*(?:build|assemble|publish)/,
  /\bcargo\s+(?:build|install|fetch|update)\b/,
  /\brustup\s+(?:install|update|toolchain\s+install)\b/,
  /\bgo\s+(?:build|install|get)\b/,
  /(?:^|[;&|]\s*)make(?:\s|$)/,
  /\bdocker\s+(?:build|pull|push)\b/,
  /\bdocker\s+compose\b[^\n;]*(?:build|pull|up)\b/,
  /\b(?:tar|unzip|7z)\b/,
];

export function classifyLongRunningWorkload(step: Pick<PlanStep, "title" | "description" | "command" | "runtimeClass">): LongRunningWorkload {
  if (step.runtimeClass === "persistent_service") return "persistent_service";
  if (step.runtimeClass === "progressive") return "progressive";
  return PROGRESSIVE_COMMAND_PATTERNS.some(pattern => pattern.test(step.command.toLocaleLowerCase()))
    ? "progressive" : "bounded";
}

/** A deliberately small literal pipeline recognizer, not a Shell safety checker.
 * Unsupported syntax keeps the existing budget; printed command names never
 * extend it. The validated read-only intent remains a separate requirement.
 */
function literalPipeline(command: string): string[][] | undefined {
  command = command.trim();
  // Fixed shell options preserve the scan's real pipeline status without
  // introducing another action. Other setup/control statements stay bounded.
  command = command.replace(/^set -(?:o|eo) pipefail(?:[ \t]*;[ \t]*|[ \t]*\r?\n)[ \t\r\n]*/, "");
  const stages: string[][] = [[]];
  let word = "";
  let inWord = false;
  const flush = () => { if (inWord) stages[stages.length - 1].push(word); word = ""; inWord = false; };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === "'" || char === '"') {
      const quote = char;
      let closed = false;
      inWord = true;
      while (++i < command.length) {
        if (command[i] === quote) { closed = true; break; }
        if (quote === '"' && /[$`]/.test(command[i])) return undefined;
        if (command[i] === "\\" && quote === '"') word += command[++i] ?? "";
        else word += command[i];
      }
      if (!closed) return undefined;
    } else if (char === "\\") {
      if (command[i + 1] === "\n") { i += 1; continue; }
      word += command[++i] ?? ""; inWord = true;
    } else if (char === "#" && !inWord) {
      while (i < command.length && command[i] !== "\n") i += 1;
      flush();
      if (i < command.length) return undefined;
    } else if (char === ">") {
      // Only discard stderr; any output file or other redirection is outside
      // this narrow read-only scan policy.
      if (word !== "2" || !/^>\s*\/dev\/null(?=\s|\||$)/.test(command.slice(i))) return undefined;
      const match = command.slice(i).match(/^>\s*\/dev\/null/)!;
      word = ""; inWord = false; i += match[0].length - 1;
    } else if (char === "|") {
      flush();
      if (!stages[stages.length - 1].length || command[i + 1] === "|") return undefined;
      stages.push([]);
    } else if (/[;$`<&(){}\n]/.test(char)) return undefined;
    else if (/\s/.test(char)) flush();
    else { word += char; inWord = true; }
  }
  flush();
  return stages.every(stage => stage.length) ? stages : undefined;
}

export function isReadOnlyScan(step: PlanStep): boolean {
  if (step.kind !== "observe" || (step.executionIntent && step.executionIntent.semantic.effect !== "read")) return false;
  if (step.action && step.action.type !== "shell") return false;
  const stages = literalPipeline(step.command);
  if (!stages) return false;
  let hasScan = false;
  return stages.every((original, index) => {
    const words = [...original];
    if (words[0]?.split("/").pop() === "timeout") {
      words.shift();
      if (!/^\d+(?:\.\d+)?[smhd]?$/.test(words.shift() ?? "")) return false;
    }
    const executable = words.shift()?.split("/").pop();
    if (executable === "find") {
      if (index !== 0 || words.some(word => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(word))) return false;
      hasScan = true; return true;
    }
    if (executable === "du") { if (index !== 0) return false; hasScan = true; return true; }
    if (index === 0 || !["sort", "head", "tail", "wc"].includes(executable ?? "")) return false;
    // GNU long-option abbreviations must not hide output files or subprocesses.
    return executable !== "sort" || !words.some(word => /^--[oc]|^-[^-]*o/.test(word));
  }) && hasScan;
}

/** Core-owned attempt policy. Reattaching to the same execution never restarts its clock. */
export function freezeCommandExecutionPolicy(
  step: PlanStep, executionId: string, startedAt: number,
  previous?: CommandExecutionPolicy, callerDeadlineAt?: number,
): CommandExecutionPolicy {
  if (previous?.version === 1 && previous.executionId === executionId) return { ...previous };
  const workload = classifyLongRunningWorkload(step);
  const kind = workload !== "persistent_service" && isReadOnlyScan(step) ? "scan" : workload;
  const budget = kind === "scan" ? SCAN_COMMAND_HARD_LIMIT_SECONDS
    : kind === "bounded" ? BOUNDED_COMMAND_HARD_LIMIT_SECONDS : undefined;
  const configuredDeadline = Number.isFinite(callerDeadlineAt) ? callerDeadlineAt : undefined;
  const defaultDeadline = budget === undefined ? undefined : startedAt + budget * 1000;
  return { version: 1, executionId, kind, startedAt,
    deadlineAt: configuredDeadline === undefined ? defaultDeadline
      : Math.min(configuredDeadline, defaultDeadline ?? Infinity) };
}
