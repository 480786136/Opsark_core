import { describe, expect, it } from "vitest";
import { httpDeliveryInputSchema, httpDeliveryOutputSchema } from "./httpDeliveryContracts";
import { normalizeHttpDeliveryRequest } from "./httpDeliveryInspection";
import { compileToolSchema } from "./toolParameterSchema";

const observation = { path: "/srv/backend.jsonl", injection: { kind: "header", name: "X-Request-ID" },
  probeIdPointer: "/probe", requestTargetPointer: "/target", expectedRequestTarget: "/backend" };
const request = (patch: Record<string, unknown> = {}) => ({ url: "https://delivery.test/", backendObservation: { ...observation, ...patch } });
const legacySchema = JSON.parse(JSON.stringify(httpDeliveryInputSchema));
delete legacySchema.properties.backendObservation.allOf;
legacySchema.properties.backendObservation.dependencies = { authorityPointer: ["expectedAuthority"], expectedAuthority: ["authorityPointer"] };
const original = compileToolSchema(legacySchema), current = compileToolSchema(httpDeliveryInputSchema);
const values = ["absent", "valid", "null", "empty", "number"] as const;

describe("HTTP authority 配对契约的严格输出兼容表达", () => {
  for (const pointer of values) for (const authority of values) {
    it(`旧新本地契约等价：pointer=${pointer}, authority=${authority}`, () => {
      const patch: Record<string, unknown> = {};
      for (const [key, mode, valid] of [["authorityPointer", pointer, "/host"], ["expectedAuthority", authority, "backend.test"]] as const) {
        if (mode !== "absent") patch[key] = mode === "valid" ? valid : mode === "null" ? null : mode === "empty" ? "" : 12;
      }
      const input = request(patch), before = JSON.stringify(input);
      const expected = pointer === "absent" && authority === "absent" || pointer === "valid" && authority === "valid";
      expect(original(input)).toBe(expected);
      expect(current(input)).toBe(expected);
      if (expected) expect(normalizeHttpDeliveryRequest(input).backendObservation).toMatchObject(patch);
      else expect(() => normalizeHttpDeliveryRequest(input)).toThrow();
      expect(JSON.stringify(input)).toBe(before);
    });
  }
  it("省略整组观察参数不会误触发配对；输出请求沿用相同限制", () => {
    expect(current({ url: "https://delivery.test/" })).toBe(true);
    expect(normalizeHttpDeliveryRequest({ url: "https://delivery.test/" }).backendObservation).toBeUndefined();
    const outputRequest = compileToolSchema(httpDeliveryOutputSchema.properties.request as Record<string, unknown>);
    const complete = normalizeHttpDeliveryRequest(request({ authorityPointer: "/host", expectedAuthority: "backend.test" }));
    expect(outputRequest(complete)).toBe(true);
    const broken = JSON.parse(JSON.stringify(complete)); delete broken.backendObservation.authorityPointer;
    expect(outputRequest(broken)).toBe(false);
  });
  it.each([
    { authorityPointer: "host", expectedAuthority: "backend.test" },
    { authorityPointer: "/~2", expectedAuthority: "backend.test" },
    { authorityPointer: "/host", expectedAuthority: "" },
    { injection: { kind: "header", name: "Host" } },
    { injection: { kind: "header", name: "Authorization" } },
    { maxLogBytes: 1048577 }, { windowMs: 49 }, { extra: "forbidden" },
  ])("配对等价替换不放宽已有输入边界 %j", patch => {
    expect(original(request(patch))).toBe(false);
    expect(current(request(patch))).toBe(false);
    expect(() => normalizeHttpDeliveryRequest(request(patch))).toThrow();
  });
});
