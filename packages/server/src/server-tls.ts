/**
 * Native server TLS (POL-70/D89) — the modes, the self-signed machinery, and the operator surface.
 *
 * THE CONTRACT (recorded in D88):
 *   - `TLS_CERT_FILE` + `TLS_KEY_FILE` (both PEM paths)   → mode `provided`: serve the operator's
 *     own certificate. One without the other refuses to boot — asking for TLS and silently getting
 *     plain HTTP would be the worst failure mode.
 *   - `TLS_MODE=self-signed`                              → the server mints and PERSISTS its own
 *     CA + server leaf (the @peculiar/x509 machinery proven by POL-25's mtls.ts) and serves native
 *     TLS with it. For deployments with no cert infrastructure at all — the homelab case.
 *     Setting cert files AND self-signed together is a refused conflict, not a precedence puzzle.
 *   - neither                                             → mode `off`: plain HTTP (TLS, if any,
 *     terminates upstream at an ingress).
 *
 * SELF-SIGNED PERSISTENCE IS THE POINT: the CA is minted ONCE and reused forever, because the
 * operator workflow is "download the CA from Console ▸ Settings ▸ HTTPS, trust it once per device,
 * never see a warning again" — a CA re-minted on boot would re-warn every browser. The LEAF is
 * reused too, and only re-minted (from the SAME CA, so trust survives) when the required SAN set
 * gained a name or the leaf is inside its last 30 days. Leaf validity is capped at ~2 years:
 * platform lifetime limits target public roots, but staying under them costs nothing here.
 *
 * SANs cover every host an operator might dial: localhost/loopbacks + os.hostname() + the
 * PUBLIC_BASE_URL host + TLS_SANS (comma list — in Kubernetes the chart adds the Service DNS name).
 *
 * The CA-download route lives GATED under /api/v1/settings like every other operator-workflow
 * surface. A CA *certificate* is public material by definition — gating is not secrecy, it is
 * consistency: nothing machine-side ever fetches it (agents pin the separate mTLS CA from their
 * enrolment bundle; wall boxes render over plain ws or behind the ingress), so the only client is
 * an operator with a session, and an ungated route would just advertise the deployment's internal
 * hostnames to anonymous scanners for no consumer at all.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { hostname } from "node:os";

import { HttpsInfo } from "@polyptic/protocol";

import type { FastifyInstance } from "fastify";

import type { PersistedServerTls, Store } from "./store";

const x509 = await import("@peculiar/x509");
x509.cryptoProvider.set(globalThis.crypto);

/** ECDSA P-256 / SHA-256 — same suite as the mTLS machinery (small keys, fast handshakes). */
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

const DAY_MS = 24 * 3600 * 1000;
/** CA lifetime — trusted once per device, so it should outlive the deployment. */
const CA_VALIDITY_MS = 20 * 365 * DAY_MS;
/** Leaf lifetime — re-minted from the same CA near expiry, so ~2 years is plenty and stays under
 *  every platform's server-cert lifetime ceiling. */
const LEAF_VALIDITY_MS = 730 * DAY_MS;
/** Re-mint the leaf (same CA) when it has less than this left. */
const LEAF_RENEW_WINDOW_MS = 30 * DAY_MS;

/** How the main listener serves TLS. `off` = plain HTTP. */
export type TlsMode = "off" | "provided" | "self-signed";

/** What the env asked for — resolved by {@link resolveTlsEnv}, refused loudly on conflicts. */
export type TlsEnvConfig =
  | { mode: "off" }
  | { mode: "provided"; certFile: string; keyFile: string }
  | { mode: "self-signed" };

/**
 * Resolve the TLS env contract. Throws (with an operator-legible message) on every half-configured
 * or conflicting combination — the caller turns that into a refused boot.
 */
