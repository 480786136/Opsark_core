import { describe, expect, it } from "vitest";
import type { OpsTask } from "@/types";
import { taskReplyLanguage } from "./replyLanguage";
import { modelLogContext } from "./modelLogContext";

describe("reply language", () => {
  it.each([
    ["检查当前 Java 服务", "zh-CN"],
    ["Please check running services", "en"],
    ["Please inspect this:\n```text\n检查失败\n```", "en"],
    ["继续检查 https://example.com/java", "zh-CN"],
  ])("uses latest user prose: %s", (content, language) => {
    const task = { messages: [{ role: "user", content: "之前的中文任务" },
      { role: "user", content }, { role: "assistant", content: "English model output" }],
      currentInstruction: "旧指令", rootGoal: "旧目标" } as OpsTask;
    expect(taskReplyLanguage(task)).toBe(language);
    expect(modelLogContext(task).replyLanguage).toBe(language);
  });
  it("retains previous prose language for a code-only reply", () => {
    expect(taskReplyLanguage({ messages: [{ role: "user", content: "Please check" },
      { role: "user", content: "```sh\njava -version\n```" }] } as OpsTask)).toBe("en");
  });
});
