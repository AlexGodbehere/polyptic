/**
 * @polyptic/server — the control plane.
 *
 * Fastify (REST + CORS) on :8080, with three WebSocket channels (/agent, /player, /admin)
 * multiplexed onto the same HTTP server. The desired-state + registry live in a durable Store
 * (Postgres by default; in-memory test double via STORE=memory): loaded on boot, written through on
 * every mutation. A REST mutation bumps the revision and pushes a `server/render` straight to the
 * screen's player socket — the "instant" path — and broadcasts `admin/state` to admin clients.
 *
 * Dev runtime: Bun (ESM). Run with `bun run dev` from the repo root.
 */
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify from "fastify";

import { AdminBroadcaster, AdminHub, Presence } from "./admin";
import { AuthService, authConfigFromEnv } from "./auth-local";
import { registerAuthRoutes } from "./auth-routes";
import { Enrollment } from "./enroll";
import { AgentHub, PlayerHub } from "./hub";
import { registerRestRoutes } from "./rest";
import { ControlPlane } from "./state";
import { createStore } from "./store";
import { attachWebSockets } from "./ws";

import type { PersistedBootstrap } from "./store";
import type { FastifyReply, FastifyRequest } from "fastify";

/** API paths that authenticate themselves (or report their own 401) — excluded from the global gate. */
const AUTH_PUBLIC_PATHS = new Set([
  "/api/v1/auth/login",
  "/api/v1/auth/logout",
  "/api/v1/auth/me",
]);

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const CORS_ORIGIN = (
  process.env.CORS_ORIGIN ??
  // 5173 player, 5175 Vue console.
  "http://localhost:5173,http://localhost:5175"
)
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);
const PLAYER_BASE_URL = process.env.PLAYER_BASE_URL ?? "http://localhost:5173";

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

// ── Durable store: select by STORE env, run migrations, load persisted state ──
const { store, kind: storeKind } = createStore();
await store.migrate();

const control = new ControlPlane(store);
await control.init();

// ── Enrollment policy (Phase 2b/3f): seed the bootstrap from the store; on first boot derive it from
// POLYPTIC_BOOTSTRAP_TOKEN (set → gated, unset → open). The Settings "regenerate" mutates it later. ──
let bootstrap: PersistedBootstrap | undefined = await store.getBootstrap();
if (!bootstrap) {
  const envToken = process.env.POLYPTIC_BOOTSTRAP_TOKEN?.trim();
  bootstrap =
    envToken && envToken.length > 0
      ? { mode: "gated", token: envToken }
      : { mode: "open", token: null };
  await store.setBootstrap(bootstrap);
}
const enrollment = new Enrollment(bootstrap.token ?? undefined);

const hub = new PlayerHub();
const agentHub = new AgentHub();
const adminHub = new AdminHub();
const presence = new Presence();
const broadcaster = new AdminBroadcaster({ control, playerHub: hub, presence, adminHub, log: fastify.log });

await fastify.register(cors, {
  origin: CORS_ORIGIN,
  // PUT/DELETE (3a placement/murals), PATCH (3c content-sources + 3d scenes edits).
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // Required for the browser to send/receive the session cookie cross-origin (console on :5175).
  credentials: true,
});

// ── Local operator auth (Phase 3f / D29): argon2id passwords, signed http-only session cookies. ──
const authConfig = authConfigFromEnv();
await fastify.register(cookie, { secret: authConfig.cookieSecret });
const auth = new AuthService({ store, fastify, config: authConfig, log: fastify.log });

// Sweep any sessions that expired while the server was down, then seed an admin if none exist.
await store.deleteExpiredSessions(new Date().toISOString());
await auth.seedAdmin();

// THE GATE: require a valid session on every /api/v1/** route except the public auth endpoints. The
// device channels (/agent, /player), health/metrics and the WS upgrades are NOT /api/v1 and untouched.
fastify.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
  if (!auth.enabled) return;
  const path = request.url.split("?")[0] ?? request.url;
  if (!path.startsWith("/api/v1/")) return;
  if (AUTH_PUBLIC_PATHS.has(path)) return;
  await auth.requireAuth(request, reply);
});

registerAuthRoutes(fastify, auth, enrollment);
registerRestRoutes(fastify, control, hub, agentHub, broadcaster);
attachWebSockets({
  server: fastify.server,
  control,
  enrollment,
  auth,
  hub,
  agentHub,
  adminHub,
  presence,
  broadcaster,
  log: fastify.log,
  allowedOrigins: CORS_ORIGIN,
});

// Auth boot banner: secure by default; make the dev shortcuts loud.
if (!authConfig.enabled) {
  fastify.log.warn(
    { event: "auth.disabled" },
    "⚠️  AUTH IS DISABLED (AUTH_ENABLED=false): every /api/v1 route and the /admin WS are UNPROTECTED. " +
      "This is for tests/dev ONLY — never run a real deployment with auth disabled.",
  );
} else {
  if (authConfig.usingDevCookieSecret) {
    fastify.log.warn(
      { event: "auth.cookie.devsecret" },
      "⚠️  COOKIE_SECRET is unset — using a WELL-KNOWN DEV SECRET to sign session cookies. Set " +
        "COOKIE_SECRET to a long random value in any non-throwaway deployment.",
    );
  }
  if (!authConfig.secureCookies) {
    fastify.log.warn(
      { event: "auth.cookie.insecure" },
      "session cookies are NOT marked `secure` (SECURE_COOKIES unset / NODE_ENV≠production) so they " +
        "work over http on localhost — PRODUCTION MUST BE SERVED OVER HTTPS with SECURE_COOKIES=true.",
    );
  }
}

// Prominent boot banner: OPEN MODE auto-approves every agent (dev default) — make it loud.
if (enrollment.open) {
  fastify.log.warn(
    { event: "enrollment.open" },
    "⚠️  ENROLLMENT IS OPEN: POLYPTIC_BOOTSTRAP_TOKEN is unset — every agent that connects is " +
      "auto-registered AND auto-approved (Phase 2a behaviour). Set POLYPTIC_BOOTSTRAP_TOKEN to " +
      "require a bootstrap token + operator approval (gated enrollment).",
  );
} else {
  fastify.log.info(
    { event: "enrollment.gated" },
    "enrollment GATED: agents must present the bootstrap token (first contact) or a durable " +
      "credential; new machines appear pending and await operator approval.",
  );
}

async function shutdown(signal: string): Promise<void> {
  fastify.log.info({ event: "server.shutdown", signal }, "shutting down");
  try {
    await fastify.close();
  } catch (err) {
    fastify.log.warn({ event: "server.shutdown.error", err: String(err) }, "error closing fastify");
  }
  try {
    await store.close();
  } catch (err) {
    fastify.log.warn({ event: "store.close.error", err: String(err) }, "error closing store");
  }
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(
    {
      event: "server.listening",
      port: PORT,
      host: HOST,
      ws: ["/agent", "/player", "/admin"],
      corsOrigin: CORS_ORIGIN,
      playerBaseUrl: PLAYER_BASE_URL,
      store: storeKind,
      enrollment: enrollment.open ? "open" : "gated",
      revision: control.state.revision,
      screens: control.getScreens().length,
      machines: control.getMachines().length,
    },
    "polyptic control plane up",
  );
} catch (err) {
  fastify.log.error(err, "failed to start");
  process.exit(1);
}
