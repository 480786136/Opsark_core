import { expect, it } from "vitest";
import { defaultToolCatalog } from "./toolCatalog";
import { fillToolDefaults, validateCompatibleToolSchema, validateSchemaValue } from "./toolParameterSchema";

it("fills omitted nested and array parameters without changing explicit values or sharing objects", () => {
  const schema = { type: "object", properties: {
    enabled: { type: "boolean", default: true }, count: { type: "integer", default: 5 },
    text: { type: "string", default: "fallback" },
    options: { type: "object", default: {}, properties: { limit: { type: "integer", default: 8 } } },
    absent: { type: "object", properties: { limit: { type: "integer", default: 8 } } },
    rows: { type: "array", items: { type: "object", properties: { enabled: { type: "boolean", default: true } } } },
  } };
  const input = { enabled: false, count: 0, text: "", rows: [{}] };
  const first = fillToolDefaults(schema, input) as any;
  expect(first).toEqual({ ...input, options: { limit: 8 }, rows: [{ enabled: true }] });
  first.options.limit = 100;
  expect(fillToolDefaults(schema, input)).toMatchObject({ options: { limit: 8 } });
  expect(input.rows).toEqual([{}]);
  expect(fillToolDefaults({ type: "string", default: "value" }, null)).toBeNull();
});

it("accepts reordered JSON for every shipped schema and prevents changing nested contracts", () => {
  function sorted(value: any): any {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])]));
    return value;
  }
  for (const tool of defaultToolCatalog) expect(() => validateCompatibleToolSchema(sorted(tool.inputSchema), tool.inputSchema)).not.toThrow();
  const base = defaultToolCatalog.find(t => t.id === "user.request_input")!.inputSchema;
  const changed = sorted(base);
  changed.properties.fields.items.oneOf = [];
  expect(() => validateCompatibleToolSchema(changed, base)).toThrow("执行协议字段 oneOf");
});

it("validates Unicode lengths, array bounds and enums against configured limits", () => {
  expect(() => validateSchemaValue({ type: "string", maxLength: 1 }, "😀", "title", "title")).not.toThrow();
  expect(() => validateSchemaValue({ type: "string", minLength: 2 }, "😀", "title", "title")).toThrow("长度不足");
  expect(() => validateSchemaValue({ type: "array", maxItems: 1 }, [1, 2], "rows", "rows")).toThrow("最多 1 项");
  expect(() => validateCompatibleToolSchema({ type: "string", enum: ["unsupported"] }, { type: "string", enum: ["supported"] })).toThrow("枚举值");
});
