import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionIntentSemantic, ExecutionIntentSnapshot } from "@/types";
import { executionDigest } from "@/features/agent/planPreparation";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, listExecutionLedger,
  resetExecutionLedgerForTests, runRecordedExecution, type RecordedExecutionOptions } from "./executionLedger";

function setup() {
  const owner = {}, repository = createMemoryExecutionLedgerRepository();
  configureExecutionLedger(owner, repository, async () => "archived-receipt");
  return { owner, repository };
}
function request(owner: object, stepId: string, authorizationId = "approved-files", taskId = "task"): RecordedExecutionOptions<unknown> {
  const semantic: ExecutionIntentSemantic = { taskId, stepId,
    action: { type: "tool", toolId: "files.delete_confirmed", arguments: { authorizationId } },
    targets: [{ role: "execution", serverId: "server", host: "fixture.invalid", port: 22, username: "fixture" }],
    kind: "change", effect: "change", risk: "high", expected: "仅删除已确认清单", dependencies: { precedingStepIds: [] },
    permission: "managed", policyVersion: "test" };
  const intent: ExecutionIntentSnapshot = { version: "execution-intent@1", algorithm: "sha256", semantic,
    digest: executionDigest({ version: "execution-intent@1", semantic }) };
  return { owner, task: { id: taskId, currentRoundId: "round", workflowEpoch: 1, planRevision: 1 },
    step: { id: stepId, executionIntent: intent, stepRevision: 1 }, phase: "tool", executionId: `physical-${stepId}`,
    execute: vi.fn(async () => ({ success: true, deleted: ["/tmp/confirmed-file"] })) };
}

describe("G04 one committed attempt per task deletion authorization", () => {
  beforeEach(resetExecutionLedgerForTests);

  it.each(["succeeded", "failed", "unknown", "not_dispatched"] as const)(
    "blocks another step and operation after %s without depending on the task authorization snapshot", async status => {
      const { owner } = setup();
      const original = request(owner, "original");
      original.classifyResult = () => status;
      if (status === "unknown") await expect(runRecordedExecution(original)).rejects.toThrow();
      else await runRecordedExecution(original);
      const originalReceipt = (await listExecutionLedger(owner))[0].attempts[0];
      const replay = request(owner, "new-step");
      replay.task.currentRoundId = "new-round";
      replay.task.workflowEpoch = 42;
      await expect(runRecordedExecution(replay)).rejects.toMatchObject({ code: "EXECUTION_LEDGER_DELETION_AUTHORIZATION_CONSUMED", stage: "begin",
        message: expect.stringContaining("尚未发送本次命令") });
      expect(original.execute).toHaveBeenCalledOnce();
      expect(replay.execute).not.toHaveBeenCalled();
      const records = await listExecutionLedger(owner);
      expect(records.find(item => item.stepId === "new-step")?.attempts).toEqual([]);
      expect(records.find(item => item.stepId === "original")?.attempts[0]).toEqual(originalReceipt);
    },
  );

  it("admits only one concurrent operation using the same task authorization", async () => {
    const { owner } = setup();
    const first = request(owner, "a"), second = request(owner, "b");
    const results = await Promise.allSettled([runRecordedExecution(first), runRecordedExecution(second)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(vi.mocked(first.execute).mock.calls.length + vi.mocked(second.execute).mock.calls.length).toBe(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ status: "rejected",
      reason: { code: "EXECUTION_LEDGER_DELETION_AUTHORIZATION_CONSUMED" } });
  });

  it("does not consume an authorization when durable begin is rejected", async () => {
    const { owner, repository } = setup();
    const failed = request(owner, "rejected");
    const begin = vi.spyOn(repository, "begin").mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(runRecordedExecution(failed)).rejects.toMatchObject({ stage: "begin" });
    expect(failed.execute).not.toHaveBeenCalled();
    begin.mockRestore();
    const allowed = request(owner, "accepted");
    await runRecordedExecution(allowed);
    expect(allowed.execute).toHaveBeenCalledOnce();
  });

  it("keeps independent task and fresh confirmation identities independent", async () => {
    const { owner } = setup();
    for (const input of [request(owner, "a"), request(owner, "b", "new-confirmation"), request(owner, "c", "approved-files", "another-task")]) {
      await runRecordedExecution(input);
      expect(input.execute).toHaveBeenCalledOnce();
    }
  });

  it.each(["", "bad approval", "a/b"])("rejects malformed authorization %j before dispatch", async id => {
    const { owner } = setup(), input = request(owner, "invalid", id);
    await expect(runRecordedExecution(input)).rejects.toMatchObject({ code: "EXECUTION_LEDGER_INVALID_DELETION_AUTHORIZATION", stage: "prepare" });
    expect(input.execute).not.toHaveBeenCalled();
  });

  it("cannot bypass single-use policy by labelling deletion as read", async () => {
    const { owner } = setup(), input = request(owner, "mislabelled");
    const intent = input.step.executionIntent!;
    intent.semantic.effect = "read";
    intent.digest = executionDigest({ version: "execution-intent@1", semantic: intent.semantic });
    await expect(runRecordedExecution(input)).rejects.toMatchObject({ code: "EXECUTION_LEDGER_INVALID_DELETION_AUTHORIZATION", stage: "prepare" });
    expect(input.execute).not.toHaveBeenCalled();
  });
});
