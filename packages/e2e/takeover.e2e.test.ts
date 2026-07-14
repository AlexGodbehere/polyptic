/**
 * @polyptic/e2e — POL-90 TAKEOVER / CAST against the REAL control plane.
 *
 * The claim under test is the one an operator is actually making when they hit the button: "put THIS
 * on THAT wall right now, for 30 minutes — and put it back by itself." So this suite drives the real
 * server, with real player sockets, and watches the frames arrive:
 *
 *   1. FLEET takeover → every connected player gets a `server/render` with the takeover's content, on
 *      the SAME keyed surface id it was already rendering (an in-place swap, not a remount — and
 *      certainly not a reload; the player never receives anything else).
 *   2. TTL EXPIRY → with no further REST call, every player gets a second `server/render` carrying its
 *      ORIGINAL content back. No residue: the admin snapshot's `overrides` is empty again.
 *   3. CAST on one screen → visible to every console (it is in `admin/state`), ended early by an
 *      operator, after which that screen returns to what it was showing.
 *   4. PRECEDENCE → a screen cast beats a running fleet takeover; ending the cast falls back to the
 *      fleet layer, not to desired state.
 *   5. The ACTIVITY FEED records start, end and expiry.
 *
 * Own port (8171), own memory store, OPEN enrolment (no bootstrap token) so a fake agent with two
 * outputs is auto-registered + auto-approved. Independent of every other e2e suite.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8171;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 15_000;

const MACHINE_ID = "takeover-host-1";
const CONN_A = "HDMI-1";
const CONN_B = "HDMI-2";

const DESIRED_A = "https://example.com/desired-a";
const DESIRED_B = "https://example.com/desired-b";
const ALERT_URL = "https://example.com/fire-alarm";
const EXEC_URL = "https://example.com/exec-deck";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// A buffering WS client: never miss a frame between awaits.
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
  /** EVERY frame this socket has ever received, in order — so a test can assert what did NOT arrive. */
  readonly seen: Frame[] = [];
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
      return;
    }
    this.seen.push(msg);
    const idx = this.waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    this.queue.push(msg);
  }

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
// REST + wire helpers
// ─────────────────────────────────────────────────────────────────────────────

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function putJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { method: "DELETE" });
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

const openClients: WsClient[] = [];

async function snapshot(label: string, timeoutMs = 4_000): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  const state = await admin.waitFor((m) => m.t === "admin/state", label, timeoutMs);
  admin.close();
  return state;
}

/** The url on a render frame's first surface (web/dashboard `url`, media `src`). */
const renderUrl = (m: Frame): string | undefined =>
  m.slice?.surfaces?.[0]?.url ?? m.slice?.surfaces?.[0]?.src;

/** Wait for a render on a player whose first surface carries `url`. */
function waitForContent(player: WsClient, url: string, label: string): Promise<Frame> {
  return Promise.race([
    player.waitFor((m) => m.t === "server/render" && renderUrl(m) === url, label, 8_000),
  ]);
}

const activityTexts = (state: Frame): string[] =>
  Array.isArray(state.activity) ? state.activity.map((e: Frame) => String(e.text)) : [];

// ─────────────────────────────────────────────────────────────────────────────
// Server lifecycle
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

let screenA = "";
let screenB = "";
let playerA: WsClient;
let playerB: WsClient;
let surfaceIdA = ""; // the keyed surface id A is rendering BEFORE any takeover

beforeAll(async () => {
  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
      AUTH_ENABLED: "false",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();

  // One agent, two outputs → two screens, auto-approved (open enrolment).
  const agent = await WsClient.connect(`${WS}/agent`);
  openClients.push(agent);
  agent.send({
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId: MACHINE_ID,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [
      { connector: CONN_A, width: 1920, height: 1080 },
      { connector: CONN_B, width: 1920, height: 1080 },
    ],
  });
  await agent.waitFor((m) => m.t === "server/apply", "server/apply after hello", 6_000);

  const state = await snapshot("initial admin/state");
  const screens = state.machines.flatMap((m: Frame) => m.screens);
  screenA = screens.find((s: Frame) => s.connector === CONN_A).id;
  screenB = screens.find((s: Frame) => s.connector === CONN_B).id;

  // Desired state: each screen shows its own content. This is what the takeover must layer OVER, and
  // exactly what must come back when it ends.
  await drain(await putJson(`/api/v1/screens/${screenA}/content`, { url: DESIRED_A }));
  await drain(await putJson(`/api/v1/screens/${screenB}/content`, { url: DESIRED_B }));

  playerA = await WsClient.connect(`${WS}/player`);
  playerB = await WsClient.connect(`${WS}/player`);
  openClients.push(playerA, playerB);
  playerA.send({ t: "player/hello", protocol: PROTOCOL_VERSION, screenId: screenA });
  playerB.send({ t: "player/hello", protocol: PROTOCOL_VERSION, screenId: screenB });

  const first = await waitForContent(playerA, DESIRED_A, "A's desired content");
  await waitForContent(playerB, DESIRED_B, "B's desired content");
  surfaceIdA = first.slice.surfaces[0].id;
}, 30_000);

afterAll(async () => {
  for (const c of openClients) c.close();
  if (proc) {
    proc.kill();
    await proc.exited;
  }
});

