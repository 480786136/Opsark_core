import { argumentPropertyPath, ToolArgumentValidationError } from "./toolArgumentProtocol";

export const isSchemaObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isRecord = isSchemaObject;

export function validateSchemaValue(schema: Record<string, unknown>, value: unknown, path: string, argumentPath: string | undefined) {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  const type = schema.type;
  const validType = type === "string" ? typeof value === "string"
    : type === "boolean" ? typeof value === "boolean"
      : type === "number" ? typeof value === "number" && Number.isFinite(value)
        : type === "integer" ? typeof value === "number" && Number.isInteger(value)
          : type === "array" ? Array.isArray(value)
            : type === "object" ? isRecord(value)
              : true;
  if (!validType) throw new ToolArgumentValidationError(`${path} 类型必须为 ${String(type)}`, argumentPath);
  if (isRecord(value) && schema.additionalProperties === false) {
    const unknown = Object.keys(value).find((key) => !(key in properties));
    if (unknown) throw new ToolArgumentValidationError(`${path} 不支持字段：${unknown}`, argumentPropertyPath(argumentPath, unknown));
  }
  if (isRecord(value)) {
    const missing = required.find((key) => value[key] === undefined);
    if (missing) throw new ToolArgumentValidationError(`${path} 缺少必填字段：${missing}`, argumentPropertyPath(argumentPath, missing));
    for (const [key, rawRule] of Object.entries(properties)) {
      if (value[key] !== undefined && isRecord(rawRule)) validateSchemaValue(rawRule, value[key], `${path}.${key}`, argumentPropertyPath(argumentPath, key));
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) throw new ToolArgumentValidationError(`${path} 小于最小值 ${schema.minimum}`, argumentPath);
    if (typeof schema.maximum === "number" && value > schema.maximum) throw new ToolArgumentValidationError(`${path} 超过最大值 ${schema.maximum}`, argumentPath);
  }
  if (typeof value === "string" && typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
    throw new ToolArgumentValidationError(`${path} 格式无效，应匹配 ${schema.pattern}`, argumentPath);
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) throw new ToolArgumentValidationError(`${path} 长度不足`, argumentPath);
    if (typeof schema.maxLength === "number" && length > schema.maxLength) throw new ToolArgumentValidationError(`${path} 长度超过限制`, argumentPath);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) throw new ToolArgumentValidationError(`${path} 数量不足，至少 ${schema.minItems} 项`, argumentPath);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new ToolArgumentValidationError(`${path} 数量过多，最多 ${schema.maxItems} 项`, argumentPath);
    const itemRule = isRecord(schema.items) ? schema.items : undefined;
    if (itemRule) value.forEach((item, index) => validateSchemaValue(itemRule, item, `${path}[${index}]`,
      argumentPath === undefined ? undefined : `${argumentPath}[${index}]`));
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new ToolArgumentValidationError(`${path} 不在允许范围内：${schema.enum.join("、")}`, argumentPath);
  }
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
