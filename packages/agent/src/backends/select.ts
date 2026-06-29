/**
 * Backend selection.
 *
 * Explicit override via `POLYPTIC_BACKEND` (dev-open | wayland-sway | x11-i3).
 * With no override, auto-detect ALWAYS returns dev-open in Phase 1: the sway/x11 backends
 * are Phase-4 stubs whose methods throw, so auto-selecting them off $WAYLAND_DISPLAY/$DISPLAY
 * could never succeed (and would break zero-click auto-open on a Linux desktop). Force them
 * explicitly with POLYPTIC_BACKEND once they're implemented.
 */
import type { DisplayBackend } from "./types";
import { DevOpenBackend } from "./dev-open";
import { SwayBackend } from "./sway";
import { X11Backend } from "./x11";

export function selectBackend(env: NodeJS.ProcessEnv = process.env): DisplayBackend {
  const forced = env.POLYPTIC_BACKEND?.trim();
  if (forced) {
    switch (forced) {
      case "dev-open":
        return new DevOpenBackend();
      case "wayland-sway":
      case "sway":
        return new SwayBackend();
      case "x11-i3":
      case "x11":
        return new X11Backend();
      default:
        throw new Error(
          `Unknown POLYPTIC_BACKEND="${forced}" (expected: dev-open | wayland-sway | x11-i3)`,
        );
    }
  }

  // Phase 1: never auto-select the throwing sway/x11 stubs — default to dev-open.
  return new DevOpenBackend();
}
