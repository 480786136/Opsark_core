const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ESC_SEQUENCE = /\u001b(?:[()][0-2A-Z]|[@-_])/g;
const DEFAULT_STREAM_OUTPUT_LIMIT = 200_000;

export interface TerminalOutputAccumulator {
  output: string;
  pendingControl: string;
}

function applyBackspaces(value: string) {
  let result = "";
  for (const character of value) {
    if (character === "\b") result = result.slice(0, -1);
    else result += character;
  }
  return result;
}

export function sanitizeTerminalOutput(value: string) {
  const cleaned = applyBackspaces(
    value
      .replace(OSC_SEQUENCE, "")
      .replace(CSI_SEQUENCE, "")
      .replace(ESC_SEQUENCE, "")
      .replace(/\u0007/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n"),
  ).replace(/(?:^|\n)\s*1337;(?:PreExecMarker;[^\n]*|PostExecMarker;Exit=\d+;)\s*/g, "\n");
  const lines = cleaned.split("\n");
  const compacted: string[] = [];
  let pendingProgress: string | undefined;
  for (const line of lines) {
    const progress = /^\s*[#=*>.\-]*\s*\d{1,3}(?:\.\d+)?%\s*$/.test(line);
    if (progress) {
      pendingProgress = line;
      continue;
    }
    if (pendingProgress !== undefined) {
      compacted.push(pendingProgress);
      pendingProgress = undefined;
    }
    compacted.push(line);
  }
  if (pendingProgress !== undefined) compacted.push(pendingProgress);
  return compacted.join("\n");
}

function stripTerminalControlChunk(pendingControl: string, chunk: string) {
  const value = `${pendingControl}${chunk}`;
  let output = "";
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (character === "\u0007") {
      index += 1;
      continue;
    }
    if (character !== "\u001b") {
      output += character;
      index += 1;
      continue;
    }
    if (index + 1 >= value.length) return { output, pendingControl: value.slice(index) };
    const kind = value[index + 1];
    if (kind === "[") {
      let end = index + 2;
      while (end < value.length) {
        const code = value.charCodeAt(end);
        if (code >= 0x40 && code <= 0x7e) break;
        end += 1;
      }
      if (end >= value.length) return { output, pendingControl: value.slice(index) };
      index = end + 1;
      continue;
    }
    if (kind === "]") {
      let end = index + 2;
      let terminated = false;
      while (end < value.length) {
        if (value[end] === "\u0007") {
          end += 1;
          terminated = true;
          break;
        }
        if (value[end] === "\u001b" && value[end + 1] === "\\") {
          end += 2;
          terminated = true;
          break;
        }
        end += 1;
      }
      if (!terminated) {
        return { output, pendingControl: value.slice(index) };
      }
      index = end;
      continue;
    }
    if ((kind === "(" || kind === ")") && index + 2 >= value.length) {
      return { output, pendingControl: value.slice(index) };
    }
    index += kind === "(" || kind === ")" ? 3 : 2;
  }
  return { output, pendingControl: "" };
}

export function createTerminalOutputAccumulator(output = ""): TerminalOutputAccumulator {
  return { output, pendingControl: "" };
}

/**
 * Stateful PTY text accumulator. Escape sequences split across transport chunks
 * remain pending instead of leaking fragments such as `1G` or `36m` into evidence.
 */
export function appendTerminalOutputChunk(
  state: TerminalOutputAccumulator,
  chunk: string,
  limit = DEFAULT_STREAM_OUTPUT_LIMIT,
): TerminalOutputAccumulator {
  const stripped = stripTerminalControlChunk(state.pendingControl, chunk);
  const cleaned = stripped.output;
  let output = state.output;
  for (let index = 0; index < cleaned.length; index += 1) {
    const character = cleaned[index];
    if (character === "\b") {
      output = output.slice(0, -1);
    } else if (character === "\r") {
      if (cleaned[index + 1] === "\n") {
        output += "\n";
        index += 1;
      } else {
        output = output.slice(0, output.lastIndexOf("\n") + 1);
      }
    } else {
      output += character;
    }
  }
  if (output.length > limit) {
    const overflow = output.length - limit;
    const nextLine = output.indexOf("\n", overflow);
    output = output.slice(nextLine >= 0 ? nextLine + 1 : overflow);
  }
  return { output, pendingControl: stripped.pendingControl };
}

/**
 * 增量保存长任务输出。PTY 中的单独 CR 表示回到当前行首，下载器通常用它
 * 原地更新进度；若直接改成换行，会让十几分钟的下载膨胀成大量重复文本。
 */
export function appendTerminalOutput(
  current: string,
  chunk: string,
  limit = DEFAULT_STREAM_OUTPUT_LIMIT,
) {
  return appendTerminalOutputChunk(createTerminalOutputAccumulator(current), chunk, limit).output;
}
