import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("task model log analysis", () => {
  it("reads rotated task files once, filters task IDs and accounts for cache creation", () => {
    const root = mkdtempSync(join(tmpdir(), "opsark-log-analysis-"));
    try {
      const folder = join(root, "tasks", "task-one");
      mkdirSync(folder, { recursive: true });
      const request = { event: "request_sent", taskId: "one", callId: "call", timestampMs: Date.parse("2026-09-06T00:00:00Z"),
        requestName: "结果复核", request: { messages: [
          { role: "user", content: '规划策略：\n{"tools":[{"id":"read"}]}' },
          { role: "user", content: '执行复核上下文：\n{"reviewRound":1}' },
        ] } };
      const response = { event: "response_received", callId: "call", status: 200,
        response: { usage: { prompt_tokens: 2000, completion_tokens: 20, total_tokens: 2020,
          prompt_tokens_details: { cached_tokens: 1024, cache_creation_input_tokens: 512 } } } };
      writeFileSync(join(folder, "model-calls.jsonl"), JSON.stringify(request) + "\n");
      writeFileSync(join(folder, "model-calls-1.jsonl"), JSON.stringify(response) + "\n");
      writeFileSync(join(root, "index.jsonl"), JSON.stringify(request) + "\n");
      const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/analyze-model-calls.mjs"), root, "2026-09-06", "one"], { encoding: "utf8" }));
      for (const [key, value] of Object.entries({ requests: 1, totalTokens: 2020, cachedInputTokens: 1024, cacheCreationInputTokens: 512 })) assert.equal(result.totals[key], value);
      assert.equal(result.reviewTypes.longRunning, 1);
      assert.ok(Object.hasOwn(result.largest[0].contextFields, "tools"));
    } finally { rmSync(root, { recursive: true }); }
  });
});
