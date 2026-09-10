import type { OpsTask } from "@/types";

/** Infer from user prose, never from assistant messages or execution evidence. */
export function taskReplyLanguage(task: OpsTask): "zh-CN" | "en" {
  const inputs = (task.messages ?? []).filter(message => message.role === "user").map(message => message.content).reverse();
  for (const input of [...inputs, task.currentInstruction ?? "", task.rootGoal ?? ""]) {
    const prose = input.replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ")
      .replace(/^\s*>.*$/gm, " ");
    if (/\p{Script=Han}/u.test(prose)) return "zh-CN";
    if (/[a-z]/i.test(prose)) return "en";
  }
  return "zh-CN";
}
