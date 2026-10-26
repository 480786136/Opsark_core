import type { ToolDefinition } from "./types";
import { validateSchemaValue } from "./toolParameterSchema";
import { fullSchemaPattern } from "./toolSchemaPatterns";
import { applicationReleaseHandoverSchema, releasePathIsCanonical, type ApplicationReleaseHandover } from "../agent/applicationReleaseContract";
import type { ReleaseSourceMapping } from "../agent/applicationReleaseSources";

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const text = { type: "string", minLength: 1, maxLength: 4096 };
const id = { type: "string", minLength: 1, maxLength: 256 };
const sha = { type: "string", pattern: fullSchemaPattern("sha256:[a-f0-9]{64}") };
const binding = object({ taskId: id, requirementId: id, requirementRevision: { type: "integer", minimum: 0 }, serverId: id,
  host: text, port: { type: "integer", minimum: 1, maximum: 65535 }, username: text, connectionGeneration: { type: "integer", minimum: 0 } });
export interface PrepareApplicationReleaseRequest { requirementId: string; handoverStepId: string; artifactStepId: string; sourceStepIds: string[]; releasePath: string }
export interface ApplicationReleaseSourceRef { operationId: string; attemptId: string; executionId: string; stepId: string; contentDigest: string; evidenceIds: string[] }
export interface PreparedApplicationReleaseResult {
  request: PrepareApplicationReleaseRequest;
  binding: { taskId: string; requirementId: string; requirementRevision: number; serverId: string; host: string; port: number; username: string; connectionGeneration: number };
  status: "ready" | "unknown";
  contract: ApplicationReleaseHandover | null;
  contractDigest: string | null;
  sourceRefs: ApplicationReleaseSourceRef[];
  mappings: ReleaseSourceMapping[];
  reasons: string[];
  limitations: string[];
}
export const prepareApplicationReleaseInputSchema = object({ requirementId: id, handoverStepId: id, artifactStepId: id,
  sourceStepIds: { type: "array", items: id, maxItems: 32, uniqueItems: true }, releasePath: { ...text, pattern: fullSchemaPattern("/[^\\u0000-\\u001f\\u007f]*") } });
const mapping = object({ role: text, path: text, selector: text,
  // Mappings expose roles and source ranges, not a second editable contract.
  value: { anyOf: [{ type: "string", maxLength: 4096 }, { type: "number" }, { type: "boolean" }, { type: "null" }] } });
export const prepareApplicationReleaseOutputSchema = object({ request: prepareApplicationReleaseInputSchema, binding,
  status: { enum: ["ready", "unknown"] }, contract: { anyOf: [applicationReleaseHandoverSchema, { type: "null" }] },
  contractDigest: { anyOf: [sha, { type: "null" }] }, sourceRefs: { type: "array", maxItems: 34, items: object({ operationId: id, attemptId: id, executionId: id, stepId: id,
    contentDigest: sha, evidenceIds: { type: "array", items: id, minItems: 1, maxItems: 64, uniqueItems: true } }) },
  mappings: { type: "array", items: mapping, maxItems: 128 }, reasons: { type: "array", items: text, maxItems: 64 }, limitations: { type: "array", items: text, maxItems: 32 } });
export function normalizePrepareApplicationReleaseRequest(value: unknown): PrepareApplicationReleaseRequest {
  validateSchemaValue(prepareApplicationReleaseInputSchema, value, "发布准备参数", "");
  const r = JSON.parse(JSON.stringify(value)) as PrepareApplicationReleaseRequest;
  if (!releasePathIsCanonical(r.releasePath)) throw new Error("发布布局需要精确绝对路径");
  return r;
}
export function prepareApplicationReleaseResultIssue(args: unknown, result: PreparedApplicationReleaseResult): string | undefined {
  try {
    const r = normalizePrepareApplicationReleaseRequest(args);
    validateSchemaValue(prepareApplicationReleaseOutputSchema, result, "发布准备结果", "");
    const key = (a: PrepareApplicationReleaseRequest) => JSON.stringify([a.requirementId, a.handoverStepId, a.artifactStepId, a.sourceStepIds, a.releasePath]);
    if (key(r) !== key(result.request) || result.binding.requirementId !== r.requirementId) return "发布准备请求身份不一致";
    if (result.status === "ready" ? !result.contract || !result.contractDigest || !result.sourceRefs.length || result.reasons.length
      : result.contract !== null || result.contractDigest !== null || result.sourceRefs.length || !result.reasons.length) return "发布准备不完整不能签发合同";
  } catch { return "发布准备结果不符合有界契约"; }
}
export const prepareApplicationReleaseTool: ToolDefinition = {
  id: "applications.prepare_release", implementation: "prepareApplicationRelease", effect: "read", executionMode: "local", planMode: "read_batch", completionMode: "continue",
  name: "应用发布事前交接绑定", description: "只消费当前任务已落账的事前交接/程序/版本正文与完整产物清单，派生有限systemd发布合同；不执行安装、切换或启动。",
  usageInstructions: "先用真实只读工具采集交接、程序/版本正文及完整产物清单，再提交其步骤ID和项目内计划发布目录。JSON交接按固定契约校验；Markdown/源码只接受有角色的有限映射，未知要求正常澄清，不可提供任意expected/met或事后HTTP反推目标。ready只表示交接绑定，变更前仍需保护基线和原审批；完成还需运行身份/版本/业务/保护证据。requiresBusinessWrite、恢复演练、Compose尚未覆盖时不能宣称完整交付。",
  inputSchema: prepareApplicationReleaseInputSchema, outputSchema: prepareApplicationReleaseOutputSchema,
  outputDescription: "绑定当前任务与需求修订的事前合同、来源收据、字段角色及限制，或明确未知原因。不会授予完成或执行权限。",
  enabled: true, builtIn: true, version: 1, updatedAt: "2026-10-13T00:00:00.000Z",
};
