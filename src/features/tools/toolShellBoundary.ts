export const EMBEDDED_TOOL_ERROR = "TOOL_IN_SHELL：opsark-tool 不是远端 Shell 命令；请将工具调用拆为独立计划步骤，不能嵌入 Shell、管道、条件分支或 validation";

/** Detect literal protocol invocations, not mentions in comments or printed strings.
 * This is an interface boundary check, not a general-purpose Shell sandbox.
 */
export function shellInvokesTool(script: string, depth = 0): boolean {
  if (depth > 8) return /opsark-tool/i.test(script);
  const tokens: Array<{ text: string; separator?: boolean }> = [];
  let word = "";
  let inWord = false;
  const flush = () => { if (inWord) tokens.push({ text: word }); word = ""; inWord = false; };
  for (let i = 0; i < script.length; i += 1) {
    const char = script[i];
    if (char === "#" && !inWord) {
      while (i < script.length && script[i] !== "\n") i += 1;
      flush(); tokens.push({ text: "\n", separator: true });
    } else if (char === "\\") {
      if (script[i + 1] === "\n") { i += 1; continue; }
      word += script[++i] ?? ""; inWord = true;
    } else if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      let text = "";
      while (++i < script.length && script[i] !== quote) {
        if (script[i] === "\\" && quote !== "'") text += script[i++] ?? "";
        text += script[i] ?? "";
      }
      if (quote === "`" && shellInvokesTool(text, depth + 1)) return true;
      if (quote === '"' && substitutionsInvokeTool(text, depth + 1)) return true;
      word += text; inWord = true;
    } else if (/\s/.test(char) || /[;|&(){}]/.test(char)) {
      flush();
      if (char === "\n" || /[;|&(){}]/.test(char)) tokens.push({ text: char, separator: true });
    } else { word += char; inWord = true; }
  }
  flush();
  let commandPosition = true;
  let shellWrapper = false;
  let shellArgument = false;
  for (const token of tokens) {
    if (token.separator) { commandPosition = true; shellWrapper = false; shellArgument = false; continue; }
    if (shellArgument) {
      if (shellInvokesTool(token.text, depth + 1)) return true;
      shellArgument = false;
    }
    if (shellWrapper && /^-[a-z]*c[a-z]*$/.test(token.text)) { shellArgument = true; continue; }
    if (!commandPosition) continue;
    if (/^(?:if|then|elif|else|do|while|until|!|sudo|env|command|exec|nohup)$/.test(token.text)
      || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text) || token.text.startsWith("-")) continue;
    const executable = token.text.split("/").pop()?.toLowerCase();
    if (executable === "opsark-tool") return true;
    shellWrapper = /^(?:ba|da|z|k)?sh$/.test(executable ?? "") || executable === "eval";
    shellArgument = executable === "eval";
    commandPosition = false;
  }
  return false;
}

function substitutionsInvokeTool(text: string, depth: number): boolean {
  return [...text.matchAll(/(?<!\\)\$\(([\s\S]*?)(?:\)|$)|(?<!\\)`([^`]*?)`/g)]
    .some(match => shellInvokesTool(match[1] ?? match[2], depth));
}

export function assertShellToolBoundary(command: string, validation = "") {
  if ((!/^\s*opsark-tool(?:\s|$)/i.test(command) && shellInvokesTool(command))
    || shellInvokesTool(validation)) throw new Error(EMBEDDED_TOOL_ERROR);
}
