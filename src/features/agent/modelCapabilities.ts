import type { ModelApiProtocol, ModelCapabilities, ModelCapabilitiesV2, ModelIntegration, ModelProfile } from "@/types";
import { validateRequestParameters } from "./modelParameters";
import { executionDigest } from "./planPreparation";
import { hasMatchingPresetIdentity } from "./modelPresets";

export function parameterRules(caps?: ModelCapabilities | ModelCapabilitiesV2): ModelCapabilitiesV2["parameterRules"] {
  if (caps?.parameterRules) return caps.parameterRules;
  if (caps?.version === "model-capabilities@2") return undefined;
  switch (caps?.parameterAdapter) {
    case "deepseek": return { reasoningEfforts: ["low", "high"], thinkingEnabled: true, frequencyPenalty: true };
    case "qwen": return { reasoningEfforts: [], thinkingEnabled: false, frequencyPenalty: false, temperatureExclusiveMax: 2 };
    case "openai": return { reasoningEfforts: [], thinkingEnabled: false, frequencyPenalty: true };
    default: return undefined;
  }
}

/** The same local preflight is used by inline feedback, save and explicit test. */
export function validateModelConfiguration(model: Pick<ModelProfile, "capabilities" | "requestParameters"> & ModelIntegration & Partial<Pick<ModelProfile, "endpoint" | "model">>,
  options: { requireStructured?: boolean } = {}) {
  const params = validateRequestParameters(model.requestParameters);
  validateCapabilities(model.capabilities);
  validateCapabilitiesV2(model.capabilitiesV2);
  if ((model.endpoint !== undefined || model.model !== undefined) && !hasMatchingPresetIdentity(model)) throw new Error("预设能力与当前地址、模型或协议不一致，请重新选择精确预设或确认自定义接入能力");
  const protocol = model.apiProtocol ?? model.capabilitiesV2?.preferredProtocol ?? "chat_completions";
  if (!["chat_completions", "responses"].includes(protocol)) throw new Error("API 协议无效");
  if (protocol === "responses" && !model.capabilitiesV2) throw new Error("Responses API 需要明确的 V2 协议能力声明，请确认接入能力或重新选择协议");
  if (model.outputPolicy && !["auto", "require_schema", "json_only"].includes(model.outputPolicy)) throw new Error("结构输出策略无效");
  if (model.capabilitiesV2 && !model.capabilitiesV2.supportedProtocols.includes(protocol)) throw new Error("当前接入能力未声明支持所选 API 协议");
  if (model.capabilitiesV2 && (protocol === "responses" ? model.capabilitiesV2.tokenField !== "max_output_tokens" : model.capabilitiesV2.tokenField === "max_output_tokens")) throw new Error("Token 预算字段与所选 API 协议不一致，请重新确认接入能力");
  if (model.capabilitiesV2 && params) {
    for (const key of ["max_tokens", "max_completion_tokens"] as const) {
      if (params[key] !== undefined && model.capabilitiesV2.tokenField !== key) throw new Error("显式 Token 字段与接入能力不符，请确认迁移为最大生成预算");
    }
  }
  const output = effectiveModelOutput(model);
  if (model.outputPolicy === "require_schema" && output !== "json_schema") throw new Error("当前接入未确认支持 JSON Schema，不能使用必须使用 JSON Schema 策略");
  if (options.requireStructured && output === "unknown") throw new Error("尚未确认当前接入的结构输出能力，请选择有依据的能力声明后验证；不会自动尝试另一种 API");
  if (!params) return;
  const caps = model.capabilitiesV2 ?? model.capabilities;
  const rules = parameterRules(caps);
  const budget = params.outputBudget ?? params.max_tokens ?? params.max_completion_tokens;
  if (budget !== undefined && budget > (caps?.maxOutputTokens ?? 1_000_000)) {
    throw new Error(`输出预算不能超过当前接入上限 ${caps!.maxOutputTokens} Token`);
  }
  if (params.reasoning_effort && rules && !rules.reasoningEfforts.includes(params.reasoning_effort)) throw new Error("当前模型配置不支持所选 reasoning_effort，请清空或选择支持的档位");
  if (model.capabilitiesV2 && params.reasoning_effort && !rules?.reasoningEfforts.includes(params.reasoning_effort)) throw new Error("当前接入未声明该 reasoning_effort 档位");
  if (params.thinking === "enabled" && rules?.thinkingEnabled === false) throw new Error("当前模型配置不支持开启 thinking，请关闭或使用默认值");
  if (params.thinking === "disabled" && params.reasoning_effort) throw new Error("关闭 thinking 与显式 reasoning_effort 冲突");
  if (protocol === "responses" && (params.frequency_penalty !== undefined || params.presence_penalty !== undefined
    || params.thinking !== undefined && params.thinking !== "default")) throw new Error("Responses 不支持所选 Chat 或供应商扩展参数；请使用该接入声明的 reasoning_effort");
  if (params.frequency_penalty !== undefined && rules?.frequencyPenalty === false) throw new Error("当前模型配置不支持 frequency_penalty，请清空");
  if (model.capabilitiesV2 && params.frequency_penalty !== undefined && rules?.frequencyPenalty !== true) throw new Error("当前接入未确认支持 frequency_penalty");
  if (model.capabilitiesV2 && params.thinking === "enabled" && rules?.thinkingEnabled !== true) throw new Error("当前接入未确认支持开启 thinking");
  if (params.temperature !== undefined && rules?.temperatureExclusiveMax !== undefined && params.temperature >= rules.temperatureExclusiveMax) throw new Error(`当前模型 temperature 必须小于 ${rules.temperatureExclusiveMax}`);
  for (const [key, support] of [["temperature", rules?.temperature], ["top_p", rules?.topP], ["presence_penalty", rules?.presencePenalty]] as const) {
    if (params[key] !== undefined && (model.capabilitiesV2 ? support !== "supported" : support && support !== "supported")) throw new Error(`当前接入未确认支持 ${key}，请清空现有值或核对能力声明`);
  }
  if (caps?.parameterAdapter === "deepseek") {
    if (params.reasoning_effort && !["low", "high", "max"].includes(params.reasoning_effort)
      && !(protocol === "responses" && params.reasoning_effort === "none")) {
      throw new Error("当前 DeepSeek 协议不能保持所选推理强度的原意，请选择不会被供应商映射的档位");
    }
    const thinking = params.reasoning_effort !== undefined ? params.reasoning_effort !== "none"
      : params.thinking === "enabled" || params.thinking === "default";
    if (thinking && [params.temperature, params.presence_penalty, params.frequency_penalty].some(value => value !== undefined)) {
      throw new Error("DeepSeek 思考模式不接受显式 temperature、presence_penalty 或 frequency_penalty，请清空冲突参数");
    }
    if (params.top_p !== undefined && (!thinking || params.top_p < 0.95)) {
      throw new Error("DeepSeek 的 top_p 仅适用于思考模式，且必须在 0.95–1 之间");
    }
  }
  if (protocol === "responses" && (params.max_tokens !== undefined || params.max_completion_tokens !== undefined)) {
    throw new Error("旧 Token 字段不能直接用于 Responses；请在最大生成预算中确认迁移，原值会保留至明确修改");
  }
}

