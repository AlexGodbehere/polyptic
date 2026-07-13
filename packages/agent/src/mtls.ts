/**
 * mTLS client identity for the agent (POL-25).
 *
 * The agent generates its keypair ON THE BOX and sends only a CSR up the (already-authenticated)
 * enrolment channel; the server signs it into a durable client certificate (CN = machine id) and
 * returns it in `server/enrolled.mtls` together with the deployment's CA and the mTLS listener's
 * port. From then on every reconnect dials that listener over `wss://`, presenting the cert — a
 * box without a valid cert never completes the TLS handshake.
 *
 * Persistence mirrors ./credential.ts: one JSON file per machine at
 *   `${POLYPTIC_STATE_DIR ?? ($HOME + "/.polyptic")}/mtls-<machineId>.json`
 * holding { keyPem, certPem, caPem, url }, written 0600. On a diskless netboot box the state dir is
 * tmpfs, so the bundle evaporates each boot and the agent simply re-enrols over the plain channel
 * with its baked token (the existing D46 flow) and receives a fresh cert — nothing new to configure.
 *
 * Crypto: ECDSA P-256 via WebCrypto + `@peculiar/x509`. The `reflect-metadata` import must land
 * before `@peculiar/x509` evaluates and Bun mis-orders the static-import case, hence the dynamic
 * import (same dance as the server's mtls.ts).
 */
import "reflect-metadata";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "./credential";

const x509 = await import("@peculiar/x509");
x509.cryptoProvider.set(globalThis.crypto);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

/** How close to expiry (days) the agent starts asking for a renewal via CSR. */
const RENEW_WINDOW_DAYS = 30;

/** Everything the agent persists to dial the mTLS listener: its key, cert, pinned CA and target. */
export interface MtlsBundleFile {
  /** This box's private key (PKCS#8 PEM). Generated here; never crossed the wire. */
  keyPem: string;
  /** The signed client certificate (PEM), CN = machineId. */
  certPem: string;
  /** The deployment's agent CA (PEM) — pinned as the ONLY trust root for the mTLS listener. */
  caPem: string;
  /** The full wss:// URL of the mTLS agent channel. */
  url: string;
}

/** Absolute path to this machine's mTLS bundle file. */
export function mtlsBundlePath(machineId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), `mtls-${machineId}.json`);
}

/** Load the persisted bundle, or `null` when absent/unreadable/incomplete (caller enrols plain). */
export function loadMtlsBundle(
  machineId: string,
  env: NodeJS.ProcessEnv = process.env,
): MtlsBundleFile | null {
  try {
    const raw = readFileSync(mtlsBundlePath(machineId, env), "utf8");
    const parsed = JSON.parse(raw) as Partial<MtlsBundleFile>;
    if (parsed.keyPem && parsed.certPem && parsed.caPem && parsed.url) {
      return { keyPem: parsed.keyPem, certPem: parsed.certPem, caPem: parsed.caPem, url: parsed.url };
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the bundle (0600 best-effort, like the credential). Throws if the write fails. */
export function saveMtlsBundle(
  machineId: string,
  bundle: MtlsBundleFile,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = mtlsBundlePath(machineId, env);
  writeFileSync(path, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on platforms without POSIX permissions; the write above already succeeded.
  }
}

/**
 * Generate a fresh keypair + CSR for this machine. The key stays here (returned as PEM for the
 * caller to pair with the cert the server sends back); only the CSR goes on the wire. The CSR's
 * subject carries the machine id for legibility, but the server ignores it and forces the CN itself.
 */
export async function generateKeyAndCsr(machineId: string): Promise<{ keyPem: string; csrPem: string }> {
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${machineId.replace(/[,+"\\<>;=]/g, "_")}`,
    keys,
    signingAlgorithm: ALG,
  });
  const der = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${b64.trim()}\n-----END PRIVATE KEY-----\n`;
  return { keyPem, csrPem: csr.toString("pem") };
}

/**
 * True when the cert is inside its renewal window (or expired, or unparseable) — the agent then
 * attaches a fresh CSR to its next hello so the server re-issues before the old cert dies.
 */
export function certNeedsRenewal(certPem: string, now: Date = new Date()): boolean {
  try {
    const cert = new x509.X509Certificate(certPem);
    return cert.notAfter.getTime() - now.getTime() < RENEW_WINDOW_DAYS * 24 * 3600 * 1000;
  } catch {
    return true;
  }
}

/**
 * The wss:// URL the agent should dial for the mTLS channel. The server's `url` override wins
 * verbatim (normalised to carry the /agent path); otherwise it is the agent's own configured
 * server URL with the scheme forced to wss and the port swapped for the advertised one — the same
 * HOST the agent already knows, so nothing new to configure per box.
 */
export function deriveMtlsUrl(serverUrl: string, advertise: { port: number; url?: string }): string {
  if (advertise.url) {
    try {
      const url = new URL(advertise.url);
      if (url.pathname === "" || url.pathname === "/") url.pathname = "/agent";
      return url.toString();
    } catch {
      return advertise.url;
    }
  }
  const url = new URL(serverUrl);
  url.protocol = "wss:";
  url.port = String(advertise.port);
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/agent";
  return url.toString();
}
