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

  it.each([
    "在当前终端前台执行克隆，将仓库获取到 /opt/report。",
    "以及当前会话对 /opt 是否可写（opt-write-test: yes/no）",
    "Execute git clone in the current terminal.",
  ])("does not confuse executor context with user PTY ownership: %s", (description) => {
    expect(validatePlanStepExecutionScope(step({
      description,
      command: "git clone -- https://gitee.com/belief-team/report.git /opt/report",
      validation: "git -C /opt/report rev-parse --verify HEAD",
    })).executionScope).toBe("isolated_exec");
  });

  it.each([
    ["只读获取当前负载、运行时长与登录会话概况，作为运行状态基线。", "uptime && who"],
    ["只读查看当前登录会话、最近登录记录与关键目录权限提示，评估访问安全性。", "who; w; last -n 5; uptime; date"],
    ["Read the current shell environment and list existing sessions.", "printenv; who"],
    ["查看当前 Shell 的运行状态、运行时长和执行记录", "ps -p $$; uptime; history"],
    ["查看当前会话的运行状态", "who; w"],
    ["查看当前 Shell 的环境变量设置", "printenv"],
    ["读取当前会话的配置更新记录", "history"],
    ["Read the update history of the current shell", "history"],
    ["返回当前 Shell 加载状态", "command -v nvm"],
    ["检查当前 Shell 是否已加载 nvm", "command -v nvm"],
    ["Check whether the current shell has already loaded nvm", "command -v nvm"],
    ["读取当前 Shell 的环境变量，不修改用户当前 Shell", "printenv"],
  ])("allows read-only shell/session observations: %s", (description, command) => {
    expect(() => validatePlanStepExecutionScope(step({
      kind: "observe",
      title: "读取状态",
      description,
      command,
      expected: "返回当前观察结果",
      validation: "",
    }))).not.toThrow();
  });

  it.each([
    "在用户已打开 Shell 中执行 source /root/.bashrc",
    "修改用户当前 Shell 的环境变量",
    "将命令注入用户 PTY",
    "Reload the existing user shell environment",
    "Send input to the user's terminal",
    "只读检查，然后修改用户当前 Shell",
    "只读检查用户当前 Shell 并修改环境变量",
    "Read the current user shell settings and then modify them",
  ])("does not trust observe labels for live-shell mutations: %s", (description) => {
    expect(() => validatePlanStepExecutionScope(step({
      kind: "observe",
      description,
      command: "source /root/.bashrc",
    }))).toThrow("user_action");
  });

  it.each([
    "tmux send-keys -t user:0 'source /root/.bashrc' Enter",
    "tmux -L session send -t user:0 'id' Enter",
    "screen -S user -X stuff 'id\n'",
    "python -c 'fcntl.ioctl(fd, termios.TIOCSTI, value)'",
    "printf 'source /root/.bashrc\\n' > /dev/pts/2",
    "printf 'id\\n' | tee -a /dev/tty1",
  ])("rejects terminal injection despite an observe label and benign prose: %s", (command) => {
    expect(() => validatePlanStepExecutionScope(step({
      kind: "observe",
      title: "查看状态",
      description: "只读检查会话状态",
      expected: "获得状态",
      command,
      validation: "",
    }))).toThrow("user_action");
  });

  it("also rejects terminal injection in validation", () => {
    expect(() => validatePlanStepExecutionScope(step({
      validation: "tmux send-keys -t user:0 'echo ready' Enter",
    }))).toThrow("user_action");
  });

  it.each([
    "tmux capture-pane -p -t user:0",
    "screen -ls",
    "stat /dev/pts/2",
    "printf '%s' 'tmux send-keys'",
    "printf '%s' 'example; tmux send-keys'",
    "printf '%s' 'example | tee /dev/pts/2'",
    "printf '%s' '> /dev/pts/2'",
    "tmux display-message 'send-keys'",
    "grep TIOCSTI file",
    "grep 'ioctl(fd, TIOCSTI)' file",
  ])("allows observing terminal state without sending input: %s", (command) => {
    expect(() => validatePlanStepExecutionScope(step({
      kind: "observe",
      description: "读取用户当前终端状态",
      command,
    }))).not.toThrow();
  });

  it("permits pending user actions but never automatically runs them", () => {
    const action = step({
      executionScope: "user_action",
      description: "在用户当前 Shell 中执行 source /root/.bashrc",
      command: "source /root/.bashrc",
    });
    expect(() => validatePlanStepExecutionScope(action)).not.toThrow();
    expect(() => validatePlanStepExecutionScope({ ...action, status: "running" }))
      .toThrow("用户操作步骤不得由 Agent 自动执行");
  });

  it.each([
    "更新 Agent 当前 Shell 的环境变量",
    "Update the current agent shell environment",
  ])("keeps explicit Agent-owned context separate from user shells: %s", (description) => {
    expect(() => validatePlanStepExecutionScope(step({
      executionScope: "agent_session",
      description,
      command: "export NODE_ENV=production",
      sessionContextChange: { environment: { NODE_ENV: "production" } },
    }))).not.toThrow();
  });

  it("does not let agent_session authorize a user-shell mutation", () => {
    expect(() => validatePlanStepExecutionScope(step({
      executionScope: "agent_session",
      description: "更新 Agent 当前 Shell 的环境变量，同时修改用户当前 Shell",
      sessionContextChange: { environment: { NODE_ENV: "production" } },
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
