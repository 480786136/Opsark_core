import { describe, expect, it } from "vitest";
import { secretPurposeMismatch } from "@/features/agent/secretPurpose";

const databaseStep = {
  title: "列出 MySQL 数据库",
  description: "使用数据库管理员凭据查询 SHOW DATABASES",
  command: "mysql -p'${secret.PASSWORD}' -e 'SHOW DATABASES'",
  validation: "mysqladmin ping",
};

describe("secret purpose matching", () => {
  it("rejects reusing an SSH password for a database operation", () => {
    expect(secretPurposeMismatch(databaseStep, "用于登录 192.168.1.237 的 SSH 密码")).toEqual({
      required: "database",
      available: "ssh",
    });
    expect(secretPurposeMismatch(databaseStep, "用于登录192.168.1.237的密码")).toEqual({
      required: "database",
      available: "ssh",
    });
  });

  it("accepts matching database metadata", () => {
    expect(secretPurposeMismatch(databaseStep, "Office 项目 MariaDB root 登录密码")).toBeUndefined();
  });
});
