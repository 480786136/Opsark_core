import { invoke } from "@tauri-apps/api/core";
export function cloudRequest<T>(operation: string, payload?: unknown, userId?: string): Promise<T> {
  return invoke<T>("cloud_request", { operation, payload, userId });
}
