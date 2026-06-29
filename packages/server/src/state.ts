/**
 * In-memory desired-state for the Polyptych control plane.
 *
 * This module owns the single global `DesiredState` (revision starts at 0) plus the machine
 * registry. It knows nothing about sockets or HTTP — it is pure state + mutations. Any change
 * to the desired state bumps `revision`, mirroring a Kubernetes controller's `generation`.
 *
 * Screen ids are assigned sequentially ("screen-1", "screen-2", …) in agent-registration order,
 * so the first registered output is predictably "screen-1". The mapping is stable per
 * (machineId, connector): a reconnecting machine reuses its existing screen ids.
 */
import { WebSurface } from "@polyptych/protocol";
import type {
  DesiredState,
  DisplayBackend,
  Machine,
  Output,
  Screen,
  ScreenSlice,
  Surface,
} from "@polyptych/protocol";

/** Where players live. The agent points each output's Chromium/browser at this base + ?screen=<id>. */
const PLAYER_BASE_URL = process.env.PLAYER_BASE_URL ?? "http://localhost:5173";

/** Fallback canvas for a player that connects before its screen is known. */
const DEFAULT_CANVAS = { x: 0, y: 0, w: 1920, h: 1080 } as const;

function playerUrlFor(screenId: string): string {
  return `${PLAYER_BASE_URL}/?screen=${encodeURIComponent(screenId)}`;
}

/** One entry of the `server/apply` payload: which screen an output is, and where to point its player. */
export interface ScreenAssignment {
  connector: string;
  screenId: string;
  playerUrl: string;
}

export interface RegisterMachineInput {
  machineId: string;
  agentVersion: string;
  backend: DisplayBackend;
  outputs: Output[];
}

export interface RegisterMachineResult {
  /** True if registration changed desired state (new screen(s) created) and bumped the revision. */
  changed: boolean;
  assignments: ScreenAssignment[];
}

export class ControlPlane {
  /** The single global desired state. Held by reference; mutated in place, revision-bumped on change. */
  readonly state: DesiredState = {
    revision: 0,
    activeSceneId: null,
    screens: [],
    slices: {},
  };

  private readonly machines = new Map<string, Machine>();
  private screenCounter = 0;

  private bumpRevision(): number {
    this.state.revision += 1;
    return this.state.revision;
  }

  /**
   * Upsert a machine and ensure a Screen (+ empty slice) exists per output.
   * Returns the per-output assignments for the `server/apply` reply.
   */
  registerMachine(input: RegisterMachineInput): RegisterMachineResult {
    this.machines.set(input.machineId, {
      id: input.machineId,
      label: input.machineId,
      agentVersion: input.agentVersion,
      backend: input.backend,
      outputs: input.outputs,
      lastSeen: new Date().toISOString(),
    });

    let changed = false;
    const assignments: ScreenAssignment[] = [];

    for (const output of input.outputs) {
      let screen = this.state.screens.find(
        (s) => s.machineId === input.machineId && s.connector === output.connector,
      );

      if (!screen) {
        this.screenCounter += 1;
        const id = `screen-${this.screenCounter}`;
        screen = {
          id,
          friendlyName: `Screen ${this.screenCounter}`,
          machineId: input.machineId,
          connector: output.connector,
        } satisfies Screen;
        this.state.screens.push(screen);
        this.state.slices[id] = {
          screenId: id,
          canvas: { x: 0, y: 0, w: output.width, h: output.height },
          surfaces: [],
        };
        changed = true;
      } else if (this.state.slices[screen.id] === undefined) {
        // Screen known but its slice is missing (shouldn't normally happen) — heal it.
        this.state.slices[screen.id] = {
          screenId: screen.id,
          canvas: { x: 0, y: 0, w: output.width, h: output.height },
          surfaces: [],
        };
        changed = true;
      }

      assignments.push({
        connector: output.connector,
        screenId: screen.id,
        playerUrl: playerUrlFor(screen.id),
      });
    }

    if (changed) this.bumpRevision();
    return { changed, assignments };
  }

  getScreens(): Screen[] {
    return this.state.screens;
  }

  getMachines(): Machine[] {
    return [...this.machines.values()];
  }

  /** The stored slice for a screen, if any. */
  getSlice(screenId: string): ScreenSlice | undefined {
    return this.state.slices[screenId];
  }

  /** The slice to render for a connecting player — stored slice, or a synthesized empty default. */
  sliceForPlayer(screenId: string): ScreenSlice {
    return (
      this.state.slices[screenId] ?? {
        screenId,
        canvas: { ...DEFAULT_CANVAS },
        surfaces: [],
      }
    );
  }

  /**
   * Replace a screen's surfaces wholesale, bump the revision, return the new slice.
   * Returns null if the screen is unknown.
   */
  setScreenSurfaces(screenId: string, surfaces: Surface[]): ScreenSlice | null {
    const slice = this.state.slices[screenId];
    if (slice === undefined) return null;
    const next: ScreenSlice = { ...slice, surfaces };
    this.state.slices[screenId] = next;
    this.bumpRevision();
    return next;
  }

  /**
   * Convenience for the demo: replace a screen's slice with ONE full-canvas web surface.
   * Returns null if the screen is unknown.
   */
  setDemoWeb(screenId: string, url: string): ScreenSlice | null {
    const slice = this.state.slices[screenId];
    if (slice === undefined) return null;
    const surface = WebSurface.parse({
      // Stable id so consecutive demo pushes reconcile to the SAME keyed tile — the player
      // mutates the existing <iframe> src in place (DOM diff) instead of tearing it down.
      id: "demo-web",
      type: "web",
      region: { x: 0, y: 0, w: slice.canvas.w, h: slice.canvas.h },
      url,
      placement: "iframe",
      interactive: false,
    });
    const next: ScreenSlice = { ...slice, surfaces: [surface] };
    this.state.slices[screenId] = next;
    this.bumpRevision();
    return next;
  }
}
