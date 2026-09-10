import { expect, it } from "vitest";
import { parameterContext, validateRequestParameters } from "./modelParameters";
import { createRuntimeModel } from "./modelRuntime";
import type { ModelProfile } from "@/types";

it("keeps defaults unchanged and preserves zero overrides and evidence", () => {
  expect(parameterContext("original")).toBe("original");
  expect(JSON.parse(parameterContext('{"evidence":"retain"}', { temperature: 0 }))).toEqual({ evidence: "retain", _requestParameters: { temperature: 0 } });
  const model = { requestParameters: { temperature: 0 }, model: "example", endpoint: "example" } as ModelProfile;
  expect(createRuntimeModel(model, "key", "{}")?.requestParameters).toEqual({ temperature: 0 });
});
it("rejects ambiguous output limits and invalid numbers", () => {
  for (const value of [NaN, Infinity, -1, 3]) expect(() => validateRequestParameters({ temperature: value })).toThrow();
  expect(() => validateRequestParameters({ max_tokens: 2.5 })).toThrow();
  expect(() => validateRequestParameters({ max_tokens: 10, max_completion_tokens: 10 })).toThrow();
});
