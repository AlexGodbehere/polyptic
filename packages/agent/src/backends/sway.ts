/**
 * wayland-sway — the real Wayland/sway placement backend.
 *
 * Phase 4. Stubbed but interface-conformant so the rest of the agent type-checks and so
 * `select.ts` can route to it once implemented. Placement will go through `swaymsg` IPC
 * (Wayland forbids client self-positioning) and capture through `grim`.
 */
import type { DisplayBackend } from "./types";

const NOT_IMPLEMENTED = "not implemented (Phase 4)";

export class SwayBackend implements DisplayBackend {
  readonly id = "wayland-sway" as const;

  async showScreen(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async hideScreen(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async ident(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async capture(): Promise<Buffer | null> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
