/**
 * @polyptych/e2e — Phase 3a MURALS & PLACEMENT suite against the REAL control plane.
 *
 * Phase 3 adds the spatial model: a deployment has several **Murals** (named, switchable canvases),
 * and a **Screen** is either *unplaced* (no placement → lives in the Wall view's tray) or *placed* on
 * exactly one mural at `{x, y, w, h}` in canvas pixels (w/h default to the screen's output
 * resolution). The admin snapshot (`admin/state`) now carries `murals[]` and `placements[]`, and the
 * server broadcasts on every change.
 *
 * We spawn the actual server (`packages/server/src/index.ts`) with `Bun.spawn` against the MemoryStore
 * (STORE=memory) on its own PORT (8092). With NO `POLYPTYCH_BOOTSTRAP_TOKEN` the server runs in OPEN
 * mode (the Phase 2a default), so a single fake agent over `/agent` is auto-registered + auto-approved
 * and a screen is created — giving us something to place. We then drive the mural REST surface over
 * `fetch` and assert the resulting `admin/state` snapshots:
 *
 *   - a default mural named "Wall" is seeded on init (no murals existed);
 *   - POST   /api/v1/murals { name }                  → the new mural appears in admin/state.murals;
 *   - PUT    /api/v1/screens/:id/placement { muralId, x, y }
 *                                                       → a placement appears in admin/state.placements,
 *                                                         with w/h DEFAULTED to the screen's resolution;
 *   - DELETE /api/v1/screens/:id/placement            → that placement disappears (screen back in tray);
 *   - DELETE /api/v1/murals/:id                        → the mural disappears AND its screens are
 *                                                         unplaced (their placements disappear too).
 *
 * Robustness: every WS read is buffered (a frame that arrives between awaits is never missed) and
 * carries a per-message timeout. For each state assertion we open a FRESH `/admin` connection and read
 * its first `admin/state` — a brand-new client's snapshot always reflects CURRENT server state, so we
 * never race a stale broadcast that happens to satisfy an absence check. The server process is torn
 * down in `afterAll`.
 *
 * This suite is independent of polyptych.e2e.test.ts (PORT 8090) and enrollment.e2e.test.ts (PORT
 * 8091): different port, fresh memory store. All three must stay green.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptych/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8092;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

// A distinctive resolution so the "w/h defaulted to the screen's resolution" assertion is meaningful.
const RES_W = 3840;
const RES_H = 2160;
const MACHINE_ID = "mural-host-1";
const CONNECTOR = "HDMI-1";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// A buffering WS client: never miss a frame between awaits.
//
// Frames are parsed as soon as they arrive and either handed to a waiting predicate or queued.
// `waitFor` first scans the queue (so an already-delivered frame still satisfies a later wait),
// then parks a waiter with a per-message timeout.
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
    const idx = this.waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    this.queue.push(msg);
  }

  /** Resolve with the first frame (queued or future) that matches `pred`, or reject on timeout. */
  waitFor(pred: Predicate, label = "frame", timeoutMs = 3_000): Promise<Frame> {
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
// REST helpers
// ─────────────────────────────────────────────────────────────────────────────

function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function putJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { method: "DELETE" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire-shape builders (contract "t" values + field names, validated server-side)
// ─────────────────────────────────────────────────────────────────────────────

function agentHello(machineId: string, connector: string, width: number, height: number): unknown {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [{ connector, width, height }],
  };
}

function adminHello(): unknown {
  return { t: "admin/hello", protocol: PROTOCOL_VERSION };
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection helpers
// ─────────────────────────────────────────────────────────────────────────────

const openClients: WsClient[] = [];

async function openAgent(): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/agent`);
  openClients.push(client);
  return client;
}

/**
 * Open a FRESH /admin connection, send admin/hello, and return its first admin/state snapshot.
 * A brand-new client's first snapshot always reflects CURRENT server state, so absence checks
 * (a placement/mural that should be GONE) can't be satisfied by a stale, already-queued broadcast.
 */
async function snapshot(label: string, timeoutMs = 4_000): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send(adminHello());
  const state = await admin.waitFor((m) => m.t === "admin/state", label, timeoutMs);
  admin.close();
  return state;
}

const muralsOf = (state: Frame): Frame[] => (Array.isArray(state.murals) ? state.murals : []);
const placementsOf = (state: Frame): Frame[] =>
  Array.isArray(state.placements) ? state.placements : [];
const muralByName = (state: Frame, name: string): Frame | undefined =>
  muralsOf(state).find((m) => m.name === name);
const muralById = (state: Frame, id: string): Frame | undefined =>
  muralsOf(state).find((m) => m.id === id);
const placementFor = (state: Frame, screenId: string): Frame | undefined =>
  placementsOf(state).find((p) => p.screenId === screenId);

// ─────────────────────────────────────────────────────────────────────────────
// Server process lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;

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

// Shared across the ordered flow below (bun runs tests in source order, sequentially).
let screenId = ""; // the auto-created screen we place/unplace
let defaultMuralId = ""; // the seeded "Wall" mural
let createdMuralId = ""; // the "Operations" mural created over REST

beforeAll(async () => {
  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      // No POLYPTYCH_BOOTSTRAP_TOKEN → OPEN mode: the fake agent is auto-registered + auto-approved,
      // so a screen exists to place. (Gated enrollment is covered by enrollment.e2e.test.ts.)
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();

  // Register one agent so a screen exists. In OPEN mode it is admitted immediately with server/apply.
  const agent = await openAgent();
  agent.send(agentHello(MACHINE_ID, CONNECTOR, RES_W, RES_H));
  const apply = await agent.waitFor(
    (m) => m.t === "server/apply" && m.machineId === MACHINE_ID,
    "server/apply for mural-host-1",
    5_000,
  );
  expect(Array.isArray(apply.screens)).toBe(true);
  expect(apply.screens.length).toBe(1);
  screenId = apply.screens[0].screenId;
  expect(typeof screenId).toBe("string");
  expect(screenId.length).toBeGreaterThan(0);
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
// Murals & placement — the heart of Phase 3a
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 3a murals & placement", () => {
  test(
    "a default 'Wall' mural is seeded and carried in admin/state.murals",
    async () => {
      const state = await snapshot("admin/state with seeded Wall mural");
      expect(Array.isArray(state.murals)).toBe(true);
      expect(Array.isArray(state.placements)).toBe(true);
      // Fresh memory store: exactly one mural, named "Wall", seeded on init.
      expect(state.murals.length).toBe(1);
      const wall = muralByName(state, "Wall");
      expect(wall).toBeDefined();
      expect(typeof wall.id).toBe("string");
      expect(wall.id.length).toBeGreaterThan(0);
      defaultMuralId = wall.id;
      // No screen has been placed yet.
      expect(state.placements.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /api/v1/murals creates a mural that appears in admin/state.murals",
    async () => {
      const res = await postJson("/api/v1/murals", { name: "Operations" });
      expect(res.ok).toBe(true);
      await res.body?.cancel();

      const state = await snapshot("admin/state with created mural");
      expect(state.murals.length).toBe(2);
      const created = muralByName(state, "Operations");
      expect(created).toBeDefined();
      expect(typeof created.id).toBe("string");
      expect(created.id.length).toBeGreaterThan(0);
      // The seeded mural is untouched and the new id is distinct.
      expect(muralByName(state, "Wall")).toBeDefined();
      expect(created.id).not.toBe(defaultMuralId);
      createdMuralId = created.id;
    },
    TEST_TIMEOUT,
  );

  test(
    "PUT /api/v1/screens/:id/placement places the screen with w/h defaulted to its resolution",
    async () => {
      // No w/h in the body → the server must default them to the screen's native output resolution.
      const res = await putJson(`/api/v1/screens/${screenId}/placement`, {
        muralId: defaultMuralId,
        x: 100,
        y: 200,
      });
      expect(res.ok).toBe(true);
      await res.body?.cancel();

      const state = await snapshot("admin/state with placed screen");
      expect(state.placements.length).toBe(1);
      const placement = placementFor(state, screenId);
      expect(placement).toBeDefined();
      expect(placement.muralId).toBe(defaultMuralId);
      expect(placement.screenId).toBe(screenId);
      expect(placement.x).toBe(100);
      expect(placement.y).toBe(200);
      // The contract: w/h default to the screen's resolution when omitted.
      expect(placement.w).toBe(RES_W);
      expect(placement.h).toBe(RES_H);
    },
    TEST_TIMEOUT,
  );

  test(
    "DELETE /api/v1/screens/:id/placement unplaces the screen (placement disappears)",
    async () => {
      const res = await del(`/api/v1/screens/${screenId}/placement`);
      expect(res.ok).toBe(true);
      await res.body?.cancel();

      const state = await snapshot("admin/state after unplace");
      expect(placementFor(state, screenId)).toBeUndefined();
      expect(state.placements.length).toBe(0);
      // The mural itself still exists — only the placement was removed.
      expect(muralById(state, defaultMuralId)).toBeDefined();
    },
    TEST_TIMEOUT,
  );

  test(
    "DELETE /api/v1/murals/:id removes the mural AND unplaces its screens",
    async () => {
      // First place the screen onto the "Operations" mural so the delete has a screen to unplace.
      const place = await putJson(`/api/v1/screens/${screenId}/placement`, {
        muralId: createdMuralId,
        x: 50,
        y: 60,
      });
      expect(place.ok).toBe(true);
      await place.body?.cancel();

      const placedState = await snapshot("admin/state with screen on Operations mural");
      const onOps = placementFor(placedState, screenId);
      expect(onOps).toBeDefined();
      expect(onOps.muralId).toBe(createdMuralId);

      // Now delete the mural — its screens must be unplaced as a side effect.
      const res = await del(`/api/v1/murals/${createdMuralId}`);
      expect(res.ok).toBe(true);
      await res.body?.cancel();

      const state = await snapshot("admin/state after mural delete");
      // The mural is gone (only the seeded "Wall" remains)…
      expect(muralById(state, createdMuralId)).toBeUndefined();
      expect(muralByName(state, "Wall")).toBeDefined();
      expect(state.murals.length).toBe(1);
      // …and the screen it held is back in the tray (no placement).
      expect(placementFor(state, screenId)).toBeUndefined();
      expect(state.placements.length).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
