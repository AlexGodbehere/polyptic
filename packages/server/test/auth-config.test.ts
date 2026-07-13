/**
 * authConfigFromEnv — the SECURE_COOKIES precedence contract (POL-43, then POL-70/D88).
 *
 * The documented rule: an EXPLICIT SECURE_COOKIES always wins; then the DECLARED public scheme
 * (PUBLIC_BASE_URL) decides; NODE_ENV=production is only the default when neither speaks. The
 * original implementation OR'd SECURE_COOKIES with NODE_ENV, so a plain-HTTP production deploy
 * still stamped `Secure` on the session cookie — which browsers silently drop over http, so login
 * "succeeded" but nothing persisted (POL-43). POL-70 makes an https PUBLIC_BASE_URL turn Secure ON
 * with zero extra knobs, and a declared-http one turn it OFF (same silent-login-failure otherwise).
 */
import { describe, expect, test } from "bun:test";

import { authConfigFromEnv } from "../src/auth-local";

describe("authConfigFromEnv secureCookies", () => {
  test("explicit SECURE_COOKIES=false beats NODE_ENV=production (the plain-HTTP deploy case)", () => {
    expect(authConfigFromEnv({ SECURE_COOKIES: "false", NODE_ENV: "production" }).secureCookies).toBe(false);
  });

  test("explicit SECURE_COOKIES=true works outside production", () => {
    expect(authConfigFromEnv({ SECURE_COOKIES: "true", NODE_ENV: "development" }).secureCookies).toBe(true);
  });

  test("unset SECURE_COOKIES defaults from NODE_ENV", () => {
    expect(authConfigFromEnv({ NODE_ENV: "production" }).secureCookies).toBe(true);
    expect(authConfigFromEnv({ NODE_ENV: "development" }).secureCookies).toBe(false);
    expect(authConfigFromEnv({}).secureCookies).toBe(false);
  });

  test("empty/whitespace SECURE_COOKIES counts as unset, not as false", () => {
    expect(authConfigFromEnv({ SECURE_COOKIES: "", NODE_ENV: "production" }).secureCookies).toBe(true);
    expect(authConfigFromEnv({ SECURE_COOKIES: "  ", NODE_ENV: "production" }).secureCookies).toBe(true);
  });

  // ── POL-70/D88: the declared public scheme decides when SECURE_COOKIES is unset. ──

  test("an https PUBLIC_BASE_URL turns Secure ON with no other knobs (the TLS default path)", () => {
    expect(authConfigFromEnv({ PUBLIC_BASE_URL: "https://walls.example.org" }).secureCookies).toBe(true);
    expect(authConfigFromEnv({ PUBLIC_BASE_URL: "https://walls.example.org" }).publicScheme).toBe("https");
  });

  test("a declared-http PUBLIC_BASE_URL turns Secure OFF even under NODE_ENV=production (POL-43 degrade)", () => {
    // Secure cookies over plain HTTP are silently dropped by browsers — login "succeeds", no
    // session persists. A deployment that DECLARES itself plain-http must not set the flag.
    const cfg = authConfigFromEnv({ PUBLIC_BASE_URL: "http://10.0.0.5:8080", NODE_ENV: "production" });
    expect(cfg.secureCookies).toBe(false);
    expect(cfg.publicScheme).toBe("http");
  });

  test("explicit SECURE_COOKIES still beats PUBLIC_BASE_URL, both ways", () => {
    expect(
      authConfigFromEnv({ SECURE_COOKIES: "false", PUBLIC_BASE_URL: "https://walls.example.org" }).secureCookies,
    ).toBe(false);
    expect(
      authConfigFromEnv({ SECURE_COOKIES: "true", PUBLIC_BASE_URL: "http://10.0.0.5:8080" }).secureCookies,
    ).toBe(true);
  });

  test("a garbage or non-http(s) PUBLIC_BASE_URL is ignored — NODE_ENV decides as before", () => {
    expect(authConfigFromEnv({ PUBLIC_BASE_URL: "not a url", NODE_ENV: "production" }).secureCookies).toBe(true);
    expect(authConfigFromEnv({ PUBLIC_BASE_URL: "ftp://x", NODE_ENV: "production" }).secureCookies).toBe(true);
    expect(authConfigFromEnv({ PUBLIC_BASE_URL: "not a url" }).publicScheme).toBeNull();
  });
});
