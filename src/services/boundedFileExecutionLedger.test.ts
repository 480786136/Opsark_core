import { describe, expect, it } from "vitest";
import type { ExecutionIntentSemantic, ExecutionIntentSnapshot } from "@/types";
import { configureExecutionLedger, createMemoryExecutionLedgerRepository, listExecutionLedger, resolveExecutionOperation, runRecordedExecution } from "./executionLedger";
import { executionDigest } from "@/features/agent/planPreparation";
import { boundedFileAppendContract, boundedFileAppendProbe } from "@/features/agent/boundedFileReconciliation";
import { projectExecutionLedgerRecovery } from "@/features/agent/executionLedgerRecovery";

const command = "set -eu\nf='/tmp/record'\nb='/tmp/backup'\nprintf '%s\\n' 'old' | cmp - \"$f\"\ntest ! -e \"$b\"\ncp -p -- \"$f\" \"$b\"\nprintf '%s\\n' 'new' >> \"$f\"";
function intent(overrides: Partial<ExecutionIntentSemantic> = {}): ExecutionIntentSnapshot {
  const semantic: ExecutionIntentSemantic = { taskId: "task", stepId: "append", action: { type: "shell", command },
    targets: [{ role: "execution", serverId: "server", host: "host.test", port: 22, username: "deploy" }], kind: "change", effect: "change",
    risk: "medium", expected: "one append and original backup", permission: "safe", policyVersion: "core-execution-policy@1",
    executionScope: "isolated_exec", runtimeClass: "bounded", dependencies: { precedingStepIds: [] }, ...overrides };
  return { version: "execution-intent@1", algorithm: "sha256", semantic, digest: executionDigest({ version: "execution-intent@1", semantic }) };
}
describe("bounded file ledger admission and recovery", () => {
  it("keeps a single failed transport attempt, resolves through native-shaped read proof and never repeats the write", async () => {
    const owner = {}, repository = createMemoryExecutionLedgerRepository();
    configureExecutionLedger(owner, repository, async (_task, evidence) => executionDigest(evidence));
    let writeCount = 0;
    const original = intent();
    await expect(runRecordedExecution({ owner, task: { id: "task" }, step: { id: "append", executionIntent: original },
      phase: "command", executionId: "exec-original", execute: async () => { writeCount++; throw new Error("transport lost after write"); } })).rejects.toThrow();
    const operation = (await listExecutionLedger(owner))[0];
    expect(operation.state).toBe("unknown");
    const contract = boundedFileAppendContract(original.semantic)!;
    const read = intent({ stepId: "probe", kind: "observe", effect: "read", runtimeClass: undefined,
      action: { type: "shell", command: boundedFileAppendProbe(contract, "exec-original") } });
    const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const stdout = ["OPSARK_BOUNDED_FILE_V1", "exec-original", contract.commandSha256, boot, "812", "731", "0", "CURRENT_BOOT", boot,
      "PROCESS_GROUPS", "1", "900", "FILE_DIGESTS", `${contract.afterSha256}  /tmp/record`, `${contract.beforeSha256}  /tmp/backup`,
      `${contract.afterSha256}  /tmp/record`, `${contract.beforeSha256}  /tmp/backup`, "END"].join("\n");
    await runRecordedExecution({ owner, task: { id: "task" }, step: { id: "probe", executionIntent: read }, phase: "validation",
      executionId: "exec-probe", execute: async () => ({ exitCode: 0, output: "$ wrapped command\n[exit: 0]", stdout, stdoutTruncated: false }) });
    const reads = await listExecutionLedger(owner);
    const resolved = await resolveExecutionOperation(owner, operation.operationId, operation.attempts[0].id,
      { version: 1, kind: "bounded_file_append", readOperationId: reads[1].operationId });
    expect(resolved.state).toBe("unknown");
    expect(resolved.attempts).toHaveLength(1);
    expect(resolved.reconciliation?.status).toBe("completed");
    expect(projectExecutionLedgerRecovery(await listExecutionLedger(owner)).items).toHaveLength(0);
    await expect(runRecordedExecution({ owner, task: { id: "task" }, step: { id: "append", executionIntent: original },
      phase: "command", executionId: "exec-repeat", execute: async () => { writeCount++; return {}; } })).rejects.toThrow();
    expect(writeCount).toBe(1);
  });
});
