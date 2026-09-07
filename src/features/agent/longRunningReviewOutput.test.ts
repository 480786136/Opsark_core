import { describe, expect, it } from "vitest";
import {
  buildLongRunningOutputWindow,
  compactReviewText,
  mergeLongRunningSalientEvidence,
  initialLongRunningOutputCursor,
  LONG_RUNNING_OUTPUT_CONTEXT_LIMIT,
  semanticLongRunningOutputFingerprint,
} from "@/features/agent/longRunningReviewOutput";

describe("long-running review output", () => {
  it("compresses long lines, repeated progress and terminal control sequences", () => {
    const progress = Array.from({ length: 100 }, (_, index) => (
      `download [${"#".repeat(index % 20)}${"-".repeat(20 - (index % 20))}] ${index}% 2.4 MiB/s ETA 10s`
    )).join("\n");
    const longPayload = `payload=${"A".repeat(20_000)}`;
    const output = `\u001b[32mstarting\u001b[0m\n${progress}\n${longPayload}\nfinished`;

    const { window } = buildLongRunningOutputWindow(output, initialLongRunningOutputCursor());

    expect(window.mode).toBe("initial");
    expect(window.content.length).toBeLessThanOrEqual(LONG_RUNNING_OUTPUT_CONTEXT_LIMIT);
    expect(window.content).not.toContain("\u001b[");
    expect(window.content).toContain("单行 20008 字符");
    expect(window.content).toContain("finished");
    expect(window.omittedCharacters).toBeGreaterThan(10_000);
  });

  it("sends only appended output and resynchronizes after a rolling buffer rewrite", () => {
    const first = buildLongRunningOutputWindow("start\n10%", initialLongRunningOutputCursor());
    const second = buildLongRunningOutputWindow("start\n10%\n20%", first.nextCursor);
    const rolled = buildLongRunningOutputWindow("new buffer\n30%", second.nextCursor);

    expect(second.window).toMatchObject({ mode: "delta", newCharacters: 4 });
    expect(second.window.content).toBe("20%");
    expect(rolled.window.mode).toBe("resync");
    expect(rolled.window.content).toContain("new buffer");
  });

  it("treats an empty first review as initialized for later deltas", () => {
    const first = buildLongRunningOutputWindow("", initialLongRunningOutputCursor());
    const second = buildLongRunningOutputWindow("ready", first.nextCursor);

    expect(first.window.mode).toBe("initial");
    expect(second.window.mode).toBe("delta");
    expect(second.window.content).toBe("ready");
  });

  it("bounds unusually long goals and commands while preserving both ends", () => {
    const text = `begin-${"x".repeat(8_000)}-end`;
    const compacted = compactReviewText(text, 800);

    expect(compacted.length).toBeLessThanOrEqual(800);
    expect(compacted).toMatch(/^begin-/);
    expect(compacted).toMatch(/-end$/);
    expect(compacted).toContain("原始 8010 字符");
    expect(compacted).toContain("指纹");
  });

  it("ignores spinner and timestamp-only changes when measuring semantic progress", () => {
    const first = semanticLongRunningOutputFingerprint("2026-08-23 10:00:00 ⠋ waiting\n");
    const second = semanticLongRunningOutputFingerprint("2026-08-23 10:00:30 ⠙ waiting\n");

    expect(second).toBe(first);
    expect(semanticLongRunningOutputFingerprint("10:01:00 downloaded 20%"))
      .not.toBe(semanticLongRunningOutputFingerprint("10:01:30 downloaded 35%"));
  });

  it("retains critical evidence across delta reviews and counts repeated failures", () => {
    const first = mergeLongRunningSalientEvidence([], "npm ERR! JavaScript heap out of memory\n");
    const second = mergeLongRunningSalientEvidence(
      first,
      "retrying\nConnection refused\nConnection refused\nbuilt in 36.66s",
    );

    expect(second.join("\n")).toContain("heap out of memory");
    expect(second.join("\n")).toContain("Connection refused （重复 2 次）");
    expect(second.join("\n")).toContain("built in 36.66s");
  });

  it("不把依赖名中的 failureaccess 子串当成失败信号", () => {
    expect(mergeLongRunningSalientEvidence([], "resolved artifact failureaccess-1.0.1.jar"))
      .toEqual([]);

    const evidence = mergeLongRunningSalientEvidence([], [
      "ERROR first real failure",
      "ERROR second real failure",
      "ERROR third real failure",
      "ERROR fourth real failure",
      "ERROR fifth real failure",
      "Downloading failureaccess-1.0.1.jar",
    ].join("\n"));
    expect(evidence.join("\n")).toContain("first real failure");
    expect(mergeLongRunningSalientEvidence([], "java.lang.NoSuchFieldError: JCTree.qualid"))
      .toEqual(["java.lang.NoSuchFieldError: JCTree.qualid"]);
  });
});
