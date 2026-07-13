/**
 * mTLS agent identity (POL-25) — the deployment's own certificate authority + the dedicated
 * agent TLS listener.
 *
 * Phase 2b gave every machine a durable app-level credential; this module adds the deferred
 * transport layer (D12): a private, per-deployment CA whose client certificates gate a second,
 * TLS-terminating listener that serves ONLY the /agent WebSocket channel. The TLS handshake itself
 * (`requestCert` + `rejectUnauthorized` against our CA) is what rejects a wrong/absent/expired cert —
 * before any app-layer code runs. The app-level credential stays the per-machine identity; the cert
 * is the fleet-membership transport gate. Together they are strictly stronger than 2b alone.
 *
 * Issuance rides the 2b seam: any `agent/hello` that authenticates (bootstrap token or credential)
 * and carries a CSR gets it signed with CN forced to the machine id — the agent's private key never
 * crosses the wire. See `ws.ts` for the channel policy and `@polyptic/protocol`'s `MtlsBundle`.
 *
 * TRUST IS VERIFIED, NOT ASSUMED: `selfTest()` dials the live listener with no cert and with a
 * rogue-CA cert and demands the handshake FAIL both times (and pass with a genuine cert). This is
 * load-bearing — Bun ≤ 1.2 implemented `requestCert` as presence-only (ANY cert was accepted,
 * measured on 1.2.2), which would have made the whole feature security theater. A server whose
 * runtime cannot verify client certs must refuse to offer mTLS at all.
 *
 * Crypto: ECDSA P-256 via WebCrypto + `@peculiar/x509` (pure TS — no openssl shellouts). The
 * `reflect-metadata` import must land before `@peculiar/x509` is evaluated, and Bun mis-orders the
 * static-import case (measured on 1.2.2 and 1.3.14) — hence the dynamic import below.
 */
import "reflect-metadata";
import { createServer } from "node:https";
import { connect } from "node:tls";
import { isIP } from "node:net";
import { hostname } from "node:os";

import type { FastifyBaseLogger } from "fastify";
import type { Server } from "node:https";
import type { PersistedMtlsCa, Store } from "./store";

const x509 = await import("@peculiar/x509");
x509.cryptoProvider.set(globalThis.crypto);

/** ECDSA P-256 / SHA-256 everywhere — small keys, fast handshakes, universally supported. */
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

const YEAR_MS = 365 * 24 * 3600 * 1000;
/** CA lifetime. Rotating the CA re-keys the whole fleet (agents heal via the credential seam). */
const CA_VALIDITY_MS = 20 * YEAR_MS;
/** Server leaf lifetime. Regenerated on EVERY boot, so this only needs to outlive one uptime. */
const SERVER_CERT_VALIDITY_MS = 2 * YEAR_MS;
/** Client cert lifetime — the "durable" in POL-25. Agents renew via CSR inside the last 30 days. */
const CLIENT_CERT_VALIDITY_MS = 10 * YEAR_MS;

