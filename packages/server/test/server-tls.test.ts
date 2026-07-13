/**
 * POL-70/D89 — the self-signed server TLS machinery + its operator surface.
 *
 * The load-bearing property is PERSISTENCE: the operator trusts the CA once per device, so a boot
 * must never re-mint it (a fresh CA re-warns every browser). The leaf may be re-minted — but only
 * from the SAME CA, only when the SAN set grew or expiry nears, and only ever ADDING names. The
 * env contract refuses every half-configured combination, and the settings routes expose the CA
 * download exactly when a self-signed CA exists.
 */
import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import Fastify from "fastify";

import { MemoryStore } from "../src/store/memory";
import {
  CA_DOWNLOAD_PATH,
  certFingerprintSha256,
  initSelfSignedTls,
  registerHttpsRoutes,
  requiredSans,
  resolveTlsEnv,
} from "../src/server-tls";

describe("resolveTlsEnv — the mode contract", () => {
  test("nothing set → off", () => {
    expect(resolveTlsEnv({})).toEqual({ mode: "off" });
  });

  test("both cert files → provided", () => {
    expect(resolveTlsEnv({ TLS_CERT_FILE: "/a.pem", TLS_KEY_FILE: "/b.pem" })).toEqual({
      mode: "provided",
      certFile: "/a.pem",
      keyFile: "/b.pem",
    });
  });

  test("TLS_MODE=self-signed → self-signed (case/space tolerant)", () => {
    expect(resolveTlsEnv({ TLS_MODE: " Self-Signed " }).mode).toBe("self-signed");
  });

  test("half a cert pair refuses — asking for TLS must never silently yield plain HTTP", () => {
    expect(() => resolveTlsEnv({ TLS_CERT_FILE: "/a.pem" })).toThrow(/TOGETHER/);
    expect(() => resolveTlsEnv({ TLS_KEY_FILE: "/b.pem" })).toThrow(/TOGETHER/);
  });

  test("self-signed + cert files is a refused CONFLICT, not a precedence puzzle", () => {
    expect(() =>
      resolveTlsEnv({ TLS_MODE: "self-signed", TLS_CERT_FILE: "/a.pem", TLS_KEY_FILE: "/b.pem" }),
    ).toThrow(/conflicts/);
  });

  test("an unknown TLS_MODE refuses with the supported modes named", () => {
    expect(() => resolveTlsEnv({ TLS_MODE: "acme" })).toThrow(/self-signed/);
  });
});

describe("requiredSans — what the certificate must answer for", () => {
  test("includes loopbacks, the PUBLIC_BASE_URL host, and TLS_SANS", () => {
    const sans = requiredSans({
      PUBLIC_BASE_URL: "https://walls.home:8443",
      TLS_SANS: "polyptic.svc, 10.0.0.5",
    });
    for (const expected of ["localhost", "127.0.0.1", "::1", "walls.home", "polyptic.svc", "10.0.0.5"]) {
      expect(sans).toContain(expected);
    }
  });

  test("a garbage PUBLIC_BASE_URL contributes nothing (TLS_SANS is the escape hatch)", () => {
    const sans = requiredSans({ PUBLIC_BASE_URL: "not a url" });
    expect(sans).toContain("localhost");
    expect(sans).not.toContain("not a url");
  });
});

