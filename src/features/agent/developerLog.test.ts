import { describe, expect, it } from "vitest";
import { compactDeveloperLogs, createDeveloperLog, safeDeveloperEndpoint } from "@/features/agent/developerLog";

describe("developer log safety", () => {
  it("redacts known secrets and endpoint credentials before persistence", () => {
    const entry = createDeveloperLog({
      level: "error",
      operation: "requirement_processing",
      title: "模型调用失败",
      summary: "token=private-token",
      endpoint: "https://user:password@example.com/v1?api_key=private-token",
      request: { password: "database-secret", prompt: "private-token" },
      response: { error: "database-secret" },
    }, "dev-1", "2026-08-31T18:18:00.000Z", {
      model: "private-token",
      database: "database-secret",
    });

    expect(JSON.stringify(entry)).not.toContain("private-token");
    expect(JSON.stringify(entry)).not.toContain("database-secret");
    expect(entry.endpoint).toBe("https://example.com/v1");
  });

  it("keeps complete in-memory entries and only compacts the emergency persistence fallback", () => {
    const detail = "x".repeat(90_000);
    const entry = createDeveloperLog({
      level: "success",
      operation: "test",
      title: "test",
      summary: "test",
      trace: detail,
    }, "dev-1", "2026-08-31T18:18:00.000Z", {});

    expect(entry.trace).toHaveLength(90_000);
    expect(compactDeveloperLogs([entry])[0].trace).toContain("持久化空间不足");
    expect(safeDeveloperEndpoint("https://example.com/v1#debug")).toBe("https://example.com/v1");
  });
});
