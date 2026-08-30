import type { PlanStep } from "@/types";

type SecretPurpose = "database" | "ssh" | "repository" | "api" | "generic";

function classify(value: string): SecretPurpose {
  const normalized = value.toLowerCase();
  if (/(mysql|mariadb|postgres|postgresql|database|数据库|数据源|jdbc)/.test(normalized)) return "database";
  if (/(ssh|scp|sftp|rsync|远程登录|服务器登录|登录[^\n，。]{0,40}(?:服务器|主机|(?:\d{1,3}\.){3}\d{1,3})|跳转)/.test(normalized)) return "ssh";
  if (/(git|gitee|github|gitlab|仓库|源码)/.test(normalized)) return "repository";
  if (/(api|token|令牌|接口|access[_ -]?key)/.test(normalized)) return "api";
  return "generic";
}

export function secretPurposeMismatch(
  step: Pick<PlanStep, "title" | "description" | "command" | "validation">,
  metadataDescription: string,
) {
  const required = classify(`${step.title}\n${step.description}\n${step.command}\n${step.validation}`);
  const available = classify(metadataDescription);
  if (required === "generic" || available === "generic" || required === available) return undefined;
  return { required, available };
}
