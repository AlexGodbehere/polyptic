/**
 * @polyptic/e2e — Phase 5 LIVE PREVIEW + health/metrics against the REAL control plane.
 *
 * Phase 5 adds the "impress stakeholders" live preview: the server periodically asks each connected
 * agent to CAPTURE its outputs (`server/capture`), the agent screenshots each output and replies with
 * an `agent/thumbnail` {machineId, connector, mime, dataBase64} (both already in the contract — Phase 5
 * stores + serves them, it does NOT change the wire), and the console fetches the latest frame per
 * screen over a plain REST route. This suite proves that round-trip end-to-end, plus the two UNGATED
 * ops endpoints (`/healthz`, `/metrics`) that live ABOVE the /api/v1 auth gate so liveness probes and
 * Prometheus scrapers never need a session.
 *
 * We spawn the actual server (`packages/server/src/index.ts`) against the MemoryStore (STORE=memory) on
 * its OWN PORT (8097) with AUTH_ENABLED=false and a SMALL CAPTURE_INTERVAL_MS so a capture cycle fires
 * within the test window. With NO `POLYPTIC_BOOTSTRAP_TOKEN` the server runs OPEN (the Phase 2a default):
 * one fake agent reporting TWO outputs is auto-registered + auto-approved, giving us two screens.
 *
 * The fake agent is the novel bit (vs walls.e2e.test.ts, which is player-side): it LISTENS for
 * `server/capture` and replies `agent/thumbnail` carrying a tiny but byte-exact JPEG — but ONLY for
 * output A. Output B is never captured, so its screen has no thumbnail. We assert:
 *
 *   - GET /api/v1/screens/:idA/thumbnail  → 200, content-type image/jpeg, body === the bytes we sent
 *     (transport round-trip — we assert byte fidelity, not that it's a renderable image);
 *   - GET /api/v1/screens/:idB/thumbnail  → 204 (a screen with no captured frame yet);
 *   - GET /healthz                        → 200 {status:"ok"} (UNGATED — not under /api/v1);
 *   - GET /metrics                        → 200 text/plain exposition with `# TYPE` lines for
 *     polyptic_revision, polyptic_agents_connected and polyptic_screens_total (UNGATED).
 *
 * Robustness: every WS read is buffered (a frame arriving between awaits is never missed) and carries a
 * per-message timeout; the thumbnail GET is POLLED to a deadline (the capture loop is periodic, so we
 * don't race a single tick). The server process is torn down in `afterAll`. Its own port + fresh memory
 * store keep it independent of the other suites.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8097;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 15_000;

const MACHINE_ID = "preview-host-1";
const RES_W = 1920;
const RES_H = 1080;

const CONN_A = "HDMI-1"; // captured → its screen serves a thumbnail
const CONN_B = "HDMI-2"; // never captured → its screen returns 204

// A tiny but byte-EXACT JPEG: SOI (FF D8) … a couple of marker-ish bytes … EOI (FF D9). It is not a
// decodable image, and it doesn't need to be — this is a TRANSPORT test: we assert the exact bytes we
// base64-encoded into agent/thumbnail come back out of the REST route unchanged.
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
const JPEG_BASE64 = Buffer.from(JPEG_BYTES).toString("base64");
const JPEG_MIME = "image/jpeg";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// A buffering WS client: never miss a frame between awaits. `onMessage` lets a caller attach an
// auto-responder (the fake agent replies to server/capture) WITHOUT consuming the buffered queue.
// ─────────────────────────────────────────────────────────────────────────────

type Frame = any;
type Predicate = (m: Frame) => boolean;

interface Waiter {
  pred: Predicate;
  resolve: (m: Frame) => void;
  timer: ReturnType<typeof setTimeout>;
  label: string;
}

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly observers: Array<(m: Frame) => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: { data: unknown }) => this.ingest(ev.data));
  }

  static connect(url: string, timeoutMs = 5_000): Promise<WsClient> {
    return new Promise<WsClient>((resolveConn, rejectConn) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        rejectConn(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        rejectConn(new Error(`ws open timeout: ${url}`));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolveConn(new WsClient(ws));
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          rejectConn(new Error(`ws error before open: ${url}`));
        },
        { once: true },
      );
    });
  }

  private ingest(data: unknown): void {
    const text = typeof data === "string" ? data : String(data);
    let msg: Frame;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // never trust a malformed frame
    }
    // Observers see EVERY frame (e.g. the capture auto-responder) but don't consume it.
    for (const obs of this.observers) {
      try {
        obs(msg);
      } catch {
        /* an observer must never break ingestion */
      }
    }
    const idx = this.waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    this.queue.push(msg);
  }

  /** Attach a non-consuming observer invoked for every inbound frame. */
  onMessage(observer: (m: Frame) => void): void {
    this.observers.push(observer);
  }

  /** Resolve with the first frame (queued or future) that matches `pred`, or reject on timeout. */
  waitFor(pred: Predicate, label = "frame", timeoutMs = 4_000): Promise<Frame> {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise<Frame>((resolveMsg, rejectMsg) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        rejectMsg(new Error(`timed out waiting for ${label} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: resolveMsg, timer, label });
    });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire-shape builders (contract "t" values + field names, validated server-side)
// ─────────────────────────────────────────────────────────────────────────────

function agentHello(
  machineId: string,
  outputs: Array<{ connector: string; width: number; height: number }>,
): unknown {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId,
    agentVersion: "e2e-preview",
    backend: "dev-open",
    outputs,
  };
}

/** An agent→server thumbnail frame (AgentThumbnail). */
function agentThumbnail(machineId: string, connector: string): unknown {
  return {
    t: "agent/thumbnail",
    machineId,
    connector,
    mime: JPEG_MIME,
    dataBase64: JPEG_BASE64,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REST helpers
// ─────────────────────────────────────────────────────────────────────────────

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Server process lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;
const openClients: WsClient[] = [];

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never responded";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/state`);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${BASE}: ${lastErr}`);
}

/** Poll the thumbnail route until it stops returning 204 (a capture cycle has landed) or we time out. */
async function waitForThumbnail(screenId: string, timeoutMs = 8_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/v1/screens/${screenId}/thumbnail`);
    if (res.status === 200) return res;
    last = `status ${res.status}`;
    await drain(res);
    await sleep(150);
  }
  throw new Error(`thumbnail for ${screenId} never became available: ${last}`);
}

