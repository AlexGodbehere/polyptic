/**
 * The POL-181 wire contract: per-screen interactivity.
 *
 * `Screen.interactive` DEFAULTS false — a screen record written before POL-181 (no field at all)
 * must parse, and must parse as non-interactive: the wall's glanceable-by-default posture is the
 * safe failure. The flag itself never grows a new player message — it is folded into each web
 * surface's existing `interactive` at send time — so the only shapes here are the Screen record
 * and the REST body.
 */
import { describe, expect, test } from "bun:test";

import {
  HideScrollbarsBody,
  InteractiveBody,
  Screen,
  ScreenView,
  ServerToAgentApply,
} from "../src/index";

const BARE_SCREEN = {
  id: "screen-1",
  friendlyName: "Reception Kiosk",
  machineId: "wall-1",
  connector: "DP-1",
} as const;

describe("POL-181 contract", () => {
  test("a pre-POL-181 screen record parses, and parses as NON-interactive", () => {
    const parsed = Screen.parse(BARE_SCREEN);
    expect(parsed.interactive).toBe(false);
  });

  test("the flag roundtrips through parse", () => {
    expect(Screen.parse({ ...BARE_SCREEN, interactive: true }).interactive).toBe(true);
    expect(Screen.parse({ ...BARE_SCREEN, interactive: false }).interactive).toBe(false);
  });

  test("ScreenView inherits the flag from Screen", () => {
    const view = ScreenView.parse({
      ...BARE_SCREEN,
      interactive: true,
      online: true,
      revision: 3,
      surfaceCount: 1,
    });
    expect(view.interactive).toBe(true);
  });

  test("the REST body accepts exactly {enabled: boolean}", () => {
    expect(InteractiveBody.parse({ enabled: true })).toEqual({ enabled: true });
    expect(() => InteractiveBody.parse({})).toThrow();
    expect(() => InteractiveBody.parse({ enabled: "yes" })).toThrow();
  });
});

describe("POL-183 contract (mind the polarity: absent means TRUE)", () => {
  test("a pre-POL-183 screen record parses with scrollbars HIDDEN — the clean-wall default", () => {
    expect(Screen.parse(BARE_SCREEN).hideScrollbars).toBe(true);
  });

  test("the opt-out roundtrips through parse", () => {
    expect(Screen.parse({ ...BARE_SCREEN, hideScrollbars: false }).hideScrollbars).toBe(false);
  });

  test("an OLD server's apply (no hideScrollbars on the wire) still parses; the field stays absent", () => {
    const apply = ServerToAgentApply.parse({
      t: "server/apply",
      revision: 1,
      machineId: "wall-1",
      screens: [
        {
          connector: "DP-1",
          screenId: "screen-1",
          playerUrl: "http://localhost:5173/?screen=screen-1",
        },
      ],
    });
    // Absent on the wire — the AGENT resolves absence to true (its safe default), never the schema:
    // a default here would make a new server's explicit `false` indistinguishable from silence.
    expect(apply.screens[0]?.hideScrollbars).toBeUndefined();
  });

  test("a NEW server's apply carries the per-connector flag", () => {
    const apply = ServerToAgentApply.parse({
      t: "server/apply",
      revision: 1,
      machineId: "wall-1",
      screens: [
        {
          connector: "DP-1",
          screenId: "screen-1",
          playerUrl: "http://localhost:5173/?screen=screen-1",
          hideScrollbars: false,
        },
      ],
    });
    expect(apply.screens[0]?.hideScrollbars).toBe(false);
  });

  test("the REST body accepts exactly {enabled: boolean}", () => {
    expect(HideScrollbarsBody.parse({ enabled: false })).toEqual({ enabled: false });
    expect(() => HideScrollbarsBody.parse({})).toThrow();
  });
});
