import { describe, expect, it } from "vitest";
import { buildSecretUnlockRequest } from "@/features/agent/secretUnlockPrompt";
import type { PlanStep } from "@/types";

const step: PlanStep = {
  id: "db-step",
  title: "初始化项目数据库",
  description: "连接 MariaDB 并创建项目库",
  command: "mysql -p\"${secret.PASSWORD}\"",
  expected: "数据库存在",
  validation: "mysqladmin ping",
  risk: "high",
  status: "awaiting_input",
};

describe("secret unlock prompt", () => {
  it("turns a generic key into a user-facing purpose and unlock explanation", () => {
    const request = buildSecretUnlockRequest({ taskId: "task-1", step, key: "PASSWORD" });
    expect(request.label).toBe("数据库登录密码");
    expect(request.description).toContain("连接项目数据库");
    expect(request.unlockDescription).toContain("初始化项目数据库");
    expect(request.unlockDescription).toContain("不会发送给模型");
  });

  it("prefers semantic metadata supplied by the user", () => {
    const request = buildSecretUnlockRequest({
      taskId: "task-1", step, key: "OFFICE_DATABASE_PASSWORD", metadataDescription: "Office 生产库 root 账户密码",
    });
    expect(request.label).toBe("Office 生产库 root 账户密码");
  });
});
