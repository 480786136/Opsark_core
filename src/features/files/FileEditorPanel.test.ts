// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { backend } from "@/services/backend";
import { useOpsStore } from "@/stores/ops";
import { i18n } from "@/features/preferences/i18n";
import FileEditorPanel from "./FileEditorPanel.vue";

describe("FileEditorPanel connection gating", () => {
  let host: HTMLElement;
  let app: App | undefined;
  let ops: ReturnType<typeof useOpsStore>;

  function mount(online = true) {
    const pinia = createPinia();
    ops = useOpsStore(pinia);
    ops.serverConnection("server-a").status = online ? "connected" : "idle";
    vi.spyOn(ops, "getRuntimeConnection").mockImplementation(() => ops.isServerConnected("server-a")
      ? { host: "localhost", port: 22, username: "ops", password: "test" } : undefined);
    vi.spyOn(ops, "reportConnectionFailure").mockImplementation(() => undefined);
    app = createApp(FileEditorPanel, { serverId: "server-a", entry: { name: "demo.txt", path: "/demo.txt", kind: "file", size: "4 B", modified: "now" } });
    app.use(pinia).use(i18n).mount(host);
  }
  async function edit(value: string) {
    await vi.waitFor(() => expect(host.querySelector("textarea")).not.toBeNull());
    const textarea = host.querySelector("textarea")!;
    textarea.value = value;
    textarea.dispatchEvent(new Event("input"));
    await nextTick();
  }
  function saveShortcut() { window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true })); }

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div"); document.body.append(host);
    vi.spyOn(backend, "readSftpFile").mockResolvedValue(new TextEncoder().encode("original"));
    vi.spyOn(backend, "writeSftpFile").mockResolvedValue(undefined);
  });
  afterEach(() => { app?.unmount(); app = undefined; host.remove(); vi.restoreAllMocks(); });

  it("does not read a remote file before connecting", () => {
    mount(false);
    expect(backend.readSftpFile).not.toHaveBeenCalled();
    saveShortcut();
    expect(backend.writeSftpFile).not.toHaveBeenCalled();
  });

  it("preserves the draft but blocks save buttons and shortcuts immediately offline", async () => {
    mount();
    await edit("draft survives");
    ops.serverConnection("server-a").status = "suspect";
    saveShortcut();
    await nextTick();
    expect(backend.writeSftpFile).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("draft survives");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.readOnly).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(`button[title="${i18n.global.t('common.save')}"]`)?.disabled).toBe(true);
  });

  it("does not treat an old connection's late save result as a saved current draft", async () => {
    let resolve!: () => void;
    vi.mocked(backend.writeSftpFile).mockImplementation(() => new Promise<undefined>((done) => { resolve = () => done(undefined); }));
    mount();
    await edit("changed content");
    saveShortcut();
    expect(backend.writeSftpFile).toHaveBeenCalledTimes(1);
    ops.serverConnection("server-a").status = "disconnected";
    ops.serverConnection("server-a").generation += 1;
    resolve();
    await vi.waitFor(() => expect(host.textContent).toContain("保存结果待确认"));
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("changed content");
    ops.serverConnection("server-a").status = "connected";
    saveShortcut();
    expect(backend.writeSftpFile).toHaveBeenCalledTimes(1);
  });
});
