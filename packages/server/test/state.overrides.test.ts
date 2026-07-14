/**
 * POL-90 — the takeover / cast layer: composition, precedence, TTL auto-revert, restart.
 *
 * These drive `ControlPlane` directly against the `MemoryStore` (no server/WS). They pin the three
 * claims the feature makes to an operator:
 *
 *   1. A takeover is a LAYER, never a mutation. `state.slices` — the desired content — is untouched
 *      while a takeover runs; only the SEND-TIME slice (`decorateSliceForSend`) shows it. That is why
 *      ending one restores nothing: there is nothing to restore.
 *   2. PRECEDENCE is screen > wall > mural > fleet. The most specific layer wins, so a fleet-wide
 *      fire-alarm broadcast does not stomp on the cast someone put on the atrium a minute ago, and
 *      ending the cast drops that screen back onto the fleet layer — not onto desired state.
 *   3. TTL expiry is a pure function of an INJECTED clock (`expireOverrides(nowMs)`), like
 *      `disarmExpiredShells`. No timer is waited on here.
 *
 * Plus the two things that must never happen: an expired layer must never paint (even in the gap
 * before the sweep runs), and a takeover whose content has been deleted under it must fall back to
 * the desired content rather than strand the wall on nothing.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Output, Surface } from "@polyptic/protocol";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function hello(machineId: string, ...connectors: string[]): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: connectors.map((connector) => ({ connector, width: 1920, height: 1080 }) satisfies Output),
    hostname: "test-box",
  };
}

/** What a player would actually be sent for a screen right now — desired state WITH the layer on top. */
function sent(cp: ControlPlane, screenId: string): Surface[] {
  return cp.decorateSliceForSend(cp.sliceForPlayer(screenId)).surfaces;
}

/** The URL/src on a screen's first SENT surface (whatever kind it is), or undefined for none. */
function sentUrl(cp: ControlPlane, screenId: string): string | undefined {
  const s = sent(cp, screenId)[0];
  if (!s) return undefined;
  if (s.type === "web" || s.type === "dashboard") return s.url;
  if (s.type === "image" || s.type === "video") return s.src;
  return undefined;
}

/** The URL on a screen's STORED (desired) surface — what the takeover must leave alone. */
function storedUrl(cp: ControlPlane, screenId: string): string | undefined {
  const s = cp.state.slices[screenId]?.surfaces[0];
  return s && (s.type === "web" || s.type === "dashboard") ? s.url : undefined;
}

const DESIRED_A = "https://desired.test/a";
const DESIRED_B = "https://desired.test/b";
const ALERT = "https://alert.test/fire";
const EXEC = "https://exec.test/deck";

let store: MemoryStore;
let cp: ControlPlane;

