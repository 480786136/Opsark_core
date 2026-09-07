import type { AuditEvent } from "@/types";
import type { DirectoryLoadResult } from "./fileWorkspaceStore";

export type FileMutationOperation = "createDirectory" | "rename" | "delete";

export interface FileMutationAuditDto {
  category: "command";
  level: "success" | "warning";
  titleKey: `files.audit.${FileMutationOperation}`;
  detail: string;
  serverId: string;
}

export interface FileMutationResult {
  operation: FileMutationOperation;
  sourcePath?: string;
  targetPath?: string;
  refresh: DirectoryLoadResult;
  audit: FileMutationAuditDto;
}

interface CreateFileMutationResultOptions {
  operation: FileMutationOperation;
  serverId: string;
  sourcePath?: string;
  targetPath?: string;
  refresh: DirectoryLoadResult;
}

/** 统一生成文件变更结果，使刷新状态和审计信息始终与同一次远程操作绑定。 */
export function createFileMutationResult({
  operation,
  serverId,
  sourcePath,
  targetPath,
  refresh,
}: CreateFileMutationResultOptions): FileMutationResult {
  const detail = sourcePath && targetPath ? `${sourcePath} -> ${targetPath}` : targetPath ?? sourcePath ?? "";
  return {
    operation,
    sourcePath,
    targetPath,
    refresh,
    audit: {
      category: "command",
      level: operation === "delete" ? "warning" : "success",
      titleKey: `files.audit.${operation}`,
      detail,
      serverId,
    },
  };
}

/** 在界面语言边界将稳定的审计键转换为最终日志标题。 */
export function localizeFileMutationAudit(
  audit: FileMutationAuditDto,
  translate: (key: string) => string,
): Omit<AuditEvent, "id" | "createdAt"> {
  const { titleKey, ...event } = audit;
  return { ...event, title: translate(titleKey) };
}
