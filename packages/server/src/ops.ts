/**
 * Operational endpoints (Phase 5) — TOP-LEVEL, deliberately NOT under /api/v1 so they are UNgated by
 * the operator-session gate (scrapers / liveness probes carry no cookie):
 *
 *   GET /healthz  → JSON liveness/readiness: { status, revision, uptimeSec, store, ... }.
 *   GET /metrics  → Prometheus text exposition (hand-formatted, no client dependency).
 *
 * Counts are read live from the ControlPlane (registry), the hubs (live sockets) and the ThumbnailStore.
 * `polyptic_revision` is the desired-state revision (a meaningful monotonic gauge); the build/version
 * strings ride as labels on `polyptic_build_info` (Prometheus values must be numeric).
 */
import type { FastifyInstance } from "fastify";

import type { ThumbnailStore } from "./capture";
import type { AgentHub, PlayerHub } from "./hub";
import type { ControlPlane } from "./state";

export interface OpsDeps {
  control: ControlPlane;
  agentHub: AgentHub;
  playerHub: PlayerHub;
  thumbnails: ThumbnailStore;
  /** Store backend in use ("postgres" | "memory"), surfaced for health/diagnostics. */
  storeKind: string;
  /** Build version string (e.g. semver / image tag). */
  version: string;
  /** Build revision (git sha or "dev"). */
  revision: string;
  /** Process start time (ms epoch) for uptime. */
  startedAt: number;
}

/** Escape a Prometheus label value (backslash, double-quote, newline). */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** A single Prometheus gauge block: HELP + TYPE + one sample line. */
function gauge(name: string, help: string, value: number, labels?: Record<string, string>): string {
  const labelStr =
    labels && Object.keys(labels).length > 0
      ? `{${Object.entries(labels)
          .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
          .join(",")}}`
      : "";
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name}${labelStr} ${value}\n`;
}

export function registerOpsRoutes(fastify: FastifyInstance, deps: OpsDeps): void {
  const { control, agentHub, playerHub, thumbnails, storeKind, version, revision, startedAt } = deps;

  // GET /healthz — liveness/readiness; intentionally cheap and dependency-light.
  fastify.get("/healthz", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return {
      status: "ok",
      revision,
      version,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      store: storeKind,
      stateRevision: control.state.revision,
    };
  });

  // GET /metrics — Prometheus text exposition format v0.0.4.
  fastify.get("/metrics", async (_request, reply) => {
    const agentsConnected = agentHub.machineCount();
    const playersConnected = playerHub.screenCount();
    const machinesTotal = control.getMachines().length;
    const screensTotal = control.getScreens().length;
    const thumbnailsStored = thumbnails.size;

    const body =
      gauge("polyptic_build_info", "Build metadata; constant 1, version/revision as labels.", 1, {
        version,
        revision,
      }) +
      gauge(
        "polyptic_revision",
        "Current desired-state revision (increments on every applied change).",
        control.state.revision,
      ) +
      gauge(
        "polyptic_agents_connected",
        "Machines with at least one live agent WebSocket.",
        agentsConnected,
      ) +
      gauge(
        "polyptic_players_connected",
        "Screens with at least one live player WebSocket.",
        playersConnected,
      ) +
      gauge("polyptic_machines_total", "Machines in the registry.", machinesTotal) +
      gauge("polyptic_screens_total", "Screens in the registry.", screensTotal) +
      gauge(
        "polyptic_thumbnails_stored",
        "Live-preview thumbnails currently held in memory.",
        thumbnailsStored,
      );

    reply.header("Cache-Control", "no-store");
    reply.type("text/plain; version=0.0.4; charset=utf-8");
    return body;
  });
}
