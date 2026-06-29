/**
 * Live-preview capture coordination (Phase 5).
 *
 * Two pieces:
 *   - `ThumbnailStore` — a bounded, in-memory LRU of the latest decoded screenshot per screenId.
 *                        Holds raw bytes (decoded from the agent's base64), the mime type, and when it
 *                        was taken. Capped (a few hundred entries) so a large fleet can't grow it
 *                        unbounded; the oldest entry is evicted first.
 *   - `CaptureCoordinator` — drives capture. On an interval (CAPTURE_INTERVAL_MS, default 4000; set 0
 *                        to disable) it asks every CONNECTED agent (via the AgentHub) to screenshot its
 *                        outputs by sending `server/capture`. It also exposes `captureNow(machineId?)`
 *                        for on-demand refreshes. Inbound `agent/thumbnail` frames are handed to
 *                        `ingest()` (already zod-parsed at the WS edge): the (machineId, connector) pair
 *                        is resolved to a screenId via the ControlPlane and the decoded bytes are stored.
 *
 * Capture content NEVER routes through the player path — it is an out-of-band, agent→server→operator
 * preview only. The contract (`ServerToAgentCapture`, `AgentThumbnail`) is reused unchanged.
 */
import { ServerToAgentCapture } from "@polyptic/protocol";
import type { AgentMessage } from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";

/** The inbound thumbnail frame (already validated as part of AgentMessage at the WS edge). */
type AgentThumbnail = Extract<AgentMessage, { t: "agent/thumbnail" }>;

import type { AgentHub } from "./hub";
import type { ControlPlane } from "./state";

/** The latest screenshot held for one screen. */
export interface StoredThumbnail {
  /** Decoded image bytes (from the agent's base64). */
  bytes: Buffer;
  /** Reported mime, e.g. "image/jpeg". */
  mime: string;
  /** When the agent captured it (server receive time, ISO-8601). */
  takenAt: string;
}

/** Default cap on stored thumbnails — generous for a wall fleet, bounded so memory can't run away. */
const DEFAULT_CAPACITY = 300;

/**
 * Bounded LRU of the latest thumbnail per screenId. A `set` refreshes recency; once over capacity the
 * least-recently-stored screen is evicted. Reads do not change recency (a preview poll shouldn't pin an
 * otherwise-stale screen in the cache).
 */
export class ThumbnailStore {
  private readonly byScreen = new Map<string, StoredThumbnail>();

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity > 0 ? Math.floor(capacity) : DEFAULT_CAPACITY;
  }

  set(screenId: string, thumb: StoredThumbnail): void {
    // Re-insert to move to the end (most-recent) of the Map's insertion order.
    if (this.byScreen.has(screenId)) this.byScreen.delete(screenId);
    this.byScreen.set(screenId, thumb);
    // Evict oldest while over capacity.
    while (this.byScreen.size > this.capacity) {
      const oldest = this.byScreen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.byScreen.delete(oldest);
    }
  }

  get(screenId: string): StoredThumbnail | undefined {
    return this.byScreen.get(screenId);
  }

  has(screenId: string): boolean {
    return this.byScreen.has(screenId);
  }

  get size(): number {
    return this.byScreen.size;
  }
}

export interface CaptureCoordinatorDeps {
  control: ControlPlane;
  agentHub: AgentHub;
  thumbnails: ThumbnailStore;
  log: FastifyBaseLogger;
  /** Interval between automatic fleet-wide capture sweeps, ms. 0 (or negative) disables the timer. */
  intervalMs: number;
}

/**
 * Periodically asks every connected agent to screenshot its outputs, and ingests the replies into the
 * ThumbnailStore. The interval is disabled when `intervalMs <= 0` — on-demand `captureNow()` still works.
 */
