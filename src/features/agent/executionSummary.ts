import type { PlanStep } from "@/types";

function resultLines(step: PlanStep) {
  const mainOutput = (step.output ?? "").split("\n--- 独立校验 ---")[0];
  return mainOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line
      && !line.startsWith("$ ")
      && !line.startsWith("[exit:")
      && !line.includes("未发现匹配项"),
    );
}

export function buildExecutionSummary(requirement: string, steps: PlanStep[]) {
  const completed = steps.filter((step) => step.status === "completed");
  const failed = steps.filter((step) => step.status === "failed");
  if (failed.length) {
    const lastFailure = failed[failed.length - 1];
    const failureDetail = lastFailure.review?.summary
      ?? lastFailure.result?.failureReason
      ?? resultLines(lastFailure).slice(-3).join("；")
      ?? "最后执行步骤未达到预期";
    const verifiedResults = completed
      .slice(-3)
      .map((step) => {
        const output = resultLines(step).slice(-2).join("；");
        return output ? `${step.title}：${output}` : step.title;
      });
    return [
      `本轮任务未完成。共处理 ${completed.length + failed.length} 个步骤，失败步骤为“${lastFailure.title}”：${failureDetail}。`,
      verifiedResults.length ? `失败前已确认的结果：${verifiedResults.join("；")}。` : "",
      `用户目标“${requirement}”尚未由最终证据证明完成。`,
    ].filter(Boolean).join("\n");
  }
  const emptySteps = completed.filter((step) =>
    step.result?.observationStatus === "not_found"
    || step.output?.includes("未发现匹配项"),
  );
  const unhealthySteps = completed.filter((step) =>
    step.result?.observationStatus === "unhealthy"
    || step.result?.observationStatus === "warning",
  );
  if (unhealthySteps.length) {
    const details = unhealthySteps
      .map((step) => `${step.title}：${step.result?.warnings[0] ?? "观察到异常状态"}`)
      .join("；");
    return `本轮执行完成，共处理 ${completed.length} 个步骤，发现 ${unhealthySteps.length} 个需要关注的状态。${details}。`;
  }
  if (emptySteps.length) {
    return `本轮处理完成，共执行 ${completed.length} 个步骤。其中 ${emptySteps.length} 个查询正常完成但没有匹配数据或发现目标，其余步骤证据有效。`;
  }
  const finalResult = completed.length ? resultLines(completed[completed.length - 1]).slice(0, 5) : [];
  return finalResult.length
    ? `本轮处理完成，共执行 ${completed.length} 个步骤，程序证据均有效。最终结果：${finalResult.join("；")}。`
    : `本轮处理完成，共执行 ${completed.length} 个步骤，程序证据均有效。`;
}
