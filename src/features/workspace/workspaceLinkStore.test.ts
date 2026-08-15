// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  buildTerminalChangeDirectoryCommand,
  extractOsc7Directories,
  quoteShellPath,
  useWorkspaceLinkStore,
} from "./workspaceLinkStore";

describe("workspaceLinkStore", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("安全引用远程目录并生成带 OSC 7 回报的切换命令", () => {
    expect(quoteShellPath("/srv/app's release")).toBe("'/srv/app'\"'\"'s release'");
    expect(buildTerminalChangeDirectoryCommand("/srv/app's release"))
      .toContain("cd -- '/srv/app'\"'\"'s release' && printf");
  });

  it("只从完整 OSC 7 标记提取规范化工作目录", () => {
    const data = "output\u001b]7;file://host/srv/my%20app\u0007more\u001b]7;file://host/var/log\u001b\\";
    expect(extractOsc7Directories(data)).toEqual(["/srv/my app", "/var/log"]);
    expect(extractOsc7Directories("pwd: /tmp")).toEqual([]);
  });

  it("按服务器隔离双向请求并按请求编号消费", () => {
    const store = useWorkspaceLinkStore();
    const first = store.requestTerminalPath("server-a", "/srv");
    const second = store.requestSftpPath("server-b", "/var/log");
    store.consumeTerminalPath("server-a", first.id + 1);
    expect(store.terminalPathRequests["server-a"]).toEqual(first);
    store.consumeTerminalPath("server-a", first.id);
    store.consumeSftpPath("server-b", second.id);
    expect(store.terminalPathRequests["server-a"]).toBeUndefined();
    expect(store.sftpPathRequests["server-b"]).toBeUndefined();
  });
});
