const DEFAULT_TERMINAL_LINE_LIMIT = 2000;
const PROGRESS_FRAME = /^\s*[#=*>.\-]*\s*\d{1,3}(?:\.\d+)?%\s*$/;

function trimToLimit(lines: string[], limit: number): void {
  if (lines.length > limit) lines.splice(0, lines.length - limit);
}

export function isTerminalProgressFrame(line: string): boolean {
  return PROGRESS_FRAME.test(line);
}

/** Appends streamed output while replacing the previous percentage-only frame. */
export function appendTerminalStream(
  lines: string[],
  chunk: string,
  limit = DEFAULT_TERMINAL_LINE_LIMIT,
): void {
  chunk.split(/\r?\n/).filter(Boolean).forEach((line) => {
    const lastIndex = lines.length - 1;
    if (
      isTerminalProgressFrame(line)
      && lastIndex >= 0
      && isTerminalProgressFrame(lines[lastIndex])
    ) {
      lines[lastIndex] = line;
    } else {
      lines.push(line);
    }
  });
  trimToLimit(lines, limit);
}

/** Adds final command output without duplicating content already emitted by streaming. */
export function appendCommandCompletion(
  lines: string[],
  output: string,
  hadStreamedOutput: boolean,
  limit = DEFAULT_TERMINAL_LINE_LIMIT,
): void {
  const outputLines = output.split("\n");
  if (!hadStreamedOutput) {
    if (outputLines[0]?.startsWith("$ ")) outputLines.shift();
    lines.push(...outputLines);
  } else {
    const exitLine = [...outputLines].reverse().find((line) => line.startsWith("[exit:"));
    if (exitLine) lines.push(exitLine);
  }
  trimToLimit(lines, limit);
}

/** Appends an explicit command or validation block under the shared line limit. */
export function appendTerminalBlock(
  lines: string[],
  header: string,
  output = "",
  limit = DEFAULT_TERMINAL_LINE_LIMIT,
): void {
  if (header) lines.push(header);
  if (output) lines.push(...output.split(/\r?\n/));
  trimToLimit(lines, limit);
}
