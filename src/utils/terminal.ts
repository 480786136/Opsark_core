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
  return applyBackspaces(
    value
      .replace(OSC_SEQUENCE, "")
      .replace(CSI_SEQUENCE, "")
      .replace(ESC_SEQUENCE, "")
      .replace(/\u0007/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n"),
  );
}
