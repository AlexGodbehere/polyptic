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
import cors from "@fastify/cors";
import Fastify from "fastify";

import { AdminBroadcaster, AdminHub, Presence } from "./admin";
import { Enrollment } from "./enroll";
import { AgentHub, PlayerHub } from "./hub";
import { registerRestRoutes } from "./rest";
import { ControlPlane } from "./state";
import { createStore } from "./store";
import { attachWebSockets } from "./ws";

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

// ── Enrollment policy (Phase 2b): OPEN MODE when POLYPTIC_BOOTSTRAP_TOKEN is unset. ──
const enrollment = Enrollment.fromEnv();

const hub = new PlayerHub();
const agentHub = new AgentHub();
const adminHub = new AdminHub();
const presence = new Presence();
const broadcaster = new AdminBroadcaster({ control, playerHub: hub, presence, adminHub, log: fastify.log });

await fastify.register(cors, {
  origin: CORS_ORIGIN,
  // PUT/DELETE added in Phase 3a for the console's placement + mural routes.
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
});

registerRestRoutes(fastify, control, hub, agentHub, broadcaster);
attachWebSockets({
  server: fastify.server,
  control,
  enrollment,
  hub,
  agentHub,
  adminHub,
  presence,
  broadcaster,
  log: fastify.log,
});

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
