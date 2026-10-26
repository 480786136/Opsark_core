import { readFileSync, writeFileSync } from "node:fs";
import { it, expect } from "vitest";
import { compileToolSchema } from "@/features/tools/toolParameterSchema";
import { ModelInvocationError, modelCandidateDiagnostic } from "./backend";
import { parseCandidateRejection } from "./candidateRejection";
import { candidateRegenerationContext } from "./modelRecovery";

// Explicit local historical replay only. No invoke, provider, SSH or task dispatch.
it.skipIf(!process.env.OPSARK_STAGE20_FIXTURE)("第二十批：冻结错误候选的工具身份到重生成反馈", () => {
  const fixture = JSON.parse(readFileSync(process.env.OPSARK_STAGE20_FIXTURE, "utf8").replace(/^\uFEFF/, ""));
  const records = [];
  for (const sample of fixture.samples) {
    const candidate = sample.candidates.find(candidate => candidate.steps[0].action.toolId === "files.preview_deletion"
      && candidate.steps[0].action.arguments.paths.length === 0);
    expect(candidate).toBeDefined();
    const action = candidate.steps[0].action;
    const tool = sample.context.tools.find(tool => tool.id === action.toolId);
    const validate = compileToolSchema(tool.inputSchema);
    expect(validate(action.arguments)).toBe(false);
    const issue = validate.errors.find(issue => issue.keyword === "minItems");
    expect(issue).toBeDefined();
    const cause = parseCandidateRejection({ version: 1, code: "TOOL_ARGUMENT_INVALID", stepIndex: 0,
      toolIds: [tool.id], keyword: issue.keyword, rejectedCandidateExecuted: false });
    // Reconstruct the new native diagnostic from validated frozen data; this is
    // not a claim that the original historical error already carried this field.
    const service = { code: "MODEL_FORMAT_INVALID", origin: "core", stage: "business_validation", retryable: false,
      message: "冻结候选本地校验后重建的错误信封", jsonPointer: "/steps/0/action/arguments/paths", keyword: issue.keyword,
      candidateRejection: cause, dispatchCertainty: "response_received" };
    const diagnostic = modelCandidateDiagnostic(new ModelInvocationError("offline", undefined, service));
    const oldDiagnostic = { code: service.code, stage: service.stage, jsonPointer: service.jsonPointer, keyword: service.keyword };
    const before = candidateRegenerationContext(JSON.stringify(sample.context), oldDiagnostic);
    const after = candidateRegenerationContext(JSON.stringify(sample.context), diagnostic);
    const decoded = JSON.parse(after);
    expect(decoded.outputRecovery.diagnostic.candidateRejection).toEqual(cause);
    expect(decoded.outputRecovery.diagnostic.rejectedToolIds).toEqual([tool.id]);
    for (const key of ["taskGoal", "executionConstraints", "permission", "confirmedUserInputs"]) {
      expect(decoded[key]).toEqual(sample.context[key]);
    }
    expect(decoded.tools).toEqual(sample.context.tools);
    records.push({ "样本": sample.name, "原始候选工具": tool.id, "原参数本地拒绝": issue.keyword,
      "新反馈": diagnostic, "上下文原约束保持": true, "工具目录保持": true,
      "修复前上下文JSON字节": Buffer.byteLength(before), "修复后上下文JSON字节": Buffer.byteLength(after),
      "新增反馈上下文JSON字节": Buffer.byteLength(after) - Buffer.byteLength(before),
      "单位": "UTF-8上下文JSON字节，非最终HTTP请求及实际Token", "信封来源": "依据冻结候选和本地Schema重建，非原时点错误信封", "真实模型调用": 0 });
  }
  expect(records).toHaveLength(3);
  writeFileSync(process.env.OPSARK_STAGE20_RESULT, JSON.stringify(records, null, 2), { encoding: "utf8", flag: "wx" });
});