export class CaptureCoordinator {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: CaptureCoordinatorDeps) {}

  /** The configured automatic interval (ms); 0 means the periodic sweep is disabled. */
  get intervalMs(): number {
    return this.deps.intervalMs;
  }

  /** The backing thumbnail store (read latest previews from REST / metrics). */
  get thumbnails(): ThumbnailStore {
    return this.deps.thumbnails;
  }

  /** Start the periodic capture sweep (no-op if disabled or already running). */
  start(): void {
    if (this.timer || this.deps.intervalMs <= 0) {
      if (this.deps.intervalMs <= 0) {
        this.deps.log.info(
          { event: "capture.disabled" },
          "live-preview capture sweep disabled (CAPTURE_INTERVAL_MS=0)",
        );
      }
      return;
    }
    this.timer = setInterval(() => this.sweep(), this.deps.intervalMs);
    // Don't keep the event loop alive solely for capture (clean shutdown / tests).
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.deps.log.info(
      { event: "capture.start", intervalMs: this.deps.intervalMs },
      "live-preview capture sweep started",
    );
  }

  /** Stop the periodic sweep. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.deps.log.info({ event: "capture.stop" }, "live-preview capture sweep stopped");
    }
  }

  /** One sweep: ask every connected agent to capture all of its outputs. */
  private sweep(): void {
    this.captureNow();
  }

  /**
   * Ask connected agents to capture now. With `machineId` set, only that machine is asked (all of its
   * outputs); otherwise every connected agent is asked. `connector` narrows to a single output (only
   * meaningful with a machineId). Returns the number of agents the request was delivered to.
   */
  captureNow(machineId?: string, connector?: string): number {
    const message = ServerToAgentCapture.parse(
      connector ? { t: "server/capture", connector } : { t: "server/capture" },
    );
    let delivered = 0;
    if (machineId) {
      delivered += this.deps.agentHub.send(machineId, message);
    } else {
      for (const id of this.deps.agentHub.machineIds()) {
        delivered += this.deps.agentHub.send(id, message) > 0 ? 1 : 0;
      }
    }
    this.deps.log.debug(
      { event: "capture.request", machineId: machineId ?? "*", connector: connector ?? "*", delivered },
      "requested capture from agent(s)",
    );
    return delivered;
  }

  /**
   * Resolve which screen a (machineId, connector) pair belongs to. Returns undefined when no screen is
   * mapped for that output yet (e.g. a pending machine, or an output without a screen).
   */
  private screenIdFor(machineId: string, connector: string): string | undefined {
    return this.deps.control
      .getScreens()
      .find((s) => s.machineId === machineId && s.connector === connector)?.id;
  }

  /**
   * Ingest an `agent/thumbnail` frame (already zod-parsed at the WS edge): resolve its output to a
   * screenId, decode the base64 payload, and store it as that screen's latest preview. Frames for
   * unmapped outputs or with empty payloads are dropped (logged at debug).
   */
  ingest(msg: AgentThumbnail): void {
    const screenId = this.screenIdFor(msg.machineId, msg.connector);
    if (!screenId) {
      this.deps.log.debug(
        { event: "capture.unmapped", machineId: msg.machineId, connector: msg.connector },
        "dropped thumbnail for an output with no mapped screen",
      );
      return;
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(msg.dataBase64, "base64");
    } catch (err) {
      this.deps.log.warn(
        { event: "capture.decode.error", screenId, err: String(err) },
        "failed to decode thumbnail payload",
      );
      return;
    }
    if (bytes.length === 0) {
      this.deps.log.debug(
        { event: "capture.empty", screenId, machineId: msg.machineId, connector: msg.connector },
        "dropped empty thumbnail payload",
      );
      return;
    }
    this.deps.thumbnails.set(screenId, {
      bytes,
      mime: msg.mime,
      takenAt: new Date().toISOString(),
    });
    this.deps.log.debug(
      {
        event: "capture.stored",
        screenId,
        machineId: msg.machineId,
        connector: msg.connector,
        mime: msg.mime,
        bytes: bytes.length,
        stored: this.deps.thumbnails.size,
      },
      "stored screen thumbnail",
    );
  }
}
