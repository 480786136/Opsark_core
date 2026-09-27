import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { argumentPropertyPath, ToolArgumentValidationError } from "./toolArgumentProtocol";

export const isSchemaObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isRecord = isSchemaObject;

// Draft-07; never coerce, remove fields, or mutate defaults during validation.
const ajv = new Ajv({ strict: true, strictRequired: false, validateFormats: false, allErrors: true, ownProperties: true });
const compiled = new Map<string, ValidateFunction>();
export function compileToolSchema(schema: Record<string, unknown>) {
  const key = JSON.stringify(schema);
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    if (compiled.size >= 256) { compiled.clear(); ajv.removeSchema(); }
    compiled.set(key, validate);
  }
  return validate;
}
function errorPath(error: ErrorObject, base: string | undefined) {
  let path = base;
  for (const token of error.instancePath.split("/").slice(1).map(item => item.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    path = /^\d+$/.test(token) ? path === undefined ? undefined : `${path}[${token}]` : argumentPropertyPath(path, token);
  }
  if (error.keyword === "required") path = argumentPropertyPath(path, String(error.params.missingProperty));
  if (error.keyword === "additionalProperties") path = argumentPropertyPath(path, String(error.params.additionalProperty));
  return path;
}
function schemaErrorMessage(error: ErrorObject) {
  const p = error.params;
  const messages: Record<string, string> = {
    required: `缺少必填字段：${p.missingProperty}`, additionalProperties: `不支持字段：${p.additionalProperty}`,
    type: `类型必须为 ${p.type}`, enum: "不在允许范围内", pattern: "格式无效",
    minimum: `小于最小值 ${p.limit}`, maximum: `超过最大值 ${p.limit}`,
    minItems: `数量不足，至少 ${p.limit} 项`, maxItems: `数量过多，最多 ${p.limit} 项`,
    minLength: "长度不足", maxLength: "长度超过限制",
  };
  return messages[error.keyword] ?? error.message;
}
export function validateSchemaValue(schema: Record<string, unknown>, value: unknown, path: string, argumentPath: string | undefined) {
  const validate = compileToolSchema(schema);
  if (validate(value)) return;
  const errors = validate.errors ?? [];
  // Alternative branches do not establish which field the caller intended.
  const combined = errors.find(error => ["oneOf", "anyOf", "not"].includes(error.keyword));
  const error = combined ?? errors[0];
  const location = error ? errorPath(error, argumentPath) : undefined;
  const details = errors.filter(item => !["oneOf", "anyOf"].includes(item.keyword)).slice(0, 4)
    .map(item => `${item.instancePath || "/"} ${schemaErrorMessage(item)}`).join("；");
  throw new ToolArgumentValidationError(`${path} 参数校验失败：${details}`, combined ? undefined : location);
}

const editable = new Set(["description", "default", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "enum", "required"]);
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (isRecord(a) && isRecord(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => own(b, key) && same(a[key], b[key]));
  return a === b;
}

/** Remote configuration tunes existing parameters; compiled adapters own names, types and hard limits. */
export function validateCompatibleToolSchema(candidate: unknown, base: Record<string, unknown>, path = "参数协议", depth = 0): asserts candidate is Record<string, unknown> {
  const fail = (reason: string): never => { throw new Error(`${path}：${reason}`); };
  if (depth > 12 || !isRecord(candidate)) return fail("必须为受支持的参数对象");
  if (depth === 0) compileToolSchema(candidate);
  for (const key of new Set([...Object.keys(candidate), ...Object.keys(base)])) {
    if (!editable.has(key) && key !== "properties" && key !== "items" && (!own(candidate, key) || !own(base, key) || !same(candidate[key], base[key]))) fail(`不能修改执行协议字段 ${key}`);
  }
  const kind = base.type;
  if (candidate.description !== undefined && (typeof candidate.description !== "string" || candidate.description.length > 2000)) fail("参数说明最多 2000 字符");
  for (const [lower, upper, types] of [["minimum", "maximum", ["integer", "number"]], ["minItems", "maxItems", ["array"]], ["minLength", "maxLength", ["string"]]] as const) {
    for (const key of [lower, upper]) {
      const n = candidate[key];
      if (n !== undefined && (typeof n !== "number" || !Number.isFinite(n) || !(types as readonly unknown[]).includes(kind))) fail(`${key} 类型不正确`);
      if (n !== undefined && key !== "minimum" && key !== "maximum" && (!Number.isSafeInteger(n) || Number(n) < 0 || Number(n) > 1000000)) fail(`${key} 必须为非负整数`);
    }
    const min = candidate[lower] as number | undefined, max = candidate[upper] as number | undefined;
    if ((min ?? -Infinity) < ((base[lower] as number | undefined) ?? -Infinity) || (max ?? Infinity) > ((base[upper] as number | undefined) ?? Infinity)) fail("不能放宽 Core 内置执行范围");
    if ((min ?? -Infinity) > (max ?? Infinity)) fail("最小值不能超过最大值");
  }
  if (base.enum !== undefined && candidate.enum === undefined) fail("不能移除内置枚举范围");
  if (candidate.enum !== undefined) {
    if (!["string", "number", "integer", "boolean"].includes(String(kind)) || !Array.isArray(candidate.enum) || !candidate.enum.length || candidate.enum.length > 200) fail("枚举必须是非空的标量列表");
    for (const value of candidate.enum as unknown[]) {
      const { enum: _enum, default: _default, ...rule } = candidate;
      validateSchemaValue(rule, value, path, "");
      if (Array.isArray(base.enum) && !base.enum.includes(value)) fail("不能增加 Core 不支持的枚举值");
    }
  }
  if (kind === "object") {
    if (!isRecord(candidate.properties) || !isRecord(base.properties) || !same(Object.keys(candidate.properties).sort(), Object.keys(base.properties).sort())) fail("参数名称由 Core 实现提供，不能增删或重命名");
    const props = candidate.properties as Record<string, unknown>, old = base.properties as Record<string, Record<string, unknown>>;
    const required = candidate.required ?? [];
    if (!Array.isArray(required) || required.some(key => typeof key !== "string" || !own(props, key)) || new Set(required).size !== required.length) fail("必填项必须是已存在且不重复的参数名称");
    if (Array.isArray(base.required) && base.required.some(key => !(required as unknown[]).includes(key))) fail("不能移除 Core 必需参数");
    for (const [key, rule] of Object.entries(props)) validateCompatibleToolSchema(rule, old[key]!, `${path}.${key}`, depth + 1);
  } else if (candidate.properties !== undefined || candidate.required !== undefined) fail("非对象不能声明字段或必填项");
  if (kind === "array") validateCompatibleToolSchema(candidate.items, base.items as Record<string, unknown>, `${path}[]`, depth + 1);
  else if (candidate.items !== undefined) fail("非数组不能声明 items");
  if (own(candidate, "default")) validateSchemaValue(candidate, candidate.default, `${path} 默认值`, "");
}

/** Fill omitted arguments only; preserve explicit false/zero/empty values and caller-owned objects. */
export function fillToolDefaults(schema: Record<string, unknown>, input: unknown): unknown {
  const value = input === undefined && own(schema, "default") ? JSON.parse(JSON.stringify(schema.default)) : input;
  if (isRecord(value) && isRecord(schema.properties)) {
    const output = { ...value };
    for (const [key, rule] of Object.entries(schema.properties)) {
      if (isRecord(rule)) {
        const next = fillToolDefaults(rule, value[key]);
        if (next !== undefined) output[key] = next;
      }
    }
    return output;
  }
  if (Array.isArray(value) && isRecord(schema.items)) return value.map(item => fillToolDefaults(schema.items as Record<string, unknown>, item));
  return value;
}