const supportStates = ["supported", "unsupported", "unknown", "conditional"];
export function validateCapabilitiesV2(value?: ModelCapabilitiesV2) {
  if (!value) return;
  if (value.version !== "model-capabilities@2" || !value.revision || value.revision.length > 160
    || !Array.isArray(value.supportedProtocols) || !value.supportedProtocols.length || value.supportedProtocols.length > 2
    || value.supportedProtocols.some(protocol => !["chat_completions", "responses"].includes(protocol))
    || !value.supportedProtocols.includes(value.preferredProtocol)
    || !value.outputModes || !supportStates.includes(value.outputModes.json_object) || !supportStates.includes(value.outputModes.json_schema)
    || !["portable", "deepseek", "qwen", "openai", "gateway"].includes(value.parameterAdapter)
    || !["max_tokens", "max_completion_tokens", "max_output_tokens"].includes(value.tokenField)
    || !Number.isInteger(value.defaultOutputTokens) || !Number.isInteger(value.maxOutputTokens)
    || value.defaultOutputTokens < 1 || value.maxOutputTokens < value.defaultOutputTokens || value.maxOutputTokens > 1_000_000
    || !value.evidence || !["documented", "locally_tested", "upstream_tested", "unknown", "user_declared", "legacy"].includes(value.evidence.source)
    || value.strictFlag !== undefined && !["required", "optional", "unsupported"].includes(value.strictFlag)
    || value.store !== undefined && !["supported", "unsupported", "unknown"].includes(value.store)
    || value.budgetSemantics !== undefined && !["total_output", "visible_output", "unknown"].includes(value.budgetSemantics)) throw new Error("模型 V2 能力配置无效");
  const rules = value.parameterRules;
  if (rules && (!Array.isArray(rules.reasoningEfforts) || rules.reasoningEfforts.length > 16
    || rules.reasoningEfforts.some(effort => typeof effort !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(effort))
    || typeof rules.thinkingEnabled !== "boolean" || typeof rules.frequencyPenalty !== "boolean"
    || [rules.temperature, rules.topP, rules.presencePenalty].some(state => state !== undefined && !supportStates.includes(state))
    || rules.temperatureExclusiveMax !== undefined && (!Number.isFinite(rules.temperatureExclusiveMax) || rules.temperatureExclusiveMax <= 0 || rules.temperatureExclusiveMax > 2))) throw new Error("模型 V2 参数能力配置无效");
}

