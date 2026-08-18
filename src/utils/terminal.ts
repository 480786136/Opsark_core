const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ESC_SEQUENCE = /\u001b(?:[()][0-2A-Z]|[@-_])/g;

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
