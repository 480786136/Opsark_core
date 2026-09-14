import { defineStore } from "pinia";
import { backend, type RuntimeConnection, type SftpTransferProgressEvent } from "@/services/backend";
import { useOpsStore } from "@/stores/ops";
import { isConnectionTransportFailure } from "@/features/connection/connectionStore";

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
  generation: number;
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

function currentTransferConnection(serverId: string, payload: TransferPayload, requireGeneration = true) {
  const ops = useOpsStore();
  if (!ops.isServerConnected(serverId)) return undefined;
  if (requireGeneration && ops.serverConnection(serverId).generation !== payload.generation) return undefined;
  const connection = ops.getRuntimeConnection(serverId);
  if (!connection || ["host", "port", "username", "password"].some((key) =>
    connection[key as keyof RuntimeConnection] !== payload.connection[key as keyof RuntimeConnection])) return undefined;
  return connection;
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
      payloads.set(task.id, { connection, generation: useOpsStore().serverConnection(serverId).generation, uploadData: data, onComplete });
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
      payloads.set(task.id, { connection, generation: useOpsStore().serverConnection(serverId).generation, onComplete: (data) => onComplete(data ?? new Uint8Array()) });
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
            const connection = currentTransferConnection(task.serverId, payload);
            if (!connection) throw new Error("SFTP_SERVER_NOT_CONNECTED_OR_CHANGED");
            const activeTask = task;
            const onProgress = (event: SftpTransferProgressEvent) => {
              if (currentTransferConnection(activeTask.serverId, payload)) this.updateProgress(activeTask, event);
            };
            if (task.direction === "upload" && payload.uploadData) {
              await backend.uploadSftpTransfer(
                connection,
                task.id,
                task.remotePath,
                payload.uploadData,
                onProgress,
              );
              if (!currentTransferConnection(task.serverId, payload)) throw new Error("SFTP_TRANSFER_RESULT_UNCONFIRMED");
              payload.onComplete?.();
            } else {
              const data = await backend.downloadSftpTransfer(
                connection,
                task.id,
                task.remotePath,
                onProgress,
              );
              if (!currentTransferConnection(task.serverId, payload)) throw new Error("SFTP_TRANSFER_RESULT_UNCONFIRMED");
              payload.onComplete?.(data);
            }
            task.status = "completed";
            task.transferredBytes = task.totalBytes;
            task.remainingSeconds = 0;
            payloads.delete(task.id);
          } catch (error) {
            task.status = isCancelledError(error) ? "cancelled" : "failed";
            task.error = isCancelledError(error) ? undefined : String(error);
            if (isConnectionTransportFailure(String(error))
              && useOpsStore().serverConnection(task.serverId).generation === payload.generation) {
              useOpsStore().reportConnectionFailure(task.serverId, String(error));
            }
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
      const payload = payloads.get(taskId)!;
      // A lost upload result needs verification by the user, never a blind duplicate write.
      if (task.error?.includes("SFTP_TRANSFER_RESULT_UNCONFIRMED") || !currentTransferConnection(task.serverId, payload, false)) return;
      payload.generation = useOpsStore().serverConnection(task.serverId).generation;
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
