/**
 * POL-25 — the mTLS CA + issuance layer, driven pure (no sockets). These run on ANY Bun: they
 * exercise the crypto, not the runtime's TLS verification (that lives in mtls-listener.test.ts
 * behind a capability gate).
 */
import "reflect-metadata";
import { describe, expect, test } from "bun:test";

import { AgentMtls } from "../src/mtls";
import { MemoryStore } from "../src/store/memory";

const x509 = await import("@peculiar/x509");
x509.cryptoProvider.set(globalThis.crypto);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

/** A CSR claiming an arbitrary CN — the server must IGNORE the claim and force its own. */
async function makeCsr(claimedCn: string): Promise<string> {
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${claimedCn}`,
    keys,
    signingAlgorithm: ALG,
  });
  return csr.toString("pem");
}

describe("AgentMtls CA lifecycle", () => {
  test("first init mints a CA and persists it; later inits reuse it", async () => {
    const store = new MemoryStore();
    const first = await AgentMtls.init(store, { port: 8443 });
    expect(first.caPem).toContain("BEGIN CERTIFICATE");

    const persisted = await store.getMtlsCa();
    expect(persisted?.certPem).toBe(first.caPem);
    expect(persisted?.keyPem).toContain("BEGIN PRIVATE KEY");

    // A restart must NOT re-key the fleet: same store → same CA.
    const second = await AgentMtls.init(store, { port: 8443 });
    expect(second.caPem).toBe(first.caPem);
  });

  test("the server leaf is CA-signed and carries the default + extra SANs", async () => {
    const store = new MemoryStore();
    const mtls = await AgentMtls.init(store, { port: 8443, sanHosts: ["walls.example.com", "10.0.0.7"] });
    const leaf = new x509.X509Certificate(mtls.serverCertPem);
    const ca = new x509.X509Certificate(mtls.caPem);
    expect(leaf.issuer).toBe(ca.subject);
    expect(await leaf.verify({ publicKey: await ca.publicKey.export() })).toBe(true);

    const san = leaf.getExtension(x509.SubjectAlternativeNameExtension);
    const names = san ? san.names.items.map((n) => n.value) : [];
    expect(names).toContain("localhost");
    expect(names).toContain("127.0.0.1");
    expect(names).toContain("walls.example.com");
    expect(names).toContain("10.0.0.7");
  });

  // POL-147 — the Traefik passthrough SNI host is what the box dials AND verifies against; it MUST
  // be a SAN on the leaf or the box rejects the handshake it just passed through Traefik. index.ts
  // funnels AGENT_MTLS_ADVERTISE_HOST into sanHosts; this pins that the leaf honours it.
  test("the server leaf carries the advertised SNI host as a SAN (the passthrough handshake validates)", async () => {
    const store = new MemoryStore();
    const mtls = await AgentMtls.init(store, { port: 8443, sanHosts: ["mtls.polyptic.example.com"] });
    const leaf = new x509.X509Certificate(mtls.serverCertPem);
    const san = leaf.getExtension(x509.SubjectAlternativeNameExtension);
    const names = san ? san.names.items.map((n) => n.value) : [];
    expect(names).toContain("mtls.polyptic.example.com");
  });
});

describe("AgentMtls.signCsr", () => {
  test("signs a valid CSR into a CA-chained client cert with CN FORCED to the machine id", async () => {
    const store = new MemoryStore();
    const mtls = await AgentMtls.init(store, { port: 8443 });
    // The CSR claims to be another machine — the identity must come from enrolment, not the CSR.
    const certPem = await mtls.signCsr(await makeCsr("some-other-machine"), "machine-1");
    const cert = new x509.X509Certificate(certPem);
    const ca = new x509.X509Certificate(mtls.caPem);
    expect(cert.subject).toBe("CN=machine-1");
    expect(cert.issuer).toBe(ca.subject);
    expect(await cert.verify({ publicKey: await ca.publicKey.export() })).toBe(true);
  });

  test("sanitises DN metacharacters in the machine id", async () => {
    const store = new MemoryStore();
    const mtls = await AgentMtls.init(store, { port: 8443 });
    const certPem = await mtls.signCsr(await makeCsr("x"), 'ev,il+cn="boss"');
    const cert = new x509.X509Certificate(certPem);
    expect(cert.subject).toBe("CN=ev_il_cn__boss_");
  });

  test("rejects garbage and forged CSRs", async () => {
    const store = new MemoryStore();
    const mtls = await AgentMtls.init(store, { port: 8443 });
    expect(mtls.signCsr("not a csr at all", "m1")).rejects.toThrow();
  });
});
