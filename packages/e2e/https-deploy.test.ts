/**
 * HTTPS as the default deployment posture — POL-70/D89.
 *
 * The chart's promise: name a host on either ingress and the deployment comes out HTTPS end to end
 * — a tls block on the Ingress, PUBLIC_BASE_URL/CORS_ORIGIN/PLAYER_BASE_URL/MEDIA_PUBLIC_BASE all
 * derived https from that ONE hostname, and (server-side) Secure session cookies keyed off the
 * https PUBLIC_BASE_URL. Opting OUT (ingress.tls.enabled=false, or an http:// publicBaseUrl) keeps
 * everything working — plain-HTTP homelabs are a supported degrade, never a refusal — but the http
 * scheme flows through so the server drops the cookie Secure flag (POL-43: a Secure cookie over
 * plain http is silently dropped by browsers → login "succeeds", nothing persists) and warns.
 *
 * Two layers of pinning, boot-splash style:
 *   - file pins on values.yaml/_helpers.tpl/configmap.yaml — the seams themselves, run everywhere;
 *   - real `helm template` renders in the four postures — run wherever helm is installed (CI +
 *     dev boxes), skipped cleanly elsewhere.
 *
 * The netboot depot is OUT of scope by contract: GRUB has no TLS stack (D47), so boot media bake
 * plain-http bases (ingressRoute.bootHost) no matter what the operator surface serves.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p: string[]): string => readFileSync(resolve(repoRoot, ...p), "utf8");
const CHART_DIR = resolve(repoRoot, "deploy", "helm", "polyptic");

const VALUES = read("deploy", "helm", "polyptic", "values.yaml");
const HELPERS = read("deploy", "helm", "polyptic", "templates", "_helpers.tpl");
const CONFIGMAP = read("deploy", "helm", "polyptic", "templates", "configmap.yaml");

describe("the chart's TLS seams (file pins)", () => {
  test("enabling the ingress means TLS unless explicitly opted out — tls.enabled defaults true", () => {
    // The one-line heart of "HTTPS by default". A regression here silently ships plain-HTTP
    // operator logins to everyone who just sets ingress.enabled + a host.
    const ingressBlock = VALUES.slice(VALUES.indexOf("\ningress:"), VALUES.indexOf("\nresources:"));
    expect(ingressBlock).toContain("enabled: true");
    expect(ingressBlock).toMatch(/tls:\n(\s+#.*\n)*\s+enabled: true/);
  });

  test("secureCookies defaults to AUTO (empty), not a hardcoded boolean", () => {
    // "" lets the server derive Secure from PUBLIC_BASE_URL's scheme; a hardcoded `true` is the
    // pre-POL-70 world where a plain-HTTP homelab silently loses every login (POL-43).
    expect(VALUES).toMatch(/\n {2}secureCookies: ""\n/);
  });

  test("ONE public origin drives the four origin-shaped envs", () => {
    expect(HELPERS).toContain('{{- define "polyptic.publicBaseUrl" -}}');
    // Every consumer derives from it…
    for (const helper of ["polyptic.corsOrigin", "polyptic.mediaPublicBase", "polyptic.playerBaseUrl"]) {
      const body = HELPERS.slice(HELPERS.indexOf(`{{- define "${helper}" -}}`));
      expect(body.slice(0, body.indexOf("{{- end }}"))).toContain('include "polyptic.publicBaseUrl"');
    }
    // …and the configmap emits it for the server's cookie derivation.
    expect(CONFIGMAP).toContain("PUBLIC_BASE_URL:");
    // SECURE_COOKIES is emitted ONLY on explicit override.
    expect(CONFIGMAP).toMatch(/\{\{- if ne \(toString \.Values\.config\.secureCookies\) "" \}\}[\s\S]*?SECURE_COOKIES:/);
  });
});

// ── Real renders: the four postures, wherever helm exists. ──────────────────────────────────────
const helmAvailable = spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0;

/** Render the chart with `--set` pairs; returns the full multi-doc YAML text. */
function render(...sets: string[]): string {
  const args = ["template", "test", CHART_DIR, ...sets.flatMap((s) => ["--set", s])];
  const out = spawnSync("helm", args, { encoding: "utf8" });
  expect(out.status).toBe(0);
  return out.stdout;
}

