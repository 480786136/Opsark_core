import { runObservationWindow, type ObservationBinding, type ObservationRuntimeDependencies } from "@/features/agent/observationRuntime";
import type { HealthObservationRequest, HealthObservationResult } from "./healthObservation";
import { buildHealthObservationProbe, healthProbeStartReader, parseHealthObservationProbe } from "./healthObservationProbe";

interface ProbeReceipt { success: boolean; exitCode?: number; stdout?: string; stdoutTruncated?: boolean }
export interface HealthObservationDependencies extends Omit<ObservationRuntimeDependencies, "probe"> {
  execute(command: string, executionId: string, progress: (chunk: string) => void): Promise<ProbeReceipt>;
  cancel(executionId: string): Promise<void>;
  assertCurrent(): void;
}

/** Every remote child command has its own execution id. Cancelling one task
 * never targets a shared terminal or another observation's probe. */
export async function executeHealthObservation(request: HealthObservationRequest, input: {
  binding: ObservationBinding; preparationStartedAt: number;
}, dependencies: HealthObservationDependencies): Promise<HealthObservationResult> {
  const observation = await runObservationWindow({ ...input, policy: {
    windowMs: request.windowSeconds * 1000, intervalMs: request.intervalSeconds * 1000,
    probeTimeoutMs: request.probeTimeoutSeconds * 1000,
    ...(request.absoluteDeadlineAt ? { absoluteDeadlineAt: Date.parse(request.absoluteDeadlineAt) } : {}),
  } }, { ...dependencies,
    probe: async ({ sampleIndex, timeoutMs, signal, markStarted }) => {
      const executionId = `${input.binding.executionId}-p${sampleIndex}`;
      if (signal.aborted) return { status: "invalid", matched: false, executionId, facts: { protocol: "curl-status-v1", reason: "cancelled_before_dispatch" } };
      dependencies.assertCurrent();
      let cancellationRequested = false, cancellationRequestFailed = false;
      const abort = () => {
        cancellationRequested = true;
        void dependencies.cancel(executionId).catch(() => { cancellationRequestFailed = true; });
      };
      signal.addEventListener("abort", abort, { once: true });
      const readStart = healthProbeStartReader(executionId, markStarted);
      try {
        // Leave a bounded receipt margin inside the executor's total probe cap.
        const curlTimeout = Math.max(1, timeoutMs - Math.min(250, timeoutMs / 10));
        const receipt = await dependencies.execute(buildHealthObservationProbe(request, executionId, curlTimeout), executionId, readStart);
        const result = parseHealthObservationProbe(request, executionId, receipt);
        if (cancellationRequested) result.facts = { ...result.facts, cancellationRequested: true, ...(cancellationRequestFailed ? { cancellationRequestFailed: true } : {}) };
        return result;
      } catch {
        return { status: "invalid", matched: false, executionId,
          facts: { protocol: "curl-status-v1", reason: "remote_receipt_unavailable", ...(cancellationRequested ? { cancellationRequested: true } : {}), ...(cancellationRequestFailed ? { cancellationRequestFailed: true } : {}) } };
      } finally { signal.removeEventListener("abort", abort); }
    },
  });
  return { request, observation };
}
