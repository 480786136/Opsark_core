import { buildToolContext } from "@/features/tools/toolContext";
import type { ToolDefinition } from "@/features/tools/types";
import type {
  Metrics,
  OpsTask,
  PermissionLevel,
  PlanStep,
  SecretMetadata,
  ServerProfile,
} from "@/types";

export function trimEvidence(value: string | undefined, limit = 3200) {
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit)}\n…（输出已截断）` : value;
}

export function extractKnownExecutionFacts(task: OpsTask) {
  const steps = [
    ...(task.planHistory ?? []).flatMap((round) => round.plan),
    ...task.plan,
  ].filter((step) => step.status === "completed");
  const repositoryUrls = new Set<string>();
  const workingDirectories = new Set<string>();

  for (const step of steps) {
    const text = `${step.command}\n${step.output ?? ""}`;
    for (const match of text.matchAll(/https?:\/\/[^\s'"<>]+?\.git\b/gi)) repositoryUrls.add(match[0]);
    for (const match of step.command.matchAll(/\bgit\s+clone\b[^;&\n]*?\s+(\/[^\s;&'"\n]+)/gi)) {
      workingDirectories.add(match[1].replace(/[),]+$/, ""));
    }
    for (const match of step.command.matchAll(/(?:^|[;&]\s*)cd\s+(?:'([^']+)'|"([^"]+)"|(\/[^\s;&]+))/gi)) {
      const directory = match[1] ?? match[2] ?? match[3];
      if (directory?.startsWith("/")) workingDirectories.add(directory.replace(/[),]+$/, ""));
    }
    for (const match of text.matchAll(/\/(?:tmp|opt|home|srv|var\/www)\/[A-Za-z0-9._@%+~/-]+/g)) {
      workingDirectories.add(match[0].replace(/[),.]+$/, ""));
    }
  }

  return {
    repositoryUrls: [...repositoryUrls].slice(0, 8),
    workingDirectories: [...workingDirectories].slice(0, 16),
    completedSteps: steps.slice(-12).map((step) => ({
      title: step.title,
      command: step.command,
      result: step.result,
    })),
    instruction: "这些路径和仓库来自同一任务的已完成执行证据。后续需求必须优先复用，不得在无新证据时改猜其他目录。",
  };
}

function serverSnapshot(server?: ServerProfile) {
  return server ? {
    name: server.name,
    host: server.host,
    info: server.info,
    environment: server.environment,
  } : undefined;
}

function secretVariableContext(secretMetadata: SecretMetadata[], serverId: string) {
  return secretMetadata
    .filter((item) => item.serverId === serverId)
    .map(({ key, description }) => ({ key, description, placeholder: `\${secret.${key}}` }));
}

export interface AgentContextInput {
  server?: ServerProfile;
  metrics: Metrics;
  permission: PermissionLevel;
  terminalReference?: string;
  terminalContext?: {
    source: "automatic" | "selection";
    totalLines: number;
    includedLines: number;
    hasMore: boolean;
    content?: string;
  };
  conversationHistory: unknown[];
  previousExecution?: unknown;
  knownExecutionFacts: unknown;
  tools: ToolDefinition[];
  secretMetadata: SecretMetadata[];
  serverId: string;
}

export function buildAgentContext(input: AgentContextInput) {
  return {
    server: serverSnapshot(input.server),
    metrics: input.metrics,
    permission: input.permission,
    terminalReference: input.terminalReference || undefined,
    terminalContext: input.terminalContext,
    conversationHistory: input.conversationHistory,
    previousExecution: input.previousExecution,
    knownExecutionFacts: input.knownExecutionFacts,
    tools: buildToolContext(input.tools),
    secretVariables: secretVariableContext(input.secretMetadata, input.serverId),
  };
}

interface WorkflowContextInput {
  server?: ServerProfile;
  metrics: Metrics;
  task: OpsTask;
  tools: ToolDefinition[];
  secretMetadata: SecretMetadata[];
}

export function buildAdjustmentContext(input: WorkflowContextInput, failedStep?: PlanStep) {
  return {
    workflowPhase: "adjust_after_failure",
    server: serverSnapshot(input.server),
    metrics: input.metrics,
    permission: input.task.permission,
    executionConstraints: input.task.executionConstraints,
    knownExecutionFacts: extractKnownExecutionFacts(input.task),
    tools: buildToolContext(input.tools),
    previousPlan: input.task.plan,
    failedStep,
    instruction: "仅根据已有证据和未完成目标生成最少必要的替代步骤。先确定上一步是执行失败、观察到有效异常，还是主命令与后置校验冲突。目标已被真实证据证明时不得再变更；未达成时必须更换有实质区别的方法，不得对已失败命令仅做表面改写后重复执行。发现步骤只验证证据可获得；可选信息缺失或目标不存在是有效观察。每步是独立非交互 Shell，必须在当步建立所需目录和环境。不得预设技术栈、工具、路径、端口或服务名，不得重复已完成步骤，并以对用户目标的独立验收结束。",
    secretVariables: secretVariableContext(input.secretMetadata, input.task.serverId),
  };
}

export function buildContinuationContext(input: WorkflowContextInput) {
  return {
    workflowPhase: "continue_after_discovery",
    server: serverSnapshot(input.server),
    permission: input.task.permission,
    executionConstraints: input.task.executionConstraints,
    completedDiscovery: input.task.plan.map(({ title, description, command, expected, result, evidence, output }) => ({
      title,
      description,
      command,
      expected,
      result,
      evidence: evidence?.map(({ type, source, facts, rawOutput }) => ({
        type,
        source,
        facts,
        rawOutput: trimEvidence(rawOutput),
      })),
      output: trimEvidence(output),
    })),
    knownExecutionFacts: extractKnownExecutionFacts(input.task),
    tools: buildToolContext(input.tools),
    instruction: "只使用本轮已完成发现的真实证据，生成完成用户剩余目标所需的最少变更和最终验收。不得重复发现步骤或猜测路径、工具、端口和服务名。",
    secretVariables: secretVariableContext(input.secretMetadata, input.task.serverId),
  };
}
