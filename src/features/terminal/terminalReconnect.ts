export const MAX_TERMINAL_RECONNECT_ATTEMPTS = 3;
const BASE_RECONNECT_DELAY_MS = 1_000;

/** 第一次等待 1 秒，后续指数退避，超出上限后要求用户手动重连。 */
export function reconnectDelay(attempt: number): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_TERMINAL_RECONNECT_ATTEMPTS) {
    return undefined;
  }
  return BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1);
}

export function shouldHandleTerminalGeneration(currentGeneration: number | undefined, eventGeneration: number) {
  return currentGeneration !== undefined && currentGeneration === eventGeneration;
}