/** Three screens across two machines; A + B placed adjacent on a mural, C placed on a second mural. */
async function fleet(): Promise<{ a: string; b: string; c: string; mural1: string; mural2: string }> {
  await cp.registerMachine(hello("m1", "HDMI-1", "HDMI-2"));
  await cp.registerMachine(hello("m2", "HDMI-1"));
  const [a, b, c] = cp.getScreens();
  const mural1 = await cp.createMural("Reception");
  const mural2 = await cp.createMural("Atrium");
  await cp.placeScreen(a!.id, mural1.id, 0, 0, 1920, 1080);
  await cp.placeScreen(b!.id, mural1.id, 1920, 0, 1920, 1080);
  await cp.placeScreen(c!.id, mural2.id, 0, 0, 1920, 1080);
  await cp.setScreenContent(a!.id, { url: DESIRED_A });
  await cp.setScreenContent(b!.id, { url: DESIRED_B });
  return { a: a!.id, b: b!.id, c: c!.id, mural1: mural1.id, mural2: mural2.id };
}

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("composition — a layer, not a mutation (POL-90)", () => {
  test("a fleet takeover reaches every screen, including one showing nothing", async () => {
    const { a, b, c } = await fleet(); // c has no desired content at all

    const started = await cp.startOverride({ scope: "fleet", url: ALERT });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(new Set(started.screenIds)).toEqual(new Set([a, b, c]));

    expect(sentUrl(cp, a)).toBe(ALERT);
    expect(sentUrl(cp, b)).toBe(ALERT);
    expect(sentUrl(cp, c)).toBe(ALERT);
  });

  test("desired state is NOT touched — the takeover exists only on the way out of the door", async () => {
    const { a } = await fleet();
    await cp.startOverride({ scope: "fleet", url: ALERT });

    expect(storedUrl(cp, a)).toBe(DESIRED_A); // the stored slice still holds the operator's content
    expect(sentUrl(cp, a)).toBe(ALERT); // only the send-time composition shows the takeover
  });

  test("the composed surface REUSES the desired surface id — the player swaps in place, no remount", async () => {
    const { a } = await fleet();
    const desiredId = cp.state.slices[a]!.surfaces[0]!.id;

    await cp.startOverride({ scope: "screen", targetId: a, url: ALERT });
    expect(sent(cp, a)[0]!.id).toBe(desiredId);
  });

  test("ending a takeover brings the desired content straight back, with no residue", async () => {
    const { a } = await fleet();
    const started = await cp.startOverride({ scope: "fleet", url: ALERT });
    if (!started.ok) return;

    const ended = await cp.endOverride(started.override.id);
    expect(ended?.overrides).toHaveLength(1);
    expect(sentUrl(cp, a)).toBe(DESIRED_A);
    expect(cp.getOverrides()).toHaveLength(0);
  });

  test("a takeover bumps the revision — the walls' content changed, so players reconcile", async () => {
    await fleet();
    const before = cp.state.revision;
    const started = await cp.startOverride({ scope: "fleet", url: ALERT });
    expect(cp.state.revision).toBeGreaterThan(before);
    if (!started.ok) return;
    const during = cp.state.revision;
    await cp.endOverride(started.override.id);
    expect(cp.state.revision).toBeGreaterThan(during);
  });

  test("an ad-hoc URL rides the ContentAssignment path; a library source rides it too (and is labelled)", async () => {
    const { a } = await fleet();
    const created = await cp.createContentSource({ name: "Evacuation notice", kind: "image", url: "https://cdn.test/evac.png" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const started = await cp.startOverride({ scope: "screen", targetId: a, sourceId: created.source.id });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.override.label).toBe("Evacuation notice");

    const surface = sent(cp, a)[0]!;
    expect(surface.type).toBe("image"); // resolved to the SOURCE's kind, not forced to web
    expect(sentUrl(cp, a)).toBe("https://cdn.test/evac.png");
  });

  test("a takeover over a video wall SPANS it — the same span math, the same keyed surface id", async () => {
    const { a, b, mural1 } = await fleet();
    const combined = await cp.combineScreens(mural1, [a, b]);
    expect(combined.ok).toBe(true);
    if (!combined.ok) return;
    await cp.setWallContent(combined.wall.id, { url: DESIRED_A });

    await cp.startOverride({ scope: "fleet", url: ALERT });

    const sa = sent(cp, a)[0]!;
    const sb = sent(cp, b)[0]!;
    expect(sa.id).toBe(`wall:${combined.wall.id}`); // same keyed id the wall's content used
    expect(sb.id).toBe(`wall:${combined.wall.id}`);
    // Union bbox of the two 1920×1080 panels: 3840×1080; B is offset one panel to the right.
    expect(sa.span).toEqual({ contentW: 3840, contentH: 1080, offsetX: 0, offsetY: 0 });
    expect(sb.span).toEqual({ contentW: 3840, contentH: 1080, offsetX: 1920, offsetY: 0 });
    expect(sentUrl(cp, a)).toBe(ALERT);
  });

  test("a SCREEN-scope cast on a wall member lands on that panel alone (it is not a wall takeover)", async () => {
    const { a, b, mural1 } = await fleet();
    const combined = await cp.combineScreens(mural1, [a, b]);
    if (!combined.ok) return;
    await cp.setWallContent(combined.wall.id, { url: DESIRED_A });

    await cp.startOverride({ scope: "screen", targetId: a, url: EXEC });

    expect(sent(cp, a)[0]!.span).toBeUndefined(); // the cast fills that one panel
    expect(sentUrl(cp, a)).toBe(EXEC);
    expect(sentUrl(cp, b)).toBe(DESIRED_A); // its wall-mate is untouched
  });
});

describe("precedence — screen > wall > mural > fleet (POL-90)", () => {
  test("the most specific layer wins, and ending it falls back to the next-broadest — not to desired", async () => {
    const { a, b, c, mural1 } = await fleet();

    const fleetTakeover = await cp.startOverride({ scope: "fleet", url: ALERT });
    const muralTakeover = await cp.startOverride({ scope: "mural", targetId: mural1, url: "https://mural.test/x" });
    const screenCast = await cp.startOverride({ scope: "screen", targetId: a, url: EXEC });
    if (!fleetTakeover.ok || !muralTakeover.ok || !screenCast.ok) return;

    expect(sentUrl(cp, a)).toBe(EXEC); // screen beats mural beats fleet
    expect(sentUrl(cp, b)).toBe("https://mural.test/x"); // mural beats fleet
    expect(sentUrl(cp, c)).toBe(ALERT); // on another mural — only the fleet layer reaches it

    await cp.endOverride(screenCast.override.id);
    expect(sentUrl(cp, a)).toBe("https://mural.test/x"); // falls back to the mural layer

    await cp.endOverride(muralTakeover.override.id);
    expect(sentUrl(cp, a)).toBe(ALERT); // then to the fleet layer

    await cp.endOverride(fleetTakeover.override.id);
    expect(sentUrl(cp, a)).toBe(DESIRED_A); // and finally to desired state
  });

  test("a wall takeover beats a mural one, and is beaten by a screen cast", async () => {
    const { a, b, mural1 } = await fleet();
    const combined = await cp.combineScreens(mural1, [a, b]);
    if (!combined.ok) return;

    await cp.startOverride({ scope: "mural", targetId: mural1, url: "https://mural.test/x" });
    await cp.startOverride({ scope: "wall", targetId: combined.wall.id, url: ALERT });
    expect(sentUrl(cp, a)).toBe(ALERT);
    expect(sentUrl(cp, b)).toBe(ALERT);

    await cp.startOverride({ scope: "screen", targetId: b, url: EXEC });
    expect(sentUrl(cp, a)).toBe(ALERT);
    expect(sentUrl(cp, b)).toBe(EXEC);
  });

  test("re-casting the SAME target replaces its layer rather than stacking a second one", async () => {
    const { a } = await fleet();
    await cp.startOverride({ scope: "screen", targetId: a, url: EXEC });
    await cp.startOverride({ scope: "screen", targetId: a, url: ALERT });

    expect(cp.getOverrides()).toHaveLength(1);
    expect(sentUrl(cp, a)).toBe(ALERT);
  });

  test("a takeover is refused when its target or its content does not exist", async () => {
    const { a } = await fleet();
    expect(await cp.startOverride({ scope: "screen", targetId: "screen-404", url: ALERT })).toEqual({
      ok: false,
      error: "unknown-screen",
    });
    expect(await cp.startOverride({ scope: "mural", targetId: "mural-404", url: ALERT })).toEqual({
      ok: false,
      error: "unknown-mural",
    });
    expect(await cp.startOverride({ scope: "wall", targetId: "wall-404", url: ALERT })).toEqual({
      ok: false,
      error: "unknown-wall",
    });
    expect(await cp.startOverride({ scope: "screen", targetId: a, sourceId: "source-404" })).toEqual({
      ok: false,
      error: "unknown-source",
    });
  });
});

describe("TTL auto-revert — the whole point (POL-90)", () => {
  test("expireOverrides drops a layer past its TTL and leaves a live one alone (injected clock)", async () => {
    const { a, b, mural1 } = await fleet();
    const started = await cp.startOverride({ scope: "mural", targetId: mural1, url: ALERT, ttlSeconds: 1800 });
    if (!started.ok) return;
    const startedMs = Date.parse(started.override.startedAt);

    const early = await cp.expireOverrides(startedMs + 1_799_000);
    expect(early.overrides).toHaveLength(0);
    expect(sentUrl(cp, a)).toBe(ALERT);

    const late = await cp.expireOverrides(startedMs + 1_800_001);
    expect(late.overrides.map((o) => o.id)).toEqual([started.override.id]);
    expect(new Set(late.screenIds)).toEqual(new Set([a, b]));

    expect(cp.getOverrides()).toHaveLength(0);
    expect(sentUrl(cp, a)).toBe(DESIRED_A);
    expect(sentUrl(cp, b)).toBe(DESIRED_B);
  });

  test("an EXPIRED layer never paints, even before the sweep has run", async () => {
    const { a } = await fleet();
    // A one-second TTL, then look at what a player connecting two seconds later would be sent —
    // without calling expireOverrides at all. A wall must never render a takeover that has run out.
    const started = await cp.startOverride({ scope: "fleet", url: ALERT, ttlSeconds: 10 });
    if (!started.ok) return;
    expect(sentUrl(cp, a)).toBe(ALERT);

    // Rewrite the record's expiry into the past (the same thing the clock does, ten seconds later).
    const expired = { ...started.override, expiresAt: new Date(Date.now() - 1).toISOString() };
    // @ts-expect-error — reaching into the private map is exactly the point: no sweep has run.
    cp.overrides.set(expired.id, expired);

    expect(sentUrl(cp, a)).toBe(DESIRED_A);
  });

  test("a takeover with no TTL runs until an operator ends it", async () => {
    const { a } = await fleet();
    await cp.startOverride({ scope: "fleet", url: ALERT });

    const swept = await cp.expireOverrides(Date.now() + 365 * 24 * 3600 * 1000);
    expect(swept.overrides).toHaveLength(0);
    expect(sentUrl(cp, a)).toBe(ALERT);
  });

  test("a screen cast expiring UNDER a live fleet takeover falls back to the fleet layer", async () => {
    const { a } = await fleet();
    await cp.startOverride({ scope: "fleet", url: ALERT });
    const cast = await cp.startOverride({ scope: "screen", targetId: a, url: EXEC, ttlSeconds: 60 });
    if (!cast.ok) return;

    await cp.expireOverrides(Date.parse(cast.override.startedAt) + 61_000);
    expect(sentUrl(cp, a)).toBe(ALERT); // not DESIRED_A — the broader layer is still running
  });
});

describe("nothing may strand a wall (POL-90)", () => {
  test("a takeover whose library source is deleted under it falls back to the desired content", async () => {
    const { a } = await fleet();
    const created = await cp.createContentSource({ name: "Notice", kind: "web", url: "https://notice.test/x" });
    if (!created.ok) return;
    await cp.startOverride({ scope: "fleet", sourceId: created.source.id });
    expect(sentUrl(cp, a)).toBe("https://notice.test/x");

    await cp.deleteContentSource(created.source.id);

    // Before the sweep reaps it, the composition already refuses to paint an unresolvable layer.
    expect(sentUrl(cp, a)).toBe(DESIRED_A);

    // And the sweep drops the record itself, so the console's chip strip does not lie.
    const reaped = await cp.reapOrphanedOverrides();
    expect(reaped.overrides).toHaveLength(1);
    expect(cp.getOverrides()).toHaveLength(0);
  });

  test("a takeover on a wall that is split under it is reaped, and the members return to desired", async () => {
    const { a, b, mural1 } = await fleet();
    const combined = await cp.combineScreens(mural1, [a, b]);
    if (!combined.ok) return;
    await cp.startOverride({ scope: "wall", targetId: combined.wall.id, url: ALERT });

    await cp.splitWall(combined.wall.id);
    const reaped = await cp.reapOrphanedOverrides();

    expect(reaped.overrides).toHaveLength(1);
    expect(cp.getOverrides()).toHaveLength(0);
  });
});

describe("restart — a fire-alarm takeover survives a pod bounce (POL-90)", () => {
  test("a live takeover is reloaded from the store and still paints", async () => {
    const { a } = await fleet();
    await cp.startOverride({ scope: "fleet", url: ALERT, ttlSeconds: 3600 });

    // Restart: a brand-new control plane over the SAME store, exactly like a pod bounce.
    const restarted = new ControlPlane(store);
    await restarted.init();

    expect(restarted.getOverrides()).toHaveLength(1);
    expect(sentUrl(restarted, a)).toBe(ALERT);
    expect(storedUrl(restarted, a)).toBe(DESIRED_A); // and desired state came back untouched
  });

  test("a takeover whose TTL ran out while the server was DOWN is dropped on load, not resurrected", async () => {
    const { a } = await fleet();
    const started = await cp.startOverride({ scope: "fleet", url: ALERT, ttlSeconds: 10 });
    if (!started.ok) return;

    // Backdate the row's expiry: the same state the store would be in after ten seconds of downtime.
    await store.upsertOverride({
      id: started.override.id,
      scope: "fleet",
      targetId: null,
      sourceId: null,
      url: ALERT,
      label: started.override.label,
      startedAt: started.override.startedAt,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const restarted = new ControlPlane(store);
    await restarted.init();

    expect(restarted.getOverrides()).toHaveLength(0);
    expect(await store.listOverrides()).toHaveLength(0); // the dead row is deleted, not just ignored
    expect(sentUrl(restarted, a)).toBe(DESIRED_A);
  });

  test("override ids do not collide after a restart", async () => {
    await fleet();
    await cp.startOverride({ scope: "fleet", url: ALERT, ttlSeconds: 3600 });

    const restarted = new ControlPlane(store);
    await restarted.init();
    const second = await restarted.startOverride({ scope: "fleet", url: EXEC, ttlSeconds: 60 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.override.id).toBe("override-2");
  });
});