/** A random, positive X.509 serial (16 bytes hex, top bit cleared so DER stays positive). */
function randomSerial(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Export a WebCrypto private key as PKCS#8 PEM (what node:tls expects). */
async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey("pkcs8", key);
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64.trim()}\n-----END PRIVATE KEY-----\n`;
}

/** Import a PKCS#8 PEM back into a WebCrypto signing key. */
async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Buffer.from(b64, "base64");
  return crypto.subtle.importKey("pkcs8", der, ALG, true, ["sign"]);
}

/** The hosts baked into the server leaf's SANs — every name/IP an agent might dial. */
export interface ServerCertHosts {
  /** Extra hostnames/IPs (comma-split from `AGENT_MTLS_SANS` and the public URL envs). */
  extra: string[];
}

export interface AgentMtlsOptions {
  /** The port the dedicated agent TLS listener binds. */
  port: number;
  /** When set, `server/enrolled.mtls.url` carries this verbatim (`AGENT_MTLS_PUBLIC_URL`). */
  publicUrl?: string;
  /** Extra SAN hosts for the server leaf (`AGENT_MTLS_SANS` + hosts of the public URL envs). */
  sanHosts?: string[];
}

/**
 * The live mTLS state: the persisted CA + this boot's server leaf. Construct via `AgentMtls.init`.
 */
export class AgentMtls {
  private constructor(
    private readonly caKey: CryptoKey,
    private readonly caCert: InstanceType<typeof x509.X509Certificate>,
    /** PEM of the CA cert — the trust root agents pin and the listener's client-cert `ca`. */
    readonly caPem: string,
    /** This boot's server leaf (PEM), signed by the CA, SANs covering every dialable host. */
    readonly serverCertPem: string,
    readonly serverKeyPem: string,
    readonly options: AgentMtlsOptions,
  ) {}

  /**
   * Load the persisted CA (or mint one on the first mTLS boot) and issue this boot's server leaf.
   * The CA is written back exactly once; every subsequent boot reuses it so the fleet's client
   * certs stay valid across server restarts and re-deploys.
   */
  static async init(store: Store, options: AgentMtlsOptions, log?: FastifyBaseLogger): Promise<AgentMtls> {
    let persisted: PersistedMtlsCa | undefined = await store.getMtlsCa();
    if (!persisted) {
      const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
      const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: randomSerial(),
        name: "CN=Polyptic Agent CA",
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + CA_VALIDITY_MS),
        signingAlgorithm: ALG,
        keys,
        extensions: [
          new x509.BasicConstraintsExtension(true, 0, true),
          new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        ],
      });
      persisted = {
        certPem: cert.toString("pem"),
        keyPem: await exportPrivateKeyPem(keys.privateKey),
        createdAt: new Date().toISOString(),
      };
      await store.setMtlsCa(persisted);
      log?.info({ event: "mtls.ca.created" }, "mTLS: generated the deployment's agent CA (persisted to the store)");
    }

    const caCert = new x509.X509Certificate(persisted.certPem);
    const caKey = await importPrivateKeyPem(persisted.keyPem);

    // This boot's server leaf. SANs must cover every host an agent may dial — agents pin our CA but
    // still verify the hostname (measured: Bun's ws client enforces SAN matching).
    const sanNames = new Set<string>(["localhost", "127.0.0.1", "::1", hostname()]);
    for (const extra of options.sanHosts ?? []) {
      const trimmed = extra.trim();
      if (trimmed) sanNames.add(trimmed);
    }
    const serverKeys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const serverCert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: "CN=polyptic-agent-mtls",
      issuer: caCert.subject,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + SERVER_CERT_VALIDITY_MS),
      signingAlgorithm: ALG,
      publicKey: serverKeys.publicKey,
      signingKey: caKey,
      extensions: [
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension(
          [...sanNames].map((name) => (isIP(name) ? { type: "ip" as const, value: name } : { type: "dns" as const, value: name })),
        ),
      ],
    });

    return new AgentMtls(
      caKey,
      caCert,
      persisted.certPem,
      serverCert.toString("pem"),
      await exportPrivateKeyPem(serverKeys.privateKey),
      options,
    );
  }

  /**
   * Sign an agent's CSR into a durable client certificate. The CSR's self-signature is verified
   * (proof of key possession) and its public key is taken — but its SUBJECT is ignored: the CN is
   * forced to `machineId`, so a cert can never claim an identity its enrolment didn't authenticate.
   * Throws on a malformed/forged CSR; callers treat that as "no cert issued", never as fatal.
   */
  async signCsr(csrPem: string, machineId: string): Promise<string> {
    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    if (!(await csr.verify())) throw new Error("CSR self-signature is invalid");
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: `CN=${machineId.replace(/[,+"\\<>;=]/g, "_")}`,
      issuer: this.caCert.subject,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + CLIENT_CERT_VALIDITY_MS),
      signingAlgorithm: ALG,
      publicKey: csr.publicKey,
      signingKey: this.caKey,
      extensions: [
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
      ],
    });
    return cert.toString("pem");
  }

  /**
   * The HTTPS server the /agent mTLS channel attaches to. `requestCert` + `rejectUnauthorized`
   * against OUR CA is the transport-layer gate: a client that cannot present a cert chaining to the
   * deployment's CA never completes the handshake, so no frame of its ever reaches the app layer.
   */
  createListener(): Server {
    return createServer(
      {
        key: this.serverKeyPem,
        cert: this.serverCertPem,
        ca: this.caPem,
        requestCert: true,
        rejectUnauthorized: true,
      },
      // Plain HTTP requests get a legible brush-off — this listener only speaks the /agent WS
      // upgrade. Answering ALSO matters to `selfTest`: under TLS 1.3 a client's handshake "completes"
      // before the server has judged its cert (the rejection arrives as a post-handshake alert), so
      // the only trustworthy accept-signal is an application-layer round-trip like this response.
      (req, res) => {
        res.statusCode = 426;
        res.setHeader("content-type", "text/plain");
        res.end("polyptic mTLS agent channel — connect via WebSocket upgrade on /agent\n");
      },
    );
  }

  /**
   * Prove, against the LIVE listener, that the runtime actually verifies client certificates:
   *   1. a genuine CA-signed cert must complete the handshake (else the listener is just broken and
   *      would strand the whole fleet),
   *   2. NO cert must fail it,
   *   3. a rogue-CA cert (same CN, different issuer) must fail it.
   * Returns `{ safe: false }` with the reason when any check fails. Bun ≤ 1.2's `requestCert` was
   * presence-only (measured), which fails check 3 — the caller must then refuse to serve mTLS.
   */
  async selfTest(port: number, host = "127.0.0.1"): Promise<{ safe: boolean; reason?: string }> {
    // A genuine client cert, signed by the real CA — the positive control.
    const goodKeys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const goodCert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: "CN=mtls-self-test",
      issuer: this.caCert.subject,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3600_000),
      signingAlgorithm: ALG,
      publicKey: goodKeys.publicKey,
      signingKey: this.caKey,
      extensions: [new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth])],
    });

    // A rogue cert: identical shape, but chained to a CA the server has never seen.
    const rogueCaKeys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const rogueCa = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomSerial(),
      name: "CN=Rogue CA",
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3600_000),
      signingAlgorithm: ALG,
      keys: rogueCaKeys,
      extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
    });
    const rogueKeys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const rogueCert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: "CN=mtls-self-test",
      issuer: rogueCa.subject,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3600_000),
      signingAlgorithm: ALG,
      publicKey: rogueKeys.publicKey,
      signingKey: rogueCaKeys.privateKey,
      extensions: [new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth])],
    });

    // "Accepted" means the server ANSWERS US, not that `secureConnect` fired: under TLS 1.3 the
    // client's handshake completes a flight before the server judges its cert (rejection arrives as
    // a post-handshake alert), so the only trustworthy accept-signal is application data coming back.
    const handshake = (client: { keyPem?: string; certPem?: string }): Promise<boolean> =>
      new Promise((resolve) => {
        let answered = false;
        const socket = connect(
          {
            host,
            port,
            // We are testing the SERVER's verification, so the probe client trusts anything.
            rejectUnauthorized: false,
            ...(client.keyPem ? { key: client.keyPem } : {}),
            ...(client.certPem ? { cert: client.certPem } : {}),
          },
          () => {
            socket.write(`GET /mtls-self-test HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
          },
        );
        const finish = (ok: boolean) => {
          if (answered) return;
          answered = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), 5_000);
        socket.on("data", () => finish(true));
        socket.on("error", () => finish(false));
        socket.on("close", () => finish(false));
      });

    const goodOk = await handshake({
      keyPem: await exportPrivateKeyPem(goodKeys.privateKey),
      certPem: goodCert.toString("pem"),
    });
    if (!goodOk) {
      return { safe: false, reason: "a genuine CA-signed client cert failed the handshake — the listener is broken" };
    }
    const noneOk = await handshake({});
    if (noneOk) {
      return { safe: false, reason: "a client with NO certificate completed the handshake — the runtime does not enforce requestCert" };
    }
    const rogueOk = await handshake({
      keyPem: await exportPrivateKeyPem(rogueKeys.privateKey),
      certPem: rogueCert.toString("pem"),
    });
    if (rogueOk) {
      return {
        safe: false,
        reason:
          "a client cert from an UNKNOWN CA completed the handshake — the runtime does not verify client certs " +
          "(Bun ≤ 1.2 behaves this way; run the server on Bun ≥ 1.3)",
      };
    }
    return { safe: true };
  }
}
