/**
 * POL-81 — the ROOT helper script, executed under `sh` against stubs (the offload.test.sh pattern,
 * wrapped in bun so it runs in CI). No root, no real sshd: `systemctl`, `systemd-run`, `getent`,
 * `chown` are stubs on PATH that record what they were asked to do. What this pins is the whole
 * security point of the feature:
 *   - ARM installs the operator key (0600) into the debug user's authorized_keys and starts sshd;
 *   - a BAD key is rejected — nothing is written (the last gate before authorized_keys);
 *   - DISARM removes the key and stops sshd;
 *   - BOOT-RESET is default-closed: it removes the key and stops sshd every boot.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { sshHelperScript } from "../src/setup/templates";

let root: string;
let helper: string;
let bin: string;
let home: string;
let calls: string;

function run(args: string[], reqBody?: string): void {
  const request = join(root, "request");
  if (reqBody !== undefined) writeFileSync(request, reqBody);
  execFileSync("sh", [helper, ...args], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      POLYPTIC_SSH_REQUEST: request,
      STUB_HOME: home,
      STUB_CALLS: calls,
    },
  });
}

function authKeys(): string {
  return join(home, ".ssh", "authorized_keys");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "polyptic-ssh-helper-"));
  bin = join(root, "bin");
  home = join(root, "home");
  calls = join(root, "calls.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });

  // Stubs. getent returns a passwd line whose home field points at our temp home; systemctl,
  // systemd-run and chown just log their argv (chown would fail on a fake user, but the script
  // guards it with `|| true`).
  writeFileSync(
    join(bin, "getent"),
    `#!/bin/sh\n[ "$1" = passwd ] && echo "polyptic-debug:x:1001:1001::$STUB_HOME:/bin/bash"\nexit 0\n`,
  );
  for (const name of ["systemctl", "systemd-run", "chown"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$STUB_CALLS"\nexit 0\n`);
  }
  for (const f of ["getent", "systemctl", "systemd-run", "chown"]) chmodSync(join(bin, f), 0o755);

  helper = join(root, "polyptic-sshd-helper");
  writeFileSync(helper, sshHelperScript("polyptic-debug"));
  chmodSync(helper, 0o755);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("polyptic-sshd-helper (POL-81)", () => {
  test("apply arm installs the key + starts sshd", () => {
    writeFileSync(calls, "");
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 operator@laptop";
    run(["apply"], `op=arm\nuser=polyptic-debug\nport=22\nttl=3600\nkey=${key}\n`);
    expect(existsSync(authKeys())).toBe(true);
    expect(readFileSync(authKeys(), "utf8").trim()).toBe(key);
    const log = readFileSync(calls, "utf8");
    expect(log).toMatch(/systemctl start ssh/);
    // The box-side TTL timer is scheduled.
    expect(log).toMatch(/systemd-run .*--on-active=3600s/);
  });

  test("a bad key is rejected — authorized_keys is not written", () => {
    rmSync(authKeys(), { force: true });
    writeFileSync(calls, "");
    run(["apply"], "op=arm\nuser=polyptic-debug\nport=22\nttl=3600\nkey=not-a-real-key\n");
    expect(existsSync(authKeys())).toBe(false);
  });

  test("disarm removes the key + stops sshd", () => {
    // Arm first so there is a key to remove.
    run(["apply"], "op=arm\nuser=polyptic-debug\nport=22\nttl=3600\nkey=ssh-ed25519 AAAAB body\n");
    expect(existsSync(authKeys())).toBe(true);
    writeFileSync(calls, "");
    run(["disarm"]);
    expect(existsSync(authKeys())).toBe(false);
    expect(readFileSync(calls, "utf8")).toMatch(/systemctl stop ssh/);
  });

  test("boot-reset is default-closed: removes the key + stops sshd", () => {
    run(["apply"], "op=arm\nuser=polyptic-debug\nport=22\nttl=3600\nkey=ssh-ed25519 AAAAB body\n");
    expect(existsSync(authKeys())).toBe(true);
    writeFileSync(calls, "");
    run(["boot-reset"]);
    expect(existsSync(authKeys())).toBe(false);
    expect(readFileSync(calls, "utf8")).toMatch(/systemctl stop ssh/);
  });

  test("apply consumes the request file (no re-trigger loop)", () => {
    const request = join(root, "request");
    run(["apply"], "op=disarm\n");
    expect(existsSync(request)).toBe(false);
  });
});