// Shared across the ordered flow below.
let screenA = ""; // CONN_A — the agent captures this one
let screenB = ""; // CONN_B — never captured → 204

beforeAll(async () => {
  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      // No POLYPTIC_BOOTSTRAP_TOKEN → OPEN mode: the fake agent is auto-registered + auto-approved.
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
      AUTH_ENABLED: "false",
      // Small so a capture cycle fires well within the test window.
      CAPTURE_INTERVAL_MS: "500",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();

  // One agent, TWO outputs → two screens. The agent answers server/capture for CONN_A ONLY, so
  // screen A gets a thumbnail and screen B stays empty (→ 204).
  const agent = await WsClient.connect(`${WS}/agent`);
  openClients.push(agent);

  // Auto-responder: reply to EVERY server/capture with an agent/thumbnail for CONN_A. The server may
  // target a specific connector or all outputs (connector omitted = all); in both cases we answer for
  // CONN_A and never for CONN_B.
  agent.onMessage((m) => {
    if (m?.t !== "server/capture") return;
    const wantsA = m.connector === undefined || m.connector === CONN_A;
    if (wantsA) agent.send(agentThumbnail(MACHINE_ID, CONN_A));
  });

  agent.send(
    agentHello(MACHINE_ID, [
      { connector: CONN_A, width: RES_W, height: RES_H },
      { connector: CONN_B, width: RES_W, height: RES_H },
    ]),
  );
  const apply = await agent.waitFor(
    (m) => m.t === "server/apply" && m.machineId === MACHINE_ID,
    "server/apply for preview-host-1",
    5_000,
  );
  expect(Array.isArray(apply.screens)).toBe(true);
  expect(apply.screens.length).toBe(2);

  const byConnector = (connector: string): string => {
    const entry = apply.screens.find((s: Frame) => s.connector === connector);
    expect(entry).toBeDefined();
    expect(typeof entry.screenId).toBe("string");
    expect(entry.screenId.length).toBeGreaterThan(0);
    return entry.screenId;
  };
  screenA = byConnector(CONN_A);
  screenB = byConnector(CONN_B);
}, 30_000);

