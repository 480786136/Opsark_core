import { defineStore } from "pinia";
import { backend, type RuntimeConnection, type SftpTransferProgressEvent } from "@/services/backend";

export type TransferDirection = "upload" | "download";
export type TransferStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SftpTransferTask {
  id: string;
  serverId: string;
  direction: TransferDirection;
  fileName: string;
  remotePath: string;
  status: TransferStatus;
  transferredBytes: number;
  totalBytes: number;
  speedBytesPerSecond: number;
  remainingSeconds?: number;
  createdAt: string;
  startedAt?: string;
  error?: string;
}

interface TransferPayload {
  connection: RuntimeConnection;
  uploadData?: Uint8Array;
  onComplete?: (data?: Uint8Array) => void;
}

// 密码和文件字节只留在当前进程内存，不进入 Pinia 快照或 localStorage。
const payloads = new Map<string, TransferPayload>();

export function calculateTransferMetrics(
  transferredBytes: number,
  totalBytes: number,
  elapsedMilliseconds: number,
) {
  const elapsedSeconds = Math.max(elapsedMilliseconds / 1000, 0.001);
  const speedBytesPerSecond = transferredBytes / elapsedSeconds;
  const remainingBytes = Math.max(0, totalBytes - transferredBytes);
  return {
    speedBytesPerSecond,
    remainingSeconds: speedBytesPerSecond > 0 ? remainingBytes / speedBytesPerSecond : undefined,
  };
}

function createTask(
  serverId: string,
  direction: TransferDirection,
  fileName: string,
  remotePath: string,
  totalBytes: number,
): SftpTransferTask {
  return {
    id: crypto.randomUUID(),
    serverId,
    direction,
    fileName,
    remotePath,
    status: "queued",
    transferredBytes: 0,
    totalBytes,
    speedBytesPerSecond: 0,
    createdAt: new Date().toISOString(),
  };
}

function isCancelledError(error: unknown) {
  return String(error).includes("SFTP_TRANSFER_CANCELLED");
}

export const useTransferQueueStore = defineStore("sftpTransferQueue", {
  state: () => ({
    tasks: [] as SftpTransferTask[],
    processing: false,
  }),
  getters: {
    activeCount: (state) => state.tasks.filter(({ status }) => status === "queued" || status === "running").length,
  },
  actions: {
    enqueueUpload(
      serverId: string,
      connection: RuntimeConnection,
      fileName: string,
      remotePath: string,
      data: Uint8Array,
      onComplete?: () => void,
    ) {
      const task = createTask(serverId, "upload", fileName, remotePath, data.byteLength);
      payloads.set(task.id, { connection, uploadData: data, onComplete });
      this.tasks.unshift(task);
      void this.processQueue();
      return task.id;
    },
    enqueueDownload(
      serverId: string,
      connection: RuntimeConnection,
      fileName: string,
      remotePath: string,
      onComplete: (data: Uint8Array) => void,
    ) {
      const task = createTask(serverId, "download", fileName, remotePath, 0);
      payloads.set(task.id, { connection, onComplete: (data) => onComplete(data ?? new Uint8Array()) });
      this.tasks.unshift(task);
      void this.processQueue();
      return task.id;
    },
    updateProgress(task: SftpTransferTask, event: SftpTransferProgressEvent) {
      task.transferredBytes = event.transferredBytes;
      task.totalBytes = event.totalBytes;
      const elapsed = Date.now() - new Date(task.startedAt ?? task.createdAt).getTime();
      const metrics = calculateTransferMetrics(event.transferredBytes, event.totalBytes, elapsed);
      task.speedBytesPerSecond = metrics.speedBytesPerSecond;
      task.remainingSeconds = metrics.remainingSeconds;
    },
    async processQueue() {
      if (this.processing) return;
      this.processing = true;
      try {
        let task = this.tasks.find(({ status }) => status === "queued");
        while (task) {
          const payload = payloads.get(task.id);
          if (!payload) {
            task.status = "failed";
            task.error = "SFTP_TRANSFER_PAYLOAD_MISSING";
            task = this.tasks.find(({ status }) => status === "queued");
            continue;
          }
          task.status = "running";
          task.startedAt = new Date().toISOString();
          task.error = undefined;
          try {
            if (task.direction === "upload" && payload.uploadData) {
              await backend.uploadSftpTransfer(
                payload.connection,
                task.id,
                task.remotePath,
                payload.uploadData,
                (event) => this.updateProgress(task!, event),
              );
              payload.onComplete?.();
            } else {
              const data = await backend.downloadSftpTransfer(
                payload.connection,
                task.id,
                task.remotePath,
                (event) => this.updateProgress(task!, event),
              );
              payload.onComplete?.(data);
            }
            task.status = "completed";
            task.transferredBytes = task.totalBytes;
            task.remainingSeconds = 0;
            payloads.delete(task.id);
          } catch (error) {
            task.status = isCancelledError(error) ? "cancelled" : "failed";
            task.error = isCancelledError(error) ? undefined : String(error);
          }
          task = this.tasks.find(({ status }) => status === "queued");
        }
      } finally {
        this.processing = false;
      }
    },
    async cancel(taskId: string) {
      const task = this.tasks.find(({ id }) => id === taskId);
      if (!task || !["queued", "running"].includes(task.status)) return;
      if (task.status === "queued") {
        task.status = "cancelled";
        return;
      }
      await backend.cancelSftpTransfer(taskId);
    },
    retry(taskId: string) {
      const task = this.tasks.find(({ id }) => id === taskId);
      if (!task || !["failed", "cancelled"].includes(task.status) || !payloads.has(taskId)) return;
      task.status = "queued";
      task.transferredBytes = 0;
      task.speedBytesPerSecond = 0;
      task.remainingSeconds = undefined;
      task.error = undefined;
      void this.processQueue();
    },
    clearFinished(serverId?: string) {
      const finishedIds = this.tasks
        .filter((task) => (!serverId || task.serverId === serverId) && !["queued", "running"].includes(task.status))
        .map(({ id }) => id);
      finishedIds.forEach((id) => payloads.delete(id));
      this.tasks = this.tasks.filter(({ id }) => !finishedIds.includes(id));
    },
  },
});
