import { describe, expect, it } from "vitest";
import { isAdjustmentProgressMessage, isPlanProgressMessage } from "@/features/agent/taskMessages";

describe("task plan progress messages", () => {
  it.each([
    "已根据失败结果自动生成 1 个调整步骤，完全托管模式已自动批准并继续；高风险步骤仍需单独确认。",
    "已根据失败结果生成 2 个调整步骤，请审查后手动批准执行。",
    "已根据执行异常自动生成 1 个调整步骤，请审查后手动批准执行。",
    "已按用户请求生成 3 个调整步骤，完全托管模式已自动批准并继续。",
    "已进入下一阶段，包含 1 个执行步骤。",
    "下一阶段计划已生成，包含 1 个执行步骤，等待批准。",
  ])("recognizes adjustment progress: %s", (message) => {
    expect(isAdjustmentProgressMessage(message)).toBe(true);
    expect(isPlanProgressMessage(message)).toBe(true);
  });

  it("keeps initial and discovery plan progress eligible for replacement", () => {
    expect(isPlanProgressMessage("已生成 2 个执行步骤，开始运行。")).toBe(true);
    expect(isPlanProgressMessage("已根据发现证据生成 1 个后续步骤，等待批准。")).toBe(true);
    expect(isAdjustmentProgressMessage("当前计划阶段已完成，但整体目标尚未验收。")).toBe(false);
  });
});
