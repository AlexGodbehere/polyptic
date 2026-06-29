/**
 * @polyptych/server — the control plane.
 *
 * Fastify (REST + CORS) on :8080, with two WebSocket channels (/agent, /player) multiplexed onto
 * the same HTTP server. Holds the in-memory desired-state; a REST mutation bumps the revision and
 * pushes a `server/render` straight to the screen's player socket — the "instant" path.
 *
 * Dev runtime: Bun (ESM). Run with `bun run dev` from the repo root.
 */
import cors from "@fastify/cors";
import Fastify from "fastify";

import { PlayerHub } from "./hub";
import { registerRestRoutes } from "./rest";
import { ControlPlane } from "./state";
import { attachWebSockets } from "./ws";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const PLAYER_BASE_URL = process.env.PLAYER_BASE_URL ?? "http://localhost:5173";

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

const control = new ControlPlane();
const hub = new PlayerHub();

await fastify.register(cors, {
  origin: CORS_ORIGIN,
  methods: ["GET", "POST", "OPTIONS"],
});

registerRestRoutes(fastify, control, hub);
attachWebSockets({ server: fastify.server, control, hub, log: fastify.log });

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(
    {
      event: "server.listening",
      port: PORT,
      host: HOST,
      ws: ["/agent", "/player"],
      corsOrigin: CORS_ORIGIN,
      playerBaseUrl: PLAYER_BASE_URL,
    },
    "polyptych control plane up",
  );
} catch (err) {
  fastify.log.error(err, "failed to start");
  process.exit(1);
}