describe("initSelfSignedTls — mint once, reuse forever", () => {
  test("first boot mints CA + leaf and persists; second boot reuses BOTH byte-for-byte", async () => {
    const store = new MemoryStore();
    const sans = ["localhost", "walls.home"];

    const first = await initSelfSignedTls(store, sans);
    expect(first.changed).toBe("minted-ca");
    expect(first.mode).toBe("self-signed");
    expect(first.material?.cert).toContain("BEGIN CERTIFICATE");
    expect(first.ca?.pem).toContain("BEGIN CERTIFICATE");
    expect(first.sans).toEqual(sans);

    const second = await initSelfSignedTls(store, sans);
    // THE point: re-minting on boot would re-warn every browser that trusted the CA.
    expect(second.changed).toBe("none");
    expect(second.material?.cert).toBe(first.material?.cert ?? "");
    expect(second.material?.key).toBe(first.material?.key ?? "");
    expect(second.ca?.pem).toBe(first.ca?.pem ?? "");
  });

  test("a NEW required SAN re-mints the LEAF from the SAME CA, unioning names", async () => {
    const store = new MemoryStore();
    const first = await initSelfSignedTls(store, ["localhost"]);
    const second = await initSelfSignedTls(store, ["localhost", "walls.home"]);

    expect(second.changed).toBe("reminted-leaf");
    expect(second.ca?.pem).toBe(first.ca?.pem ?? ""); // trust survives
    expect(second.material?.cert).not.toBe(first.material?.cert ?? "");
    expect(second.sans).toEqual(["localhost", "walls.home"]);

    // A later boot dialled by only ONE of the names keeps the union — re-mints never drop names.
    const third = await initSelfSignedTls(store, ["localhost"]);
    expect(third.changed).toBe("none");
    expect(third.sans).toEqual(["localhost", "walls.home"]);
  });

  test("the CA fingerprint is a stable SHA-256 colon-hex", async () => {
    const store = new MemoryStore();
    const rt = await initSelfSignedTls(store, ["localhost"]);
    expect(rt.ca?.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(rt.ca?.fingerprintSha256).toBe(certFingerprintSha256(rt.ca?.pem ?? ""));
  });
});

describe("the /api/v1/settings/https surface", () => {
  /** Real sockets, repo style (light-my-request's inject is broken under Bun — `response._header`). */
  async function listen(fastify: ReturnType<typeof Fastify>): Promise<string> {
    await fastify.listen({ port: 0, host: "127.0.0.1" });
    const addr = fastify.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  test("self-signed mode: info carries the CA + the download answers PEM with a .crt filename", async () => {
    const store = new MemoryStore();
    const runtime = await initSelfSignedTls(store, ["localhost"]);
    const fastify = Fastify();
    registerHttpsRoutes(fastify, runtime);
    const base = await listen(fastify);

    const info = await fetch(`${base}/api/v1/settings/https`);
    expect(info.status).toBe(200);
    const body = (await info.json()) as {
      mode: string;
      sans: string[];
      ca: { downloadPath: string; fingerprintSha256: string };
    };
    expect(body.mode).toBe("self-signed");
    expect(body.sans).toEqual(["localhost"]);
    expect(body.ca.downloadPath).toBe(CA_DOWNLOAD_PATH);

    const dl = await fetch(`${base}/api/v1/settings/https/ca.crt`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type") ?? "").toContain("application/x-x509-ca-cert");
    expect(dl.headers.get("content-disposition") ?? "").toContain('filename="polyptic-ca.crt"');
    expect(await dl.text()).toBe(runtime.ca?.pem ?? "");
    await fastify.close();
  });

  test("off/provided modes: ca is null and the download is a 404 (no CA to hand out)", async () => {
    for (const runtime of [
      { mode: "off" as const, sans: [] },
      { mode: "provided" as const, material: { cert: "x", key: "y" }, sans: [] },
    ]) {
      const fastify = Fastify();
      registerHttpsRoutes(fastify, runtime);
      const base = await listen(fastify);
      const info = (await (await fetch(`${base}/api/v1/settings/https`)).json()) as { mode: string; ca: unknown };
      expect(info.mode).toBe(runtime.mode);
      expect(info.ca).toBeNull();
      const dl = await fetch(`${base}/api/v1/settings/https/ca.crt`);
      expect(dl.status).toBe(404);
      await fastify.close();
    }
  });

  test("the minted material actually terminates TLS — https round-trip on a real socket", async () => {
    const store = new MemoryStore();
    const runtime = await initSelfSignedTls(store, ["localhost", "127.0.0.1"]);
    const fastify = Fastify({ https: { cert: runtime.material?.cert ?? "", key: runtime.material?.key ?? "" } } as never);
    fastify.get("/healthz", async () => ({ ok: true }));
    await fastify.listen({ port: 0, host: "127.0.0.1" });
    const addr = fastify.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await fetch(`https://127.0.0.1:${port}/healthz`, {
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    expect(res.status).toBe(200);
    await fastify.close();
  });
});
