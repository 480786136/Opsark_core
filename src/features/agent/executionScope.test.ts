import { describe, expect, it } from "vitest";
import type { PlanStep } from "@/types";
import {
  buildStepScopeEvidence,
  defaultAgentSessionContext,
  normalizePlanStepExecutionScope,
  mergeAgentSessionContext,
  validatePlanStepExecutionScope,
} from "./executionScope";

const step = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  id: "step-1",
  kind: "change",
  title: "change",
  description: "change state",
  command: "touch /tmp/value",
  expected: "value exists",
  validation: "test -f /tmp/value",
  risk: "low",
  status: "pending",
  ...overrides,
});

describe("execution scope contract", () => {
  it("migrates legacy steps to isolated command and validation scopes", () => {
    expect(normalizePlanStepExecutionScope(step())).toMatchObject({
      executionScope: "isolated_exec",
      validationScope: "isolated_exec",
      runtimeClass: "bounded",
    });
  });

  it("does not persist secret-shaped environment variables in Agent context", () => {
    expect(() => validatePlanStepExecutionScope(step({
      executionScope: "agent_session",
      sessionContextChange: { environment: { API_TOKEN: "value" } },
    }))).toThrow("不允许持久化");
  });

  it("rejects secret placeholders in values and relative source files", () => {
    expect(() => validatePlanStepExecutionScope(step({
      executionScope: "agent_session",
      sessionContextChange: { environment: { ENDPOINT: "${secret.API_TOKEN}" } },
    }))).toThrow("环境变量值不安全");
    expect(() => validatePlanStepExecutionScope(step({
      executionScope: "agent_session",
      sessionContextChange: { sourceFiles: [".nvm/nvm.sh"] },
    }))).toThrow("sourceFiles");
  });

  it("records the limits of agent-session evidence", () => {
    const evidence = buildStepScopeEvidence(step({ executionScope: "agent_session" }), "main", {
      targetId: "server-1",
      sessionId: "agent-1",
      generation: 2,
      cwd: "/opt/app",
    });
    expect(evidence).toMatchObject({
      targetId: "server-1",
      sessionId: "agent-1",
      generation: 2,
      scope: "agent_session",
      persistence: "agent_task",
    });
    expect(evidence.doesNotProve).toContain("user_shell_loaded");
  });

  it("requires a genuinely fresh shell and rejects self-proving source validation", () => {
    expect(() => validatePlanStepExecutionScope(step({
      expected: "新交互 Shell 会自动加载 nvm",
      validationScope: "isolated_exec",
    }))).toThrow("fresh_interactive_shell");
    expect(() => validatePlanStepExecutionScope(step({
      expected: "新交互 Shell 会自动加载 nvm",
      validationScope: "fresh_interactive_shell",
      validation: ". /root/.bashrc; type nvm",
    }))).toThrow("不得在 validation 中显式 source");
  });

  it("converts changes to an already-open user shell into user action", () => {
    expect(() => validatePlanStepExecutionScope(step({
      expected: "当前 Shell 会话立即加载 nvm",
    }))).toThrow("user_action");
  });

  it("creates a deterministic empty context", () => {
    expect(defaultAgentSessionContext()).toEqual({ environment: {}, sourceFiles: [], shell: "bash", revision: 0 });
  });

  it("merges replayable context without carrying arbitrary shell memory", () => {
    const merged = mergeAgentSessionContext(defaultAgentSessionContext(), {
      cwd: "/opt/app",
      environment: { NODE_ENV: "production" },
      sourceFiles: ["/root/.nvm/nvm.sh", "/root/.nvm/nvm.sh"],
    });
    expect(merged).toMatchObject({ cwd: "/opt/app", environment: { NODE_ENV: "production" } });
    expect(merged.sourceFiles).toEqual(["/root/.nvm/nvm.sh"]);
  });
});
