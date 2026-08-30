import { describe, expect, it } from "vitest";
import {
  countInteractivePasswordPrompts,
  findInteractiveCredentialPrompts,
} from "@/features/terminal/passwordPrompt";

describe("interactive password prompt detection", () => {
  it("detects SSH, sudo and generic password prompts", () => {
    expect(countInteractivePasswordPrompts("root@host's password: ")).toBe(1);
    expect(countInteractivePasswordPrompts("[sudo] password for ops: ")).toBe(1);
    expect(countInteractivePasswordPrompts("Enter password: ")).toBe(1);
  });

  it("does not treat database diagnostics or configuration text as prompts", () => {
    expect(countInteractivePasswordPrompts("ERROR 1045: Access denied (using password: NO)\n")).toBe(0);
    expect(countInteractivePasswordPrompts("password: configured\nauth_password: value\n")).toBe(0);
  });

  it("distinguishes Git HTTPS username and password prompts without requiring a newline", () => {
    expect(findInteractiveCredentialPrompts("Username for 'https://gitee.com': ")).toEqual([{
      kind: "username",
      line: "Username for 'https://gitee.com':",
      target: "gitee.com",
      end: 33,
    }]);
    expect(findInteractiveCredentialPrompts(
      "Username for 'https://gitee.com': \r\nPassword for 'https://developer@gitee.com': ",
    ).map(({ kind, target }) => ({ kind, target }))).toEqual([
      { kind: "username", target: "gitee.com" },
      { kind: "password", target: "gitee.com" },
    ]);
  });

  it("splits consecutive Git prompts when terminal echo is disabled and no newline is emitted", () => {
    const prompts = findInteractiveCredentialPrompts(
      "Username for 'https://gitee.com': Password for 'https://480786136%40qq.com@gitee.com': ",
    );
    expect(prompts.map(({ kind, target }) => ({ kind, target }))).toEqual([
      { kind: "username", target: "gitee.com" },
      { kind: "password", target: "gitee.com" },
    ]);
    expect(prompts[0].end).toBe(33);
    expect(prompts[1].end).toBeGreaterThan(prompts[0].end);
  });

  it("does not turn a diagnostic containing password text into an embedded prompt", () => {
    expect(findInteractiveCredentialPrompts("fatal: authentication failed (using password: NO)")).toEqual([]);
  });

  it("extracts an SSH password target and keeps key passphrases separate", () => {
    expect(findInteractiveCredentialPrompts("root@192.168.1.237's password: ")[0]).toMatchObject({
      kind: "password",
      target: "192.168.1.237",
    });
    expect(findInteractiveCredentialPrompts("Enter passphrase for key '/root/.ssh/id_ed25519': ")[0])
      .toMatchObject({ kind: "passphrase", target: undefined });
    expect(countInteractivePasswordPrompts("Enter passphrase for key '/root/.ssh/id_ed25519': ")).toBe(0);
  });

  it("keeps a prompt offset stable when only its trailing newline arrives", () => {
    const withoutNewline = findInteractiveCredentialPrompts("Password for 'https://developer@gitee.com': ")[0];
    const withNewline = findInteractiveCredentialPrompts("Password for 'https://developer@gitee.com': \r\n")[0];
    expect(withNewline.end).toBe(withoutNewline.end);
  });
});
