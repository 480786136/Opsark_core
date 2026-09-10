import { expect, it } from "vitest";
import { workspaceEntry } from "./workspaceEntry";
import type { WorkspaceTab } from "./serverWorkspaceTabsStore";

it("falls back to Local when no tab is open", () => {
  expect(workspaceEntry([], "closed-server")).toBe("/local");
});
it("restores only an open workspace and never revives a closed server", () => {
  const tabs: WorkspaceTab[] = [{ id: "local", kind: "local" }, { id: "a", kind: "server" }];
  expect(workspaceEntry(tabs, "a")).toBe("/server/a");
  expect(workspaceEntry(tabs, "local")).toBe("/local");
  expect(workspaceEntry(tabs, "closed-server")).toBe("/local");
  expect(workspaceEntry([{ id: "a", kind: "server" }], "local")).toBe("/server/a");
});
