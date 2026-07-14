/**
 * The takeover sweeper (POL-90) — the thing that makes auto-revert true.
 *
 * A takeover is a layer over desired state, composed at send time; its TTL is a plain `expiresAt` on
 * one record. This loop is what NOTICES the instant has passed: every tick it asks the control plane
 * to drop any layer that has run out (`expireOverrides(now)`), then re-pushes the affected screens —
 * and that re-push, of the SAME desired slice that was underneath all along, IS the revert. It also
 * reaps a layer whose target or content has ceased to exist, so a split wall or a deleted source can
 * never leave a takeover hanging in the console with nothing behind it.
 *
 * The expiry decision itself lives in the control plane and takes an injected clock, so it is tested
 * without waiting on wall-clock time; this module is only the timer + the fan-out.
 *
 * Belt and braces: `effectiveOverride` ALSO ignores an expired layer, so a slice sent in the gap
 * between the expiry instant and the next tick is already the reverted one. The sweep exists to
 * PUSH that revert to walls that are sitting there rendering, not to make it true.
 */
import { ServerToPlayerRender } from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";

import type { AdminBroadcaster } from "./admin";
import type { PlayerHub } from "./hub";
import type { ControlPlane } from "./state";

/** How often the sweep runs. A takeover's countdown is displayed in seconds, so a second is enough. */
export const OVERRIDE_SWEEP_INTERVAL_MS = 1_000;

export interface OverrideSweeperDeps {
  control: ControlPlane;
  hub: PlayerHub;
  broadcaster: AdminBroadcaster;
  log: FastifyBaseLogger;
  intervalMs?: number;
}

/**
 * Drop every expired/orphaned takeover NOW and re-push the screens it covered. Exported (and
 * awaited) so tests can drive one sweep deterministically instead of racing a timer.
 * Returns the number of screens re-pushed.
 */
export async function sweepOverrides(deps: Omit<OverrideSweeperDeps, "intervalMs">): Promise<number> {
  const { control, hub, broadcaster, log } = deps;

  const expired = await control.expireOverrides(Date.now());
  const orphaned = await control.reapOrphanedOverrides();
  const dropped = [...expired.overrides, ...orphaned.overrides];
  if (dropped.length === 0) return 0;

  const screenIds = new Set([...expired.screenIds, ...orphaned.screenIds]);
  for (const screenId of screenIds) {
    const message = ServerToPlayerRender.parse({
      t: "server/render",
      revision: control.state.revision,
      friendlyName: control.getScreen(screenId)?.friendlyName ?? screenId,
      // The composed send-time slice — with the layer gone, this is the desired content again (or a
      // still-live broader takeover, e.g. a screen cast expiring under a running fleet broadcast).
      slice: control.decorateSliceForSend(control.sliceForPlayer(screenId)),
    });
    hub.send(screenId, message);
  }

  log.info(
    {
      event: "override.sweep",
      dropped: dropped.map((o) => o.id),
      screens: screenIds.size,
      revision: control.state.revision,
    },
    "takeover(s) reverted",
  );
  broadcaster.broadcast();
  return screenIds.size;
}

/** Start the sweep loop. Returns a stop function. The timer is unref'd so it never holds the process. */
export function startOverrideSweeper(deps: OverrideSweeperDeps): () => void {
  const intervalMs = deps.intervalMs ?? OVERRIDE_SWEEP_INTERVAL_MS;
  let running = false;
  const timer = setInterval(() => {
    // A sweep is I/O (it deletes rows); never let two overlap.
    if (running) return;
    running = true;
    void sweepOverrides(deps)
      .catch((err: unknown) => {
        deps.log.error({ event: "override.sweep.failed", err }, "takeover sweep failed");
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
