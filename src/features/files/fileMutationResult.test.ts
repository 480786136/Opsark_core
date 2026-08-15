import { describe, expect, it } from "vitest";
import { createFileMutationResult, localizeFileMutationAudit } from "./fileMutationResult";

describe("fileMutationResult", () => {
  it("生成可本地化且包含服务器范围的审计事件", () => {
    const result = createFileMutationResult({
      operation: "rename",
      serverId: "server-a",
      sourcePath: "/old",
      targetPath: "/new",
      refresh: { ok: true, path: "/" },
    });
    const audit = localizeFileMutationAudit(result.audit, (key) => `translated:${key}`);

    expect(audit).toEqual({
      category: "command",
      level: "success",
      title: "translated:files.audit.rename",
      detail: "/old -> /new",
      serverId: "server-a",
    });
  });
});