export function resolveTlsEnv(env: NodeJS.ProcessEnv = process.env): TlsEnvConfig {
  const certFile = env.TLS_CERT_FILE?.trim() || undefined;
  const keyFile = env.TLS_KEY_FILE?.trim() || undefined;
  const rawMode = env.TLS_MODE?.trim().toLowerCase() || undefined;

  if (rawMode !== undefined && rawMode !== "self-signed") {
    throw new Error(
      `TLS_MODE="${rawMode}" is not a mode. Supported: unset (plain HTTP, or provided-cert TLS when ` +
        `TLS_CERT_FILE+TLS_KEY_FILE are set) or "self-signed" (the server mints + persists its own CA).`,
    );
  }
  if (rawMode === "self-signed" && (certFile || keyFile)) {
    throw new Error(
      "TLS_MODE=self-signed conflicts with TLS_CERT_FILE/TLS_KEY_FILE — pick ONE: your own " +
        "certificate (unset TLS_MODE) or the self-signed machinery (unset the file paths).",
    );
  }
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new Error(
      "TLS_CERT_FILE and TLS_KEY_FILE must be set TOGETHER (both PEM paths) — refusing to start " +
        "half-configured rather than silently serve plain HTTP.",
    );
  }
  if (rawMode === "self-signed") return { mode: "self-signed" };
  if (certFile && keyFile) return { mode: "provided", certFile, keyFile };
  return { mode: "off" };
}

/** Everything index.ts and the settings routes need about the live TLS posture. */
export interface ServerTlsRuntime {
  mode: TlsMode;
  /** Fastify `https` material — undefined only in `off` mode. */
  material?: { cert: string; key: string };
  /** The downloadable CA (self-signed mode only). */
  ca?: { pem: string; createdAt: string; fingerprintSha256: string };
  /** SANs of the active self-signed leaf (empty in the other modes). */
  sans: string[];
}

