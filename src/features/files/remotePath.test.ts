import { describe, expect, it } from "vitest";
import {
  buildRemoteBreadcrumbs,
  joinRemotePath,
  normalizeRemotePath,
  parentRemotePath,
  validateRemoteEntryName,
} from "./remotePath";

describe("remotePath", () => {
  it("规范化并拼接 POSIX 路径", () => {
    expect(normalizeRemotePath("//var/./www/../log/")).toBe("/var/log");
    expect(normalizeRemotePath(String.raw`/boot/loader\entries`)).toBe("/boot/loader/entries");
    expect(joinRemotePath("/var/www/", "release")).toBe("/var/www/release");
    expect(parentRemotePath("/var/www")).toBe("/var");
    expect(parentRemotePath("/")).toBe("/");
  });

  it("生成可直接导航的面包屑", () => {
    expect(buildRemoteBreadcrumbs("/var/www")).toEqual([
      { label: "/", path: "/" },
      { label: "var", path: "/var" },
      { label: "www", path: "/var/www" },
    ]);
  });

  it("拒绝空名称、路径分隔符和保留名", () => {
    expect(validateRemoteEntryName("  ")).toBe("required");
    expect(validateRemoteEntryName("a/b")).toBe("separator");
    expect(validateRemoteEntryName("..")).toBe("reserved");
    expect(validateRemoteEntryName("release-2026")).toBeNull();
  });
});
