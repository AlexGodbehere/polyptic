/**
 * POL-183 — the per-screen scrollbar toggle, through the ControlPlane.
 *
 * `hideScrollbars` is a display preference like the cast toggle (persistent, TTL-less, no revision
 * bump) with one twist: its polarity. DEFAULT TRUE — a screen record that predates the field must
 * read as hidden, so a fleet that never opted in still gets clean walls. And unlike POL-181's
 * `interactive` (player-side), it rides the AGENT apply: it is a Chrome launch flag.
 */
import { beforeEach, describe, expect, test } from "bun:test";

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

describe("per-screen scrollbars (POL-183)", () => {
  test("screens are born with scrollbars HIDDEN — the clean-wall default", () => {
    for (const s of cp.getScreens()) expect(s.hideScrollbars).toBe(true);
  });

  test("opting out clears the flag; opting back in restores it; unknown screen → null", async () => {
    const shown = await cp.setScreenHideScrollbars(screenId, false);
    expect(shown?.hideScrollbars).toBe(false);
    const hidden = await cp.setScreenHideScrollbars(screenId, true);
    expect(hidden?.hideScrollbars).toBe(true);
    expect(await cp.setScreenHideScrollbars("screen-nope", false)).toBeNull();
  });

  test("toggling does NOT bump the revision (not render data)", async () => {
    const before = cp.state.revision;
    await cp.setScreenHideScrollbars(screenId, false);
    expect(cp.state.revision).toBe(before);
  });

  test("an opted-out screen survives a control-plane restart", async () => {
    await cp.setScreenHideScrollbars(screenId, false);
    const cp2 = new ControlPlane(store);
    await cp2.init();
    expect(cp2.getScreen(screenId)?.hideScrollbars).toBe(false);
  });

  test("THE POLARITY: a legacy row with no field at all loads as HIDDEN, not shown", async () => {
    // Mimic a pre-POL-183 writer: the persisted row simply has no hideScrollbars key.
    await store.upsertScreen({
      id: screenId,
      friendlyName: "Legacy",
      machineId: "box-1",
      connector: "DP-1",
      castEnabled: false,
      variables: {},
    });
    const cp2 = new ControlPlane(store);
    await cp2.init();
    expect(cp2.getScreen(screenId)?.hideScrollbars).toBe(true);
  });

  test("assignmentsFor carries the flag per connector — the agent's launch input", async () => {
    await cp.setScreenHideScrollbars(screenId, false);
    const assignments = cp.assignmentsFor("box-1");
    expect(assignments).toHaveLength(2);
    expect(assignments.find((a) => a.connector === "DP-1")?.hideScrollbars).toBe(false);
    expect(assignments.find((a) => a.connector === "DP-2")?.hideScrollbars).toBe(true);
  });

  test("re-registration (agent reconnect) keeps the flag in the apply assignments", async () => {
    await cp.setScreenHideScrollbars(screenId, false);
    const result = await cp.registerMachine(hello("box-1"), undefined);
    expect(result.assignments.find((a) => a.connector === "DP-1")?.hideScrollbars).toBe(false);
  });
});
