/**
 * POL-183 — the relaunch contract of the supervised browser's launch target.
 *
 * `--hide-scrollbars` is a LAUNCH flag: Chrome takes it only at startup, so flipping the per-screen
 * setting is only real if the supervisor treats it as part of the target and relaunches. These pin
 * exactly that: a flag flip = exactly one relaunch; an unchanged target = a no-op; and the absent
 * field reads TRUE (an old server's silence must not flip a fleet's scrollbars on).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";

import { SupervisedBrowser } from "../src/backends/supervise";

const URL = "http://localhost:5173/player?screen=screen-1";

let browser: SupervisedBrowser | null = null;

afterEach(async () => {
  await browser?.stop();
  browser = null;
});

/** A SupervisedBrowser whose "browser" is a sleeping child; counts every launch it makes. */
function supervised(): { b: SupervisedBrowser; launches: () => number } {
  let count = 0;
  const launch = async (): Promise<ChildProcess> => {
    count += 1;
    return spawn("sleep", ["60"]);
  };
  const b = new SupervisedBrowser("DP-1", launch, () => {});
  browser = b;
  return { b, launches: () => count };
}

describe("hideScrollbars is part of the launch target (POL-183)", () => {
  test("an unchanged target is a no-op; a flag flip relaunches exactly once", async () => {
    const { b, launches } = supervised();
    await b.setUrl(URL, true);
    expect(launches()).toBe(1);

    // Same url, same flag — the supervisor must not touch the running browser.
    await b.setUrl(URL, true);
    expect(launches()).toBe(1);

    // The flip: same url, new flag — exactly one relaunch (the launch flag cannot be applied live).
    await b.setUrl(URL, false);
    expect(launches()).toBe(2);
    expect(b.hideScrollbars).toBe(false);

    // And back, still exactly one more.
    await b.setUrl(URL, true);
    expect(launches()).toBe(3);
    expect(b.hideScrollbars).toBe(true);
  });

  test("an omitted flag preserves the current value — a pre-POL-183 caller changes nothing", async () => {
    const { b, launches } = supervised();
    await b.setUrl(URL, false);
    expect(launches()).toBe(1);
    await b.setUrl(URL); // omitted → keep false, same target, no relaunch
    expect(launches()).toBe(1);
    expect(b.hideScrollbars).toBe(false);
  });

  test("the absent field reads TRUE, and equals an explicit true (no phantom relaunch)", async () => {
    const { b, launches } = supervised();
    await b.setUrl(URL); // nothing desired yet → defaults to hidden
    expect(b.hideScrollbars).toBe(true);
    expect(launches()).toBe(1);
    await b.setUrl(URL, true); // explicit true must compare equal to the absent default
    expect(launches()).toBe(1);
  });

  test("an inspector toggle preserves the scrollbar setting", async () => {
    const { b, launches } = supervised();
    await b.setUrl(URL, false);
    await b.setInspector(true);
    expect(launches()).toBe(2); // the inspector flip itself relaunches (surf -N semantics)
    expect(b.hideScrollbars).toBe(false);
    expect(b.inspector).toBe(true);
  });
});
