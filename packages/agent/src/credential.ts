/**
 * Durable per-machine credential storage (Phase 2b).
 *
 * After a successful first-contact enrollment the server replies `server/enrolled` with a random,
 * durable `credential`. The server keeps only `sha256(credential)`; the agent persists the RAW
 * credential locally and presents it on every subsequent reconnect (instead of the one-time
 * bootstrap token). This is the agent's app-level identity — mTLS transport hardening is a
 * separate, later layer (D12 / deploy).
 *
 * Storage: one file per machine at
 *   `${POLYPTYCH_STATE_DIR ?? ($HOME + "/.polyptych")}/credential-<machineId>`
 * The directory is created on demand (0700) and the file written 0600 where the platform allows.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root directory for agent-local state. `POLYPTYCH_STATE_DIR` overrides `$HOME/.polyptych`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.POLYPTYCH_STATE_DIR?.trim();
  if (override && override.length > 0) return override;
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  return join(home, ".polyptych");
}

/** Absolute path to this machine's credential file. */
export function credentialPath(machineId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), `credential-${machineId}`);
}

/** Load the persisted credential for `machineId`, or `null` if none is stored / unreadable. */
export function loadCredential(
  machineId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    const raw = readFileSync(credentialPath(machineId, env), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    // No credential persisted yet (first boot / lost file) — caller falls back to the bootstrap token.
    return null;
  }
}

/**
 * Persist the raw `credential` for `machineId`. Creates the state directory if needed and tightens
 * permissions to 0600 best-effort. Throws if the write itself fails so the caller can log it.
 */
export function saveCredential(
  machineId: string,
  credential: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = credentialPath(machineId, env);
  writeFileSync(path, credential, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on platforms without POSIX permissions; the write above already succeeded.
  }
}