/** Preserve old JSON/Schema choices as migration evidence; never infer stricter output from a brand. */
export function migratedModelIntegration(model: Pick<ModelProfile, "capabilities"> & ModelIntegration): ModelIntegration {
  if (model.capabilitiesV2) return { apiProtocol: model.apiProtocol ?? model.capabilitiesV2.preferredProtocol,
    outputPolicy: model.outputPolicy ?? "auto", capabilitiesV2: JSON.parse(JSON.stringify(model.capabilitiesV2)) };
  const legacy = model.capabilities ?? directCapabilities("portable");
  const capabilitiesV2: ModelCapabilitiesV2 = { version: "model-capabilities@2", revision: `legacy:${executionDigest(legacy).slice(7)}`,
    supportedProtocols: ["chat_completions"], preferredProtocol: "chat_completions", parameterAdapter: legacy.parameterAdapter,
    outputModes: { json_object: legacy.structuredOutput === "unknown" ? "unknown" : "supported",
      json_schema: legacy.structuredOutput === "json_schema" ? "supported" : "unknown" },
    tokenField: legacy.tokenField, defaultOutputTokens: legacy.defaultOutputTokens, maxOutputTokens: legacy.maxOutputTokens,
    parameterRules: parameterRules(legacy), evidence: { source: "legacy" }, budgetSemantics: "unknown", strictFlag: "required", store: "unknown" };
  return { apiProtocol: model.apiProtocol ?? "chat_completions", outputPolicy: model.outputPolicy ?? "auto", capabilitiesV2 };
}

export function newModelCapabilities(protocol: ModelApiProtocol = "chat_completions"): ModelCapabilitiesV2 {
  return { version: "model-capabilities@2", revision: "custom-unverified-v2", supportedProtocols: [protocol], preferredProtocol: protocol,
    outputModes: { json_object: "unknown", json_schema: "unknown" }, parameterAdapter: "portable",
    tokenField: protocol === "responses" ? "max_output_tokens" : "max_tokens", defaultOutputTokens: 5000, maxOutputTokens: 16384,
    evidence: { source: "unknown" }, budgetSemantics: "unknown", store: "unknown" };
}

export function effectiveModelOutput(model: Pick<ModelProfile, "capabilities"> & ModelIntegration): "json_schema" | "json_object" | "unknown" {
  const modes = model.capabilitiesV2?.outputModes ?? migratedModelIntegration(model).capabilitiesV2!.outputModes;
  if (model.outputPolicy === "json_only") return modes.json_object === "supported" ? "json_object" : "unknown";
  if (modes.json_schema === "supported") return "json_schema";
  return model.outputPolicy !== "require_schema" && modes.json_object === "supported" ? "json_object" : "unknown";
}

/** Credential identity is one-way hashed; display names are not request configuration. */
export function modelConfigurationFingerprint(model: ModelProfile, credentialIdentity = "") {
  return executionDigest({ endpoint: model.endpoint, model: model.model, timeoutSeconds: model.timeoutSeconds,
    capabilities: model.capabilities, requestParameters: model.requestParameters, integration: {
      apiProtocol: model.apiProtocol, outputPolicy: model.outputPolicy, capabilitiesV2: model.capabilitiesV2 },
    credentialIdentity: credentialIdentity ? executionDigest(credentialIdentity) : undefined });
}

export function directCapabilities(adapter: Exclude<ModelCapabilities["parameterAdapter"], "gateway">): ModelCapabilities {
  return { protocol: "chat_completions", version: "direct-v1", parameterAdapter: adapter,
    structuredOutput: adapter === "openai" ? "json_schema" : "json_object",
    tokenField: adapter === "openai" ? "max_completion_tokens" : "max_tokens",
    defaultOutputTokens: 5000, maxOutputTokens: 16384 };
}

export function validateCapabilities(value?: ModelCapabilities) {
  if (!value) return;
  if (value.protocol !== "chat_completions" || typeof value.version !== "string" || value.version.length > 80
    || !["unknown", "json_object", "json_schema"].includes(value.structuredOutput)
    || !["portable", "deepseek", "qwen", "openai", "gateway"].includes(value.parameterAdapter)
    || !["max_tokens", "max_completion_tokens"].includes(value.tokenField)
    || !Number.isInteger(value.defaultOutputTokens) || !Number.isInteger(value.maxOutputTokens)
    || value.defaultOutputTokens < 1 || value.maxOutputTokens < value.defaultOutputTokens || value.maxOutputTokens > 1_000_000) {
    throw new Error("模型能力配置无效：请检查协议、输出模式和预算。");
  }
  const rules = value.parameterRules;
  if (rules && (!Array.isArray(rules.reasoningEfforts) || rules.reasoningEfforts.length > 3 || rules.reasoningEfforts.some(effort => !["low", "medium", "high"].includes(effort))
    || typeof rules.thinkingEnabled !== "boolean" || typeof rules.frequencyPenalty !== "boolean"
    || rules.temperatureExclusiveMax !== undefined && (!Number.isFinite(rules.temperatureExclusiveMax) || rules.temperatureExclusiveMax <= 0 || rules.temperatureExclusiveMax > 2))) {
    throw new Error("模型参数能力配置无效");
  }
}
