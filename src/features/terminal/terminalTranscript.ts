import { sanitizeTerminalOutput } from "@/utils/terminal";

export interface TerminalTranscriptState {
  lines: string[];
  remainder: string;
}

/**
 * 将 PTY 输出转换为供模型使用的纯文本转录。
 * 终端界面仍应直接写入原始数据，以保留 ANSI 颜色和光标控制。
 */
export function appendTranscriptChunk(
  state: TerminalTranscriptState,
  chunk: string,
  maxLines = 4_000,
): TerminalTranscriptState {
  const normalized = sanitizeTerminalOutput(chunk).replace(/\r\n?/g, "\n");
  const parts = `${state.remainder}${normalized}`.split("\n");
  const remainder = parts.pop() ?? "";
  const lines = [...state.lines, ...parts];

  return {
    lines: lines.length > maxLines ? lines.slice(-maxLines) : lines,
    remainder,
  };
}

export function completeTranscript(state: TerminalTranscriptState): string[] {
  return state.remainder ? [...state.lines, state.remainder] : [...state.lines];
}
