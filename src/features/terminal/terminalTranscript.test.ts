import { describe, expect, it } from "vitest";
import { appendTranscriptChunk, completeTranscript } from "./terminalTranscript";

describe("terminalTranscript", () => {
  it("拼接跨数据块的不完整行并移除 ANSI 序列", () => {
    let state = appendTranscriptChunk({ lines: [], remainder: "" }, "\u001b[32mhel");
    state = appendTranscriptChunk(state, "lo\u001b[0m\r\nworld");

    expect(state).toEqual({ lines: ["hello"], remainder: "world" });
    expect(completeTranscript(state)).toEqual(["hello", "world"]);
  });

  it("只保留最新的指定行数", () => {
    const state = appendTranscriptChunk(
      { lines: ["one", "two"], remainder: "" },
      "three\nfour\n",
      3,
    );

    expect(state.lines).toEqual(["two", "three", "four"]);
  });
});