afterAll(async () => {
  for (const c of openClients) c.close();
  if (proc) {
    proc.kill();
    try {
      await proc.exited;
    } catch {
      /* already gone */
    }
  }
}, 10_000);

// ─────────────────────────────────────────────────────────────────────────────
// Live preview — server/capture → agent/thumbnail → REST round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 5 live preview (capture round-trip)", () => {
  test(
    "GET /screens/:id/thumbnail returns 200 image/jpeg with the exact bytes the agent sent",
    async () => {
      const res = await waitForThumbnail(screenA);
      expect(res.status).toBe(200);

      const ctype = res.headers.get("content-type") ?? "";
      expect(ctype.toLowerCase()).toContain("image/jpeg");

      const body = new Uint8Array(await res.arrayBuffer());
      // Non-empty body…
      expect(body.length).toBeGreaterThan(0);
      // …that is byte-for-byte what we base64-encoded into agent/thumbnail (transport fidelity).
      expect(body.length).toBe(JPEG_BYTES.length);
      expect(Array.from(body)).toEqual(Array.from(JPEG_BYTES));
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /screens/:id/thumbnail returns 204 for a screen with no captured frame yet",
    async () => {
      // Give the capture loop a couple of cycles so a missing 204 can't simply be "not captured yet" —
      // screen B is never answered by our agent, so it must stay empty.
      await sleep(1_200);
      const res = await fetch(`${BASE}/api/v1/screens/${screenB}/thumbnail`);
      expect(res.status).toBe(204);
      const body = await res.arrayBuffer();
      expect(body.byteLength).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /screens/:id/thumbnail for an unknown screen does not 200",
    async () => {
      const res = await fetch(`${BASE}/api/v1/screens/screen-does-not-exist/thumbnail`);
      // Either a 404 (unknown screen) or a 204 (no frame) is acceptable — it must NOT serve an image.
      expect(res.status).not.toBe(200);
      await drain(res);
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Ops endpoints — UNGATED (above the /api/v1 auth gate) for liveness + scrapers
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 5 health + metrics (ungated)", () => {
  test(
    "GET /healthz returns 200 {status:'ok'}",
    async () => {
      const res = await fetch(`${BASE}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status?: string };
      expect(body.status).toBe("ok");
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /metrics returns Prometheus exposition with the expected metrics + # TYPE lines",
    async () => {
      const res = await fetch(`${BASE}/metrics`);
      expect(res.status).toBe(200);

      const ctype = res.headers.get("content-type") ?? "";
      expect(ctype.toLowerCase()).toContain("text/plain");

      const text = await res.text();
      // The three metrics the spec calls out, each with a HELP/TYPE descriptor block.
      for (const name of [
        "polyptic_revision",
        "polyptic_agents_connected",
        "polyptic_screens_total",
      ]) {
        expect(text).toContain(name);
        expect(text).toContain(`# TYPE ${name}`);
      }

      // The agent connected in beforeAll, and we created two screens — sanity-check the live values are
      // present as numbers on their sample lines (a metric line is `name <number>` after the TYPE block).
      const sample = (name: string): number => {
        const re = new RegExp(`^${name}\\s+(-?\\d+(?:\\.\\d+)?)\\s*$`, "m");
        const m = text.match(re);
        expect(m).not.toBeNull();
        return Number(m![1]);
      };
      expect(sample("polyptic_agents_connected")).toBeGreaterThanOrEqual(1);
      expect(sample("polyptic_screens_total")).toBeGreaterThanOrEqual(2);
      expect(sample("polyptic_revision")).toBeGreaterThanOrEqual(0);
    },
    TEST_TIMEOUT,
  );
});
