import { expect, it, vi } from "vitest";
import type { OpsTask, PlanStep } from "@/types";
import { archiveToolEvidence } from "./evidenceArchive";
import { modelToolOutput, executionContextEvidence } from "./executionContextEvidence";

function fixture() {
  const output = JSON.stringify({ content: "甲".repeat(25000), truncated: true });
  const step = { id: "step", output, attemptContext: "server-session",
    result: { facts: { toolId: "files.read_content", truncated: true } },
    evidence: [{ id: "original", rawOutput: output, collectedAt: "now", facts: {} }],
  } as unknown as PlanStep;
  return { step, task: { id: "task", serverId: "server" } as OpsTask };
}
it("uses a preview only after durable storage and keeps original evidence", async () => {
  const { step, task } = fixture();
  const original = step.output;
  const save = vi.fn().mockResolvedValue("a".repeat(64));
  await archiveToolEvidence(task, step, save, text => text);
  expect(save.mock.calls[0][0]).toBe("task");
  expect(save.mock.calls[0][1]).toMatchObject({ text: original, targetContext: "server-session", capturedPartial: true });
  expect(modelToolOutput(step, step.output, true)).toMatchObject({ archived: true, capturedPartial: true, readTool: "evidence.read" });
  expect(JSON.stringify(modelToolOutput(step, step.output, true)).length).toBeLessThan(3000);
  expect(modelToolOutput(step, step.output, false)).toEqual(JSON.parse(original!));
  expect(step.output).toBe(original);
});
it("retains inline content after storage failure and does not archive recall pages", async () => {
  const { step, task } = fixture();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const save = vi.fn().mockRejectedValue(new Error("disk full"));
  await archiveToolEvidence(task, step, save, text => text);
  expect(step.evidence![0].archive).toBeUndefined();
  expect(modelToolOutput(step, step.output)).toEqual(JSON.parse(step.output!));
  step.result!.facts.toolId = "evidence.read";
  await archiveToolEvidence(task, step, save, text => text);
  expect(save).toHaveBeenCalledTimes(1);
  warning.mockRestore();
});
it("does not equate distinct evidence just because truncated previews match", () => {
  const { step } = fixture();
  step.output = "same header first";
  step.evidence![0].rawOutput = "same header different";
  const result = executionContextEvidence(step, value => value?.slice(0, 11));
  expect(result.evidence![0].rawOutputRef).toBeUndefined();
  expect(result.evidence![0].rawOutput).toBe("same header");
});
