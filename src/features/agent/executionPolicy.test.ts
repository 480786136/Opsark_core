import { describe, expect, it } from "vitest";
import { freezeCommandExecutionPolicy, isReadOnlyScan } from "./executionPolicy";
import type { PlanStep } from "@/types";

const step = (command: string, overrides: Partial<PlanStep> = {}): PlanStep => ({
  id: "scan", title: "扫描", description: "扫描", command, kind: "observe",
  risk: "low", expected: "目录占用", validation: "true", status: "running", ...overrides,
});

describe("controller-owned command execution policy", () => {
  it.each([
    "du -x -h -d 1 / 2>/dev/null | sort -h",
    "find / -xdev -type f -size +100M -printf '%s %p\\n' 2>/dev/null | sort -rn | head -n 50",
    "timeout 120 du -x -d 1 / 2>/dev/null | sort -n",
    "'/usr/bin/du' -s '/var/log with spaces' | sort -n",
    "set -o pipefail; du / | sort -n",
    "set -eo pipefail; find / -type f -size +100M | head -n 50",
    "set -o pipefail\nfind / -type f | sort\n",
    "set -eo pipefail\n du / 2>/dev/null | sort -h",
  ])("assigns a finite scan budget to an explicit read pipeline: %s", command => {
    expect(isReadOnlyScan(step(command))).toBe(true);
    expect(freezeCommandExecutionPolicy(step(command), "exec", 5_000)).toMatchObject({
      kind: "scan", startedAt: 5_000, deadlineAt: 605_000,
    });
  });

  it.each([
    "echo 'find / -size +100M'", "printf '%s' 'du /'", "echo find /",
    "du /; touch /tmp/result", "du / && rm /tmp/result", "find / -delete",
    "find / -exec rm {} \\;", "find / -fprintf /tmp/results '%p'",
    "find / | sort -o /tmp/results", "find / | sort --output=/tmp/results",
    "find / | sort --compress-program=touch",
    "find / | sort --out=/tmp/results", "find / | sort --compress-prog=touch",
    "du / > /tmp/results", "du $(touch /tmp/result)", 'du "$(touch /tmp/result)"',
    "find / | sh", "du / | sort; echo done",
    "set -o pipefail; du /; touch /tmp/result", "set -x; find /",
  ])("does not enlarge the budget for printed or mixed Shell actions: %s", command => {
    expect(isReadOnlyScan(step(command))).toBe(false);
    expect(freezeCommandExecutionPolicy(step(command), "exec", 0).kind).toBe("bounded");
  });

  it("requires an observe step and retains progressive/service defaults", () => {
    expect(isReadOnlyScan(step("du /", { kind: "change" }))).toBe(false);
    expect(isReadOnlyScan(step("du /", { kind: undefined }))).toBe(false);
    expect(freezeCommandExecutionPolicy(step("npm run build"), "exec", 0)).toMatchObject({ kind: "progressive", deadlineAt: undefined });
    expect(freezeCommandExecutionPolicy(step("du /", { runtimeClass: "persistent_service" }), "exec", 0))
      .toMatchObject({ kind: "persistent_service", deadlineAt: undefined });
  });

  it("freezes an execution's deadline through serialization and reattachment", () => {
    const original = freezeCommandExecutionPolicy(step("du /"), "exec", 0);
    const restored = JSON.parse(JSON.stringify(original));
    expect(freezeCommandExecutionPolicy(step("du /"), "exec", 590_000, restored, 900_000)).toEqual(original);
    expect(freezeCommandExecutionPolicy(step("du /"), "new-exec", 590_000, restored).deadlineAt).toBe(1_190_000);
  });

  it("honors shorter caller limits but cannot enlarge a finite scan limit", () => {
    expect(freezeCommandExecutionPolicy(step("du /"), "exec", 0, undefined, 120_000).deadlineAt).toBe(120_000);
    expect(freezeCommandExecutionPolicy(step("du /"), "exec", 0, undefined, 900_000).deadlineAt).toBe(600_000);
    expect(freezeCommandExecutionPolicy(step("npm run build"), "exec", 0, undefined, 900_000).deadlineAt).toBe(900_000);
  });
});