describe.skipIf(!helmAvailable)("helm template — the four TLS postures", () => {
  test("ingress + host → tls block AND an all-https configmap, from one hostname", () => {
    const doc = render("ingress.enabled=true", "ingress.host=walls.example.org");
    expect(doc).toContain("secretName: polyptic-tls");
    expect(doc).toContain('PUBLIC_BASE_URL: "https://walls.example.org"');
    expect(doc).toContain('CORS_ORIGIN: "https://walls.example.org"');
    expect(doc).toContain('PLAYER_BASE_URL: "https://walls.example.org/player"');
    expect(doc).toContain('MEDIA_PUBLIC_BASE: "https://walls.example.org"');
    // AUTO cookie mode: no SECURE_COOKIES env — the server derives Secure from the https base.
    expect(doc).not.toContain("SECURE_COOKIES:");
  });

  test("ingress with TLS opted out → no tls block, and the http scheme flows through honestly", () => {
    const doc = render("ingress.enabled=true", "ingress.host=walls.example.org", "ingress.tls.enabled=false");
    expect(doc).not.toContain("secretName: polyptic-tls");
    // Declaring http:// is what makes the server drop the cookie Secure flag + warn (POL-43).
    expect(doc).toContain('PUBLIC_BASE_URL: "http://walls.example.org"');
    expect(doc).toContain('PLAYER_BASE_URL: "http://walls.example.org/player"');
  });

  test("Traefik IngressRoute host → https everywhere (websecure by design)", () => {
    const doc = render("ingressRoute.enabled=true", "ingressRoute.host=walls.corp");
    expect(doc).toContain('PUBLIC_BASE_URL: "https://walls.corp"');
    expect(doc).toContain('CORS_ORIGIN: "https://walls.corp"');
    // The boot depot stays PLAIN HTTP by contract (GRUB has no TLS): the boot router renders.
    expect(doc).toContain("Host(`boot.polyptic.example.com`)");
  });

  test("no ingress, nothing set → pre-POL-70 output exactly (don't break existing deployments)", () => {
    const doc = render();
    // No derivable origin: no PUBLIC_BASE_URL, no SECURE_COOKIES (NODE_ENV=production keeps
    // Secure cookies on, same effective default as the old hardcoded `true`), placeholders intact.
    expect(doc).not.toContain("PUBLIC_BASE_URL:");
    expect(doc).not.toContain("SECURE_COOKIES:");
    expect(doc).toContain('CORS_ORIGIN: "https://polyptic.example.com"');
    expect(doc).toContain('PLAYER_BASE_URL: "https://polyptic.example.com/player"');
    expect(doc).toContain('NODE_ENV: "production"');
  });

  test("letsEncrypt + a host + an email → Issuer + Certificate into the ingress's TLS secret, subchart included", () => {
    const doc = render(
      "ingress.enabled=true",
      "ingress.host=walls.example.org",
      "letsEncrypt.enabled=true",
      "letsEncrypt.email=ops@example.org",
    );
    expect(doc).toContain("kind: Issuer");
    expect(doc).toContain("server: https://acme-v02.api.letsencrypt.org/directory");
    expect(doc).toContain("email: ops@example.org");
    // The Certificate writes the exact secret the Ingress already references — no manual secret.
    expect(doc).toMatch(/kind: Certificate\nmetadata:\n  name: polyptic-tls/);
    expect(doc).toMatch(/dnsNames:\s*\n\s*- walls\.example\.org/);
    expect(doc).toContain("class: traefik"); // the http01 solver's ingress class (K3s default)
    // The vendored cert-manager subchart rendered alongside (condition-gated dependency).
    expect(doc).toContain("app.kubernetes.io/name: cert-manager");
  });

  test("letsEncrypt staging flag flips the ACME endpoint", () => {
    const doc = render(
      "ingress.enabled=true",
      "ingress.host=walls.example.org",
      "letsEncrypt.enabled=true",
      "letsEncrypt.email=ops@example.org",
      "letsEncrypt.staging=true",
    );
    expect(doc).toContain("server: https://acme-staging-v02.api.letsencrypt.org/directory");
  });

  test("letsEncrypt guards: no email and no host both refuse with a legible message", () => {
    const noEmail = spawnSync(
      "helm",
      [
        "template",
        "t",
        CHART_DIR,
        "--set",
        "ingress.enabled=true",
        "--set",
        "ingress.host=x.org",
        "--set",
        "letsEncrypt.enabled=true",
      ],
      { encoding: "utf8" },
    );
    expect(noEmail.status).not.toBe(0);
    expect(noEmail.stderr).toContain("letsEncrypt.email is required");

    const noHost = spawnSync(
      "helm",
      ["template", "t", CHART_DIR, "--set", "letsEncrypt.enabled=true", "--set", "letsEncrypt.email=a@b.c"],
      { encoding: "utf8" },
    );
    expect(noHost.status).not.toBe(0);
    expect(noHost.stderr).toContain("needs a public host");
  });

  test("tls.mode=self-signed → TLS_MODE + derived TLS_SANS in the configmap, probes flip to HTTPS", () => {
    const doc = render("tls.mode=self-signed", "config.publicBaseUrl=https://walls.home:8443");
    expect(doc).toContain('TLS_MODE: "self-signed"');
    // SANs: the public host (port stripped) + the in-cluster Service DNS names.
    expect(doc).toContain('TLS_SANS: "walls.home,test-polyptic,test-polyptic.default,test-polyptic.default.svc"');
    // kubelet must probe https now (it skips cert verification, so self-signed is fine).
    expect(doc.match(/scheme: HTTPS/g)?.length).toBe(2); // liveness + readiness
    // And an https publicBaseUrl still drives the derived origins + Secure cookies server-side.
    expect(doc).toContain('PUBLIC_BASE_URL: "https://walls.home:8443"');
  });

  test("self-signed and letsEncrypt together refuse (one terminates in the pod, one at the ingress)", () => {
    const out = spawnSync(
      "helm",
      ["template", "t", CHART_DIR, "--set", "tls.mode=self-signed", "--set", "letsEncrypt.enabled=true"],
      { encoding: "utf8" },
    );
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("mutually exclusive");
  });

  test("explicit values still beat every derivation (the escape hatches hold)", () => {
    const doc = render(
      "ingress.enabled=true",
      "ingress.host=walls.example.org",
      "config.publicBaseUrl=https://outside.example.net",
      "config.corsOrigin=https://console.dev.example.net",
      "config.secureCookies=false",
    );
    expect(doc).toContain('PUBLIC_BASE_URL: "https://outside.example.net"');
    expect(doc).toContain('CORS_ORIGIN: "https://console.dev.example.net"');
    expect(doc).toContain('PLAYER_BASE_URL: "https://outside.example.net/player"');
    expect(doc).toContain('SECURE_COOKIES: "false"');
  });
});
