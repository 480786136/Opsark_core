import { describe, expect, it } from "vitest";
import type { PlanStep } from "@/types";
import {
  buildShellStartupTransaction,
  shellStartupPrecedenceDiscoveryCommand,
  validateShellStartupTransaction,
} from "./shellStartupConfig";
import { normalizePlanStepExecutionScope } from "./executionScope";

const transaction: PlanStep = {
  id: "shell-config",
  kind: "change",
  title: "update shell startup",
  description: "atomically update bashrc",
  command: "tmp=$(mktemp); cp ~/.bashrc ~/.bashrc.opsark-backup; printf '%s\\n' line > \"$tmp\"; mv \"$tmp\" ~/.bashrc",
  expected: "新交互 Shell 自动加载配置",
  validation: "type nvm",
  validationScope: "fresh_interactive_shell",
  executionScope: "isolated_exec",
  risk: "medium",
  status: "pending",
};

describe("shell startup configuration transaction", () => {
  it("accepts atomic backup and fresh-shell verification", () => {
    expect(() => validateShellStartupTransaction(transaction)).not.toThrow();
  });

  it("lets normalization infer fresh-shell validation from the startup target", () => {
    const normalized = normalizePlanStepExecutionScope({
      ...transaction,
      validationScope: "isolated_exec",
    });
    expect(normalized.validationScope).toBe("fresh_interactive_shell");
    expect(() => validateShellStartupTransaction(normalized)).not.toThrow();
  });

  it("rejects explicit-source self verification", () => {
    expect(() => validateShellStartupTransaction({ ...transaction, validation: ". ~/.bashrc; type nvm" }))
      .toThrow("不得显式 source");
  });

  it("discovers login startup precedence instead of assuming profile", () => {
    const command = shellStartupPrecedenceDiscoveryCommand();
    expect(command).toContain(".bash_profile");
    expect(command).toContain(".bash_login");
    expect(command).toContain(".profile");
  });

  it("builds executor-owned snapshot and rollback commands", () => {
    const recovery = buildShellStartupTransaction(transaction, "exec-1");
    expect(recovery?.targets).toEqual(["~/.bashrc"]);
    expect(recovery?.snapshotCommand).toContain("OPSARK_STARTUP_SNAPSHOT");
    expect(recovery?.snapshotCommand).toContain("cp -p --");
    expect(recovery?.rollbackCommand).toContain("OPSARK_STARTUP_ROLLBACK");
    expect(recovery?.rollbackCommand).toContain("mv -f --");
  });

  it("tracks multiple explicit startup targets independently", () => {
    const recovery = buildShellStartupTransaction({
      command: "tmp=$(mktemp); printf x > \"$tmp\"; mv \"$tmp\" $HOME/.profile; cp /root/.bashrc /tmp/example",
    }, "exec:2");
    expect(recovery?.targets).toEqual(["$HOME/.profile", "/root/.bashrc"]);
    expect(recovery?.backupPaths).toHaveLength(2);
    expect(recovery?.snapshotCommand).toContain("opsark-agent-exec-2.bak");
  });
});
