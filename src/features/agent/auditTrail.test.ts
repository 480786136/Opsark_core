import { describe, expect, it } from "vitest";
import { createAuditEvent, prependAuditEvent } from "@/features/agent/auditTrail";
import type { AuditEvent } from "@/types";

describe("audit trail", () => {
  it("normalizes event text and assigns stable metadata", () => {
    const event = createAuditEvent({
      category: "tool",
      level: "success",
      title: "  工具调用完成  ",
      detail: "  result  ",
    }, "log-1", "2026-08-14T00:00:00.000Z");

    expect(event).toEqual(expect.objectContaining({
      id: "log-1",
      title: "工具调用完成",
      detail: "result",
      createdAt: "2026-08-14T00:00:00.000Z",
    }));
  });

  it("keeps newest events within the configured limit", () => {
    const existing = ["old-1", "old-2"].map((id) => ({
      id,
      category: "system",
      level: "info",
      title: id,
      detail: id,
      createdAt: "now",
    } as AuditEvent));
    const latest = { ...existing[0], id: "latest" };

    expect(prependAuditEvent(existing, latest, 2).map((event) => event.id)).toEqual(["latest", "old-1"]);
  });
});
