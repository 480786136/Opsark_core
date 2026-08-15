import { describe, expect, it } from "vitest";
import {
  analyzeTerminalPaste,
  appendTerminalHistory,
  canStoreTerminalCommand,
  isRecognizedShellPrompt,
  matchesTerminalShortcut,
  updateCommandDraft,
} from "./terminalInput";

describe("terminal input", () => {
  it("拦截多行、高风险和 bracketed paste，但放行普通输入", () => {
    expect(analyzeTerminalPaste("ls").requiresConfirmation).toBe(false);
    expect(analyzeTerminalPaste("echo one\recho two\r")).toMatchObject({ requiresConfirmation: true, lineCount: 2 });
    expect(analyzeTerminalPaste("rm -rf /tmp/demo")).toMatchObject({ requiresConfirmation: true, dangerous: true });
    expect(analyzeTerminalPaste("\u001b[200~pwd\rwhoami\u001b[201~").requiresConfirmation).toBe(true);
  });

  it("只从可识别提示符采集命令，并排除敏感值", () => {
    expect(isRecognizedShellPrompt("root@host:/opt# ")).toBe(true);
    expect(isRecognizedShellPrompt("[sudo] password for root: ")).toBe(false);
    expect(canStoreTerminalCommand("export API_KEY=secret")).toBe(false);
    expect(appendTerminalHistory(["pwd"], "pwd")).toEqual(["pwd"]);
    expect(appendTerminalHistory(["pwd"], "ls -la")).toEqual(["pwd", "ls -la"]);
  });

  it("跟踪退格、提交和快捷键预设", () => {
    const result = updateCommandDraft({ value: "ecoh", recordable: true }, "\u007f ok\r");
    expect(result.submitted).toBe("eco ok");
    expect(matchesTerminalShortcut(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }), "find", "platform")).toBe(true);
    expect(matchesTerminalShortcut(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true }), "find", "vscode")).toBe(true);
  });
});