/** A random, positive X.509 serial (16 bytes hex, top bit cleared so DER stays positive). */
function randomSerial(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey("pkcs8", key);
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64.trim()}\n-----END PRIVATE KEY-----\n`;
}

async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Buffer.from(b64, "base64");
  return crypto.subtle.importKey("pkcs8", der, ALG, true, ["sign"]);
}

/** Colon-separated uppercase SHA-256 fingerprint of a PEM certificate's DER — the format every
 *  cert-inspection UI shows, so an operator can eyeball-match the download. */
export function certFingerprintSha256(certPem: string): string {
  const der = new x509.X509Certificate(certPem).rawData;
  const hex = createHash("sha256").update(Buffer.from(der)).digest("hex").toUpperCase();
  return hex.replace(/(..)(?!$)/g, "$1:");
}

/**
 * The SAN set a self-signed leaf must cover: loopbacks + this host's name + the PUBLIC_BASE_URL
 * host + TLS_SANS (comma list). Sorted so set-equality checks are order-free.
 */
export function requiredSans(env: NodeJS.ProcessEnv = process.env): string[] {
  const sans = new Set<string>(["localhost", "127.0.0.1", "::1", hostname()]);
  const publicBase = env.PUBLIC_BASE_URL?.trim();
  if (publicBase) {
    try {
      sans.add(new URL(publicBase).hostname.replace(/^\[|\]$/g, ""));
    } catch {
      // Not a URL — TLS_SANS is the explicit escape hatch.
    }
  }
  for (const raw of (env.TLS_SANS ?? "").split(",")) {
    const trimmed = raw.trim();
    if (trimmed) sans.add(trimmed);
  }
  return [...sans].sort();
}

async function mintLeaf(
  caCertPem: string,
  caKeyPem: string,
  sans: string[],
): Promise<{ certPem: string; keyPem: string }> {
  const caCert = new x509.X509Certificate(caCertPem);
  const caKey = await importPrivateKeyPem(caKeyPem);
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: "CN=polyptic-server",
    issuer: caCert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + LEAF_VALIDITY_MS),
    signingAlgorithm: ALG,
    publicKey: keys.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(
        sans.map((name) => (isIP(name) ? { type: "ip" as const, value: name } : { type: "dns" as const, value: name })),
      ),
    ],
  });
  return { certPem: cert.toString("pem"), keyPem: await exportPrivateKeyPem(keys.privateKey) };
}

/** True when the persisted leaf still covers `sans` and is not inside its renewal window. */
function leafStillGood(persisted: PersistedServerTls, sans: string[]): boolean {
  const covered = new Set(persisted.sans);
  if (!sans.every((name) => covered.has(name))) return false;
  try {
    const leaf = new x509.X509Certificate(persisted.certPem);
    return leaf.notAfter.getTime() - Date.now() > LEAF_RENEW_WINDOW_MS;
  } catch {
    return false; // unparseable leaf → re-mint
  }
}

/**
 * Load (or first-mint) the persisted self-signed material and return the live runtime. The CA is
 * NEVER re-minted here — losing it would re-warn every trusted browser, so it is written exactly
 * once. The leaf is re-minted from the same CA when the SAN set gained a name or expiry nears;
 * `changed` tells the caller whether anything was written (for the boot log).
 */
export async function initSelfSignedTls(
  store: Store,
  sans: string[],
): Promise<ServerTlsRuntime & { changed: "none" | "minted-ca" | "reminted-leaf" }> {
  let persisted = await store.getServerTls();
  let changed: "none" | "minted-ca" | "reminted-leaf" = "none";

  if (!persisted) {
    const caKeys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const caCert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomSerial(),
      name: "CN=Polyptic Server CA",
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + CA_VALIDITY_MS),
      signingAlgorithm: ALG,
      keys: caKeys,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      ],
    });
    const caCertPem = caCert.toString("pem");
    const caKeyPem = await exportPrivateKeyPem(caKeys.privateKey);
    const leaf = await mintLeaf(caCertPem, caKeyPem, sans);
    persisted = {
      caCertPem,
      caKeyPem,
      certPem: leaf.certPem,
      keyPem: leaf.keyPem,
      sans,
      createdAt: new Date().toISOString(),
    };
    await store.setServerTls(persisted);
    changed = "minted-ca";
  } else if (!leafStillGood(persisted, sans)) {
    // Union the SANs: a leaf must keep answering for names it already served (the box may be
    // dialled by an old name while DNS moves), so a re-mint only ever ADDS.
    const union = [...new Set([...persisted.sans, ...sans])].sort();
    const leaf = await mintLeaf(persisted.caCertPem, persisted.caKeyPem, union);
    persisted = { ...persisted, certPem: leaf.certPem, keyPem: leaf.keyPem, sans: union };
    await store.setServerTls(persisted);
    changed = "reminted-leaf";
  }

  return {
    mode: "self-signed",
    material: { cert: persisted.certPem, key: persisted.keyPem },
    ca: {
      pem: persisted.caCertPem,
      createdAt: persisted.createdAt,
      fingerprintSha256: certFingerprintSha256(persisted.caCertPem),
    },
    sans: persisted.sans,
    changed,
  };
}

/** API path of the CA download, relative to the API base (what HttpsInfo advertises). */
export const CA_DOWNLOAD_PATH = "/settings/https/ca.crt";

/**
 * The operator-facing HTTPS surface, GATED under /api/v1 (auto: the global preHandler):
 *   GET /api/v1/settings/https        → HttpsInfo (mode + SANs + CA metadata)
 *   GET /api/v1/settings/https/ca.crt → the CA certificate (PEM download; 404 outside self-signed)
 */
export function registerHttpsRoutes(fastify: FastifyInstance, runtime: ServerTlsRuntime): void {
  fastify.get("/api/v1/settings/https", async () =>
    HttpsInfo.parse({
      mode: runtime.mode,
      sans: runtime.sans,
      ca: runtime.ca
        ? {
            createdAt: runtime.ca.createdAt,
            fingerprintSha256: runtime.ca.fingerprintSha256,
            downloadPath: CA_DOWNLOAD_PATH,
          }
        : null,
    }),
  );

  fastify.get("/api/v1/settings/https/ca.crt", async (_request, reply) => {
    if (!runtime.ca) {
      return reply.code(404).send({ error: "no self-signed CA — the server is not in TLS_MODE=self-signed" });
    }
    return reply
      .header("content-type", "application/x-x509-ca-cert")
      .header("content-disposition", 'attachment; filename="polyptic-ca.crt"')
      .send(runtime.ca.pem);
  });
}
