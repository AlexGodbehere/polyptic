/**
 * POL-132 — the page-side update discipline (ShellUpdater), pinned against fakes.
 *
 * The invariants that keep a fleet healthy:
 *   - a newer build NEVER swaps in mid-outage or mid-anything: only at a safe moment (player WS
 *     open — the reload it costs repaints instantly from the last-good slice and reconnects);
 *   - every server contact revalidates (registration.update()), so a wall is never pinned to an
 *     old shell past the next successful contact (D107 version discipline);
 *   - the swap is written to player.diag ("shell from cache (vX) → updating to vY") — D78: the
 *     trail is how walls get debugged, silent swaps don't exist;
 *   - exactly ONE reload per swap, and a first-install claim (controllerchange with no swap
 *     requested) never reloads a freshly-loaded wall.
 */
import { describe, expect, test } from "bun:test";

import { ShellUpdater, scopeFor } from "../src/sw-register";
import type { RegistrationLike, WorkerLike } from "../src/sw-register";

function makeWorld(opts?: { safe?: boolean; controller?: boolean; nextVersion?: string | null }) {
  const log: string[] = [];
  const posted: unknown[] = [];
  let safe = opts?.safe ?? true;
  let updateCalls = 0;
  let reloads = 0;

  const waiting: WorkerLike = {
    postMessage: (m) => posted.push(m),
  };

  const updatefound: Array<() => void> = [];
  const registration: RegistrationLike & { waiting: WorkerLike | null; installing: WorkerLike | null } = {
    waiting: null,
    installing: null,
    addEventListener: (_t, fn) => updatefound.push(fn),
    update: async () => {
      updateCalls += 1;
    },
  };

  const updater = new ShellUpdater({
    log: (m) => log.push(m),
    version: "1.0.0",
    safeToSwap: () => safe,
    hasController: () => opts?.controller ?? true,
    versionOf: async () => (opts && "nextVersion" in opts ? (opts.nextVersion ?? null) : "2.0.0"),
    reload: () => {
      reloads += 1;
    },
  });

  return {
    updater,
    registration,
    waiting,
    log,
    posted,
    setSafe: (v: boolean) => {
      safe = v;
    },
    updateCalls: () => updateCalls,
    reloads: () => reloads,
    fireUpdatefound: () => updatefound.forEach((f) => f()),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ShellUpdater", () => {
  test("a waiting build + safe moment → diag line names both versions, worker told to take over", async () => {
    const w = makeWorld({ safe: true });
    w.registration.waiting = w.waiting;
    w.updater.attach(w.registration);
    await flush();
    expect(w.log).toEqual(["shell from cache (v1.0.0) → updating to v2.0.0 — reloading"]);
    expect(w.posted).toEqual([{ t: "polyptic/skip-waiting" }]);
  });

  test("NOT safe → announces once, waits; the swap happens on the next server contact", async () => {
    const w = makeWorld({ safe: false });
    w.registration.waiting = w.waiting;
    w.updater.attach(w.registration);
    w.updater.serverContact(); // still offline — no swap, no repeat announcement
    await flush();
    expect(w.posted).toHaveLength(0);
    expect(w.log.filter((l) => l.includes("waiting for server contact"))).toHaveLength(1);

    w.setSafe(true);
    w.updater.serverContact(); // the safe moment
    await flush();
    expect(w.posted).toEqual([{ t: "polyptic/skip-waiting" }]);
    expect(w.updateCalls()).toBe(2); // every contact revalidated the registration too
  });

  test("an unknown next version still swaps, honestly labelled", async () => {
    const w = makeWorld({ nextVersion: null });
    w.registration.waiting = w.waiting;
    w.updater.attach(w.registration);
    await flush();
    expect(w.log[0]).toBe("shell from cache (v1.0.0) → updating to a newer build — reloading");
  });

  test("controllerchange after OUR swap reloads exactly once", async () => {
    const w = makeWorld();
    w.registration.waiting = w.waiting;
    w.updater.attach(w.registration);
    await flush();
    w.updater.controllerChanged();
    w.updater.controllerChanged(); // a second event must never double-reload
    expect(w.reloads()).toBe(1);
  });

  test("a first-install claim (no swap requested) never reloads a fresh wall", () => {
    const w = makeWorld();
    w.updater.attach(w.registration); // nothing waiting
    w.updater.controllerChanged(); // clients.claim() fired this
    expect(w.reloads()).toBe(0);
  });

  test("no controller → no swap (nothing is being replaced)", async () => {
    const w = makeWorld({ controller: false });
    w.registration.waiting = w.waiting;
    w.updater.attach(w.registration);
    await flush();
    expect(w.posted).toHaveLength(0);
  });

  test("a background install completing (updatefound → installed) triggers the same safe-swap path", async () => {
    const w = makeWorld({ safe: true });
    w.updater.attach(w.registration);
    // The browser found a new sw.js and starts installing it…
    const listeners: Array<() => void> = [];
    w.registration.installing = {
      state: "installing",
      postMessage: () => {},
      addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
    };
    w.fireUpdatefound();
    // …then it finishes: state flips to installed and the worker moves to `waiting`.
    (w.registration.installing as { state?: string }).state = "installed";
    w.registration.waiting = w.waiting;
    listeners.forEach((f) => f());
    await flush();
    expect(w.posted).toEqual([{ t: "polyptic/skip-waiting" }]);
  });
});

describe("scopeFor", () => {
  test("the /player/ base registers the wider no-trailing-slash scope; root stays root", () => {
    expect(scopeFor("/player/")).toBe("/player");
    expect(scopeFor("/")).toBe("/");
  });
});
