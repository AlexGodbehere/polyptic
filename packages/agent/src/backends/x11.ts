/**
 * x11-i3 — the real X11/i3 placement backend (fallback for hosts where Wayland misbehaves).
 *
 * Phase 4. Stubbed but interface-conformant. Placement will use i3 IPC / `wmctrl`-style
 * window control and capture an X11 grabber.
 */
import type { DisplayBackend } from "./types";

const NOT_IMPLEMENTED = "not implemented (Phase 4)";

export class X11Backend implements DisplayBackend {
  readonly id = "x11-i3" as const;

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
