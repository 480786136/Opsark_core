import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { backend } from "./backend";
import { createRuntimeModel } from "@/features/agent/modelRuntime";
import { modelIntegrationConfig } from "@/features/agent/modelIntegration";
import type { ModelCapabilitiesV2, ModelProfile } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const capabilitiesV2: ModelCapabilitiesV2 = {
  version: "model-capabilities@2", revision: "fixture-r1", supportedProtocols: ["responses"], preferredProtocol: "responses",
  outputModes: { json_schema: "supported", json_object: "supported" }, parameterAdapter: "openai",
  tokenField: "max_output_tokens", defaultOutputTokens: 1024, maxOutputTokens: 4096,
  strictFlag: "required", store: "supported", evidence: { source: "user_declared" },
};
const profile: ModelProfile = { id: "test", name: "Model", model: "fixture", provider: "custom", enabled: true, hasApiKey: true,
  endpoint: "https://model.invalid/v1", apiProtocol: "responses", outputPolicy: "require_schema", capabilitiesV2,
  requestParameters: { outputBudget: 2048 } };
const runtime = () => createRuntimeModel(profile, "fixture-secret", '{"task":"read-only"}')!;
const invocation = () => vi.mocked(invoke).mock.calls[vi.mocked(invoke).mock.calls.length - 1][1] as Record<string, unknown>;
beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.resetAllMocks(); });

describe("J3 model integration across business entry points", () => {
  it("preserves explicit configuration and leaves legacy profiles on their existing path", () => {
    expect(runtime()).toMatchObject(modelIntegrationConfig(profile)!);
    const { apiProtocol: _a, outputPolicy: _o, capabilitiesV2: _c, ...legacy } = profile;
    const result = createRuntimeModel(legacy, "fixture", "{}");
    expect(modelIntegrationConfig(result!)).toBeUndefined();
    expect(result).not.toHaveProperty("apiProtocol");
    expect(result?.requestParameters).toEqual({ outputBudget: 2048 });
  });

  it.each(["plan", "classify", "review", "goal", "stage", "summary"] as const)("passes the selected API through %s without changing its consumer", async operation => {
    const model = runtime();
    let contextKey = "context";
    if (operation === "plan") { vi.mocked(invoke).mockResolvedValueOnce([]); await backend.generatePlan("检查", model); }
    if (operation === "classify") { vi.mocked(invoke).mockResolvedValueOnce({ intent: "answer", answer: "状态正常", plan: [] }); await backend.processRequirement("检查", model); }
    if (operation === "review" || operation === "goal") {
      contextKey = "reviewContext";
      vi.mocked(invoke).mockResolvedValueOnce({ decision: "complete", reason: "已有证据", summary: "已完成" });
      if (operation === "review") await backend.reviewStep("检查", "{}", false, model);
      else await backend.reviewGoal("检查", "{}", model);
    }
    if (operation === "stage") { vi.mocked(invoke).mockResolvedValueOnce({ decision: "complete", reason: "已有证据", summary: "完成", steps: [] }); await backend.decideNextStage("检查", model); }
    if (operation === "summary") { contextKey = "executionContext"; vi.mocked(invoke).mockResolvedValueOnce("已有结果"); await backend.generateSummary("检查", [], model); }
    const context = JSON.parse(invocation()[contextKey] as string);
    expect(context._modelIntegration).toEqual(modelIntegrationConfig(profile));
    expect(context._requestParameters).toEqual({ outputBudget: 2048 });
    expect(context).not.toHaveProperty("apiKey");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("uses explicit probe layers without generating an executable plan", async () => {
    const result = { available: true, reason: "已验证", validation: { modelAccess: "passed", structuredOutput: "passed", businessContract: "passed" } };
    vi.mocked(invoke).mockResolvedValueOnce(result);
    expect(await backend.checkModel(runtime(), "business")).toEqual(result);
    expect(invocation()).toMatchObject({ mode: "business", integration: modelIntegrationConfig(profile) });
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual(["check_ai_model"]);
  });

  it("previews using only offline configuration and does not pass a credential", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ apiProtocol: "responses", endpoint: "https://model.invalid/v1/responses", model: "fixture", effectiveOutputMode: "json_schema", request: {} });
    await backend.previewModelRequest(runtime());
    expect(invoke).toHaveBeenCalledOnce();
    expect(vi.mocked(invoke).mock.calls[0][0]).toBe("preview_ai_model_request");
    expect(invocation()).toMatchObject({ mode: "structured", integration: modelIntegrationConfig(profile) });
    expect(JSON.stringify(invocation())).not.toContain("fixture-secret");
    expect(invocation()).not.toHaveProperty("apiKey");
  });

  it("keeps background discovery free of generation configuration", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ available: true, reason: "found" });
    await backend.checkModel({ apiKey: "fixture", endpoint: profile.endpoint, model: profile.model });
    expect(invocation().mode).toBeUndefined();
    expect(invocation().integration).toBeUndefined();
    expect(invocation().requestParameters).toBeUndefined();
    expect(invocation().capabilities).toBeUndefined();
  });

  it("passes integration to the separate skill drafting command", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ name: "检查", category: "other", description: "检查", matchRules: [], instructions: "只读" });
    await backend.generateSkill("检查", "generate", runtime());
    expect(invocation().integration).toEqual(modelIntegrationConfig(profile));
    expect(vi.mocked(invoke).mock.calls[0][0]).toBe("generate_ai_skill");
  });
});
