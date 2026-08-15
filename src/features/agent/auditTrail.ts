import type { AuditEvent } from "@/types";

export const MAX_AUDIT_EVENTS = 500;
export type AuditEventDraft = Omit<AuditEvent, "id" | "createdAt">;

export function createAuditEvent(
  event: AuditEventDraft,
  id: string,
  createdAt: string,
): AuditEvent {
  return {
    ...event,
    id,
    title: event.title.trim() || "未命名事件",
    detail: event.detail.trim(),
    createdAt,
  };
}

export function prependAuditEvent(
  events: AuditEvent[],
  event: AuditEvent,
  limit = MAX_AUDIT_EVENTS,
) {
  return [event, ...events].slice(0, limit);
}
