const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ESC_SEQUENCE = /\u001b(?:[()][0-2A-Z]|[@-_])/g;
const DEFAULT_STREAM_OUTPUT_LIMIT = 200_000;

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

/**
 * 增量保存长任务输出。PTY 中的单独 CR 表示回到当前行首，下载器通常用它
 * 原地更新进度；若直接改成换行，会让十几分钟的下载膨胀成大量重复文本。
 */
export function appendTerminalOutput(
  current: string,
  chunk: string,
  limit = DEFAULT_STREAM_OUTPUT_LIMIT,
) {
  const cleaned = applyBackspaces(
    chunk
      .replace(OSC_SEQUENCE, "")
      .replace(CSI_SEQUENCE, "")
      .replace(ESC_SEQUENCE, "")
      .replace(/\u0007/g, ""),
  );
  let output = current;
  for (let index = 0; index < cleaned.length; index += 1) {
    const character = cleaned[index];
    if (character === "\r") {
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
  if (output.length <= limit) return output;
  const overflow = output.length - limit;
  const nextLine = output.indexOf("\n", overflow);
  return output.slice(nextLine >= 0 ? nextLine + 1 : overflow);
}