describe("fleet takeover (POL-90)", () => {
  test(
    "reaches EVERY connected player, in place, with no reload",
    async () => {
      const res = await postJson("/api/v1/overrides", { scope: "fleet", url: ALERT_URL });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Frame;
      expect(body.override.scope).toBe("fleet");

      const a = await waitForContent(playerA, ALERT_URL, "A takeover render");
      const b = await waitForContent(playerB, ALERT_URL, "B takeover render");

      // The SAME keyed surface id → the player mutates the existing tile in place (D5).
      expect(a.slice.surfaces[0].id).toBe(surfaceIdA);
      expect(b.slice.surfaces).toHaveLength(1);

      // The takeover reached the wall as CONTENT and nothing else: the only frames this player has
      // ever received are renders and the fleet display-settings push. No reload, no re-hello, no
      // new channel — a takeover is not a special case in the player, it is just the next slice.
      const kinds = new Set(playerA.seen.map((m: Frame) => m.t));
      expect([...kinds].sort()).toEqual(["server/render", "server/settings"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "is visible to every console, with its content and its countdown",
    async () => {
      const state = await snapshot("admin/state during takeover");
      expect(state.overrides).toHaveLength(1);
      expect(state.overrides[0].scope).toBe("fleet");
      expect(state.overrides[0].label).toBeTruthy();
      expect(activityTexts(state).some((t) => t.startsWith("Takeover —"))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "ending it early puts the ORIGINAL content back on every screen, with no residue",
    async () => {
      const state = await snapshot("admin/state before end");
      const id = state.overrides[0].id;

      const res = await del(`/api/v1/overrides/${id}`);
      expect(res.status).toBe(200);
      await drain(res);

      await waitForContent(playerA, DESIRED_A, "A back to desired");
      await waitForContent(playerB, DESIRED_B, "B back to desired");

      const after = await snapshot("admin/state after end");
      expect(after.overrides).toEqual([]);
      expect(activityTexts(after).some((t) => t.startsWith("Takeover ended —"))).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe("TTL auto-revert (POL-90)", () => {
  test(
    "a fleet takeover with a TTL reverts BY ITSELF — nobody calls anything",
    async () => {
      const res = await postJson("/api/v1/overrides", {
        scope: "fleet",
        url: ALERT_URL,
        ttlSeconds: 10, // the contract's floor; the sweep runs every second
      });
      expect(res.status).toBe(201);
      await drain(res);

      await waitForContent(playerA, ALERT_URL, "A takeover render");
      await waitForContent(playerB, ALERT_URL, "B takeover render");

      // No further REST call from here on. The server's sweep is the only actor.
      const backA = await playerA.waitFor(
        (m) => m.t === "server/render" && renderUrl(m) === DESIRED_A,
        "A auto-reverted",
        14_000,
      );
      const backB = await playerB.waitFor(
        (m) => m.t === "server/render" && renderUrl(m) === DESIRED_B,
        "B auto-reverted",
        14_000,
      );
      expect(backA.slice.surfaces[0].id).toBe(surfaceIdA); // still the same keyed tile
      expect(renderUrl(backB)).toBe(DESIRED_B);

      const after = await snapshot("admin/state after expiry");
      expect(after.overrides).toEqual([]);
      expect(activityTexts(after).some((t) => t.startsWith("Takeover expired —"))).toBe(true);
    },
    30_000,
  );
});

describe("cast + precedence (POL-90)", () => {
  test(
    "a screen cast beats a running fleet takeover, and ending it falls back to the fleet layer",
    async () => {
      const fleetRes = await postJson("/api/v1/overrides", { scope: "fleet", url: ALERT_URL });
      await drain(fleetRes);
      await waitForContent(playerA, ALERT_URL, "A on the fleet layer");

      // The Cast action: a short-lived screen-scope takeover — the same mechanism.
      const castRes = await postJson("/api/v1/overrides", {
        scope: "screen",
        targetId: screenA,
        url: EXEC_URL,
        ttlSeconds: 600,
      });
      expect(castRes.status).toBe(201);
      const cast = ((await castRes.json()) as Frame).override;
      expect(cast.expiresAt).toBeTruthy(); // the countdown every console shows

      await waitForContent(playerA, EXEC_URL, "A takes the cast (screen beats fleet)");
      expect(renderUrl(playerB.seen[playerB.seen.length - 1])).toBe(ALERT_URL); // B stays on the fleet layer

      // Every console sees BOTH layers, so any operator can end either.
      const during = await snapshot("admin/state with two layers");
      expect(during.overrides).toHaveLength(2);

      await drain(await del(`/api/v1/overrides/${cast.id}`));
      await waitForContent(playerA, ALERT_URL, "A falls back to the fleet layer, not to desired");

      await drain(await del(`/api/v1/overrides/${((await snapshot("last")).overrides[0]).id}`));
      await waitForContent(playerA, DESIRED_A, "A back to desired once the fleet layer ends too");
    },
    TEST_TIMEOUT,
  );

  test(
    "a takeover onto unknown content or an unknown target is refused",
    async () => {
      const badSource = await postJson("/api/v1/overrides", { scope: "fleet", sourceId: "source-404" });
      expect(badSource.status).toBe(404);
      await drain(badSource);

      const badTarget = await postJson("/api/v1/overrides", {
        scope: "screen",
        targetId: "screen-404",
        url: ALERT_URL,
      });
      expect(badTarget.status).toBe(404);
      await drain(badTarget);

      const badBody = await postJson("/api/v1/overrides", { scope: "screen", url: ALERT_URL }); // no targetId
      expect(badBody.status).toBe(400);
      await drain(badBody);

      const state = await snapshot("admin/state after refusals");
      expect(state.overrides).toEqual([]); // nothing was started, and nothing lingers
    },
    TEST_TIMEOUT,
  );
});
