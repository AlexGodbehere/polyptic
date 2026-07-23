/**
 * POL-181 — the per-screen interactivity toggle, through the ControlPlane.
 *
 * `interactive` is a display preference like the POL-119 cast toggle: persistent, TTL-less, never
 * render data (no revision bump). The load-bearing property is the send-time fold: the STORED slice
 * keeps each web surface's authored `interactive` value, and `decorateSliceForSend` ORs the screen
 * flag in on the way out — so turning the screen toggle off restores exactly what was authored.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { WebSurface } from "@polyptic/protocol";

import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function hello(machineId: string): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: [
      { connector: "DP-1", width: 1920, height: 1080 },
      { connector: "DP-2", width: 1920, height: 1080 },
    ],
    hostname: "box",
  };
}

let store: MemoryStore;
let cp: ControlPlane;
let screenId: string;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
  await cp.registerMachine(hello("box-1"), undefined);
  screenId = cp.getScreens().find((s) => s.connector === "DP-1")!.id;
});

describe("the toggle itself (POL-181)", () => {
  test("screens are born non-interactive", () => {
    for (const s of cp.getScreens()) expect(s.interactive).toBe(false);
  });

  test("enabling sets the flag; disabling clears it; unknown screen → null", async () => {
    const on = await cp.setScreenInteractive(screenId, true);
    expect(on?.interactive).toBe(true);
    const off = await cp.setScreenInteractive(screenId, false);
    expect(off?.interactive).toBe(false);
    expect(await cp.setScreenInteractive("screen-nope", true)).toBeNull();
  });

  test("toggling does NOT bump the revision (not render data)", async () => {
    const before = cp.state.revision;
    await cp.setScreenInteractive(screenId, true);
    expect(cp.state.revision).toBe(before);
  });

  test("the flag persists across a control-plane restart", async () => {
    await cp.setScreenInteractive(screenId, true);
    const cp2 = new ControlPlane(store);
    await cp2.init();
    expect(cp2.getScreen(screenId)?.interactive).toBe(true);
  });

  test("a rename never disturbs the flag (both ride upsertScreen)", async () => {
    await cp.setScreenInteractive(screenId, true);
    await cp.renameScreen(screenId, "Reception Kiosk");
    const cp2 = new ControlPlane(store);
    await cp2.init();
    const screen = cp2.getScreen(screenId);
    expect(screen?.friendlyName).toBe("Reception Kiosk");
    expect(screen?.interactive).toBe(true);
  });
});

describe("the send-time fold into web surfaces", () => {
  function sentWebSurface(id: string): WebSurface {
    const slice = cp.decorateSliceForSend(cp.sliceForPlayer(id));
    const surface = slice.surfaces[0];
    if (surface?.type !== "web") throw new Error(`expected a web surface, got ${surface?.type}`);
    return surface;
  }

  test("an interactive screen's web surfaces go out interactive; the stored slice stays clean", async () => {
    await cp.setScreenContent(screenId, { url: "https://example.com/kiosk" });
    expect(sentWebSurface(screenId).interactive).toBe(false);

    await cp.setScreenInteractive(screenId, true);
    expect(sentWebSurface(screenId).interactive).toBe(true);
    // Clean at rest: the STORED slice keeps the authored value — only the send-time copy changed.
    const stored = cp.sliceForPlayer(screenId).surfaces[0] as WebSurface;
    expect(stored.interactive).toBe(false);

    await cp.setScreenInteractive(screenId, false);
    expect(sentWebSurface(screenId).interactive).toBe(false);
  });

  test("the fold is per-screen: the other screen's surfaces are untouched", async () => {
    const other = cp.getScreens().find((s) => s.connector === "DP-2")!.id;
    await cp.setScreenContent(screenId, { url: "https://example.com/kiosk" });
    await cp.setScreenContent(other, { url: "https://example.com/wall" });
    await cp.setScreenInteractive(screenId, true);
    expect(sentWebSurface(screenId).interactive).toBe(true);
    expect(sentWebSurface(other).interactive).toBe(false);
  });

  test("non-web surfaces pass through the fold unchanged", async () => {
    const created = await cp.createContentSource({
      name: "Poster",
      kind: "image",
      url: "https://example.com/photo.png",
    });
    if (!created.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: created.source.id });
    await cp.setScreenInteractive(screenId, true);
    const slice = cp.decorateSliceForSend(cp.sliceForPlayer(screenId));
    expect(slice.surfaces[0]?.type).toBe("image");
    expect("interactive" in (slice.surfaces[0] as object)).toBe(false);
  });
});
