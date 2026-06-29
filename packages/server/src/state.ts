/**
 * Desired-state for the Polyptic control plane, backed by a durable Store.
 *
 * This module owns the single global `DesiredState` (revision starts at 0) plus the machine
 * registry. It knows nothing about sockets or HTTP — it is state + mutations + write-through.
 *
 * Persistence (Phase 2a): on `init()` it LOADs the persisted registry from the Store into the
 * in-memory working copy and RESUMES the revision; every mutation WRITES THROUGH to the Store before
 * returning, so a rename — and everything else — survives a server restart.
 *
 * Enrollment (Phase 2b): a machine now carries an `EnrollmentStatus` and (off-band, never on the
 * wire `Machine`) a credential hash. Three registration paths replace the single Phase 2a one:
 *   - `registerMachine`  — OPEN MODE / admit: status `approved`, ensure a Screen per output, apply.
 *   - `enrollPending`    — GATED first contact: status `pending`, persist outputs, NO screens.
 *   - `approveMachine`   — operator approval: flip to `approved` + create screens from the persisted
 *                          outputs, returning assignments for a live `server/apply`.
 * `rejectMachine` flips status to `rejected`. The credential hash is held in a side map (the wire
 * `Machine` never carries it) and flows to/from storage via the `PersistedMachine` DTO.
 *
 * Screen ids are assigned sequentially ("screen-1", "screen-2", …) GLOBALLY across machines in
 * registration/approval order. The mapping is stable per (machineId, connector): a reconnecting
 * machine reuses its existing screen ids, and the counter resumes past the highest persisted id.
 */
import { WebSurface } from "@polyptic/protocol";
import type {
  DesiredState,
  DisplayBackend,
  Machine,
  Mural,
  Output,
  Placement,
  Screen,
  ScreenSlice,
  Surface,
} from "@polyptic/protocol";

import type { PersistedMachine, Store } from "./store/types";

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

/** Internal result of ensuring a Screen (+ slice) exists for each of a machine's outputs. */
interface EnsureScreensResult {
  assignments: ScreenAssignment[];
  newScreens: Screen[];
  touchedSlices: ScreenSlice[];
  changed: boolean;
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
  /** machineId → sha256(credential) hex. Kept off the wire `Machine`; persisted via the DTO. */
  private readonly credentialHashes = new Map<string, string>();
  private screenCounter = 0;

  /** Phase 3 — the named, switchable canvases. */
  private readonly murals = new Map<string, Mural>();
  /** Phase 3 — placements keyed by screenId (a screen is placed on at most one mural at a time). */
  private readonly placements = new Map<string, Placement>();
  private muralCounter = 0;

  constructor(private readonly store: Store) {}

  /** Project the in-memory machine (+ its side-mapped credential hash) onto the storage DTO. */
  private toPersistedMachine(machine: Machine): PersistedMachine {
    return {
      id: machine.id,
      label: machine.label,
      agentVersion: machine.agentVersion,
      backend: machine.backend,
      outputs: machine.outputs,
      status: machine.status,
      credentialHash: this.credentialHashes.get(machine.id),
      lastSeen: machine.lastSeen,
    };
  }

  /**
   * Load persisted registry state into memory and resume the revision + screen counter.
   * Call once on boot, after `store.migrate()`.
   */
  async init(): Promise<void> {
    const persisted = await this.store.load();

    this.state.revision = persisted.revision;

    for (const m of persisted.machines) {
      this.machines.set(m.id, {
        id: m.id,
        label: m.label,
        agentVersion: m.agentVersion,
        backend: m.backend,
        outputs: m.outputs,
        // Legacy rows without a status load as `approved` (Phase 2a parity).
        status: m.status ?? "approved",
        lastSeen: m.lastSeen,
      });
      if (m.credentialHash) this.credentialHashes.set(m.id, m.credentialHash);
    }

    for (const s of persisted.screens) {
      this.state.screens.push({
        id: s.id,
        friendlyName: s.friendlyName,
        machineId: s.machineId,
        connector: s.connector,
      });
    }

    for (const c of persisted.content) {
      this.state.slices[c.screenId] = {
        screenId: c.screenId,
        canvas: c.canvas,
        surfaces: c.surfaces,
      };
    }

    // Resume the global counter past the highest persisted "screen-N" so new ids stay unique.
    let max = 0;
    for (const s of this.state.screens) {
      const match = /^screen-(\d+)$/.exec(s.id);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n)) max = Math.max(max, n);
      }
    }
    this.screenCounter = max;

    // Heal: every known screen must have a slice (in case content rows lag behind screen rows).
    for (const s of this.state.screens) {
      if (this.state.slices[s.id] === undefined) {
        this.state.slices[s.id] = {
          screenId: s.id,
          canvas: { ...DEFAULT_CANVAS },
          surfaces: [],
        };
      }
    }

    // ── Murals & placement (Phase 3) ──────────────────────────────────────────
    for (const m of persisted.murals) {
      this.murals.set(m.id, { id: m.id, name: m.name });
    }
    // Resume the mural counter past the highest persisted "mural-N" so seeded/new ids stay unique.
    let maxMural = 0;
    for (const m of this.murals.values()) {
      const match = /^mural-(\d+)$/.exec(m.id);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n)) maxMural = Math.max(maxMural, n);
      }
    }
    this.muralCounter = maxMural;

    for (const p of persisted.placements) {
      this.placements.set(p.screenId, {
        muralId: p.muralId,
        screenId: p.screenId,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
      });
    }

    // Seed a default mural the first time a deployment boots, so the Wall view always has a canvas.
    if (this.murals.size === 0) {
      const id = this.nextMuralId();
      const mural: Mural = { id, name: "Wall" };
      this.murals.set(id, mural);
      await this.store.upsertMural({ id: mural.id, name: mural.name });
    }
  }

  private nextMuralId(): string {
    this.muralCounter += 1;
    return `mural-${this.muralCounter}`;
  }

  /** The native resolution to default a placement's w/h to: the screen's output, then its slice canvas. */
  private screenResolution(screen: Screen): { w: number; h: number } {
    const machine = this.machines.get(screen.machineId);
    const output = machine?.outputs.find((o) => o.connector === screen.connector);
    if (output) return { w: output.width, h: output.height };
    const slice = this.state.slices[screen.id];
    if (slice) return { w: slice.canvas.w, h: slice.canvas.h };
    return { w: DEFAULT_CANVAS.w, h: DEFAULT_CANVAS.h };
  }

  private bumpRevision(): number {
    this.state.revision += 1;
    return this.state.revision;
  }

  /**
   * Ensure a Screen (+ empty slice) exists for each output, creating + healing as needed. Pure in
   * memory: the caller is responsible for write-through. `changed` is true if a screen or slice was
   * created/healed (so the caller bumps + persists the revision).
   */
  private ensureScreens(machineId: string, outputs: Output[]): EnsureScreensResult {
    let changed = false;
    const assignments: ScreenAssignment[] = [];
    const newScreens: Screen[] = [];
    const touchedSlices: ScreenSlice[] = [];

    for (const output of outputs) {
      let screen = this.state.screens.find(
        (s) => s.machineId === machineId && s.connector === output.connector,
      );

      if (!screen) {
        this.screenCounter += 1;
        const id = `screen-${this.screenCounter}`;
        screen = {
          id,
          friendlyName: `Screen ${this.screenCounter}`,
          machineId,
          connector: output.connector,
        } satisfies Screen;
        this.state.screens.push(screen);
        const slice: ScreenSlice = {
          screenId: id,
          canvas: { x: 0, y: 0, w: output.width, h: output.height },
          surfaces: [],
        };
        this.state.slices[id] = slice;
        newScreens.push(screen);
        touchedSlices.push(slice);
        changed = true;
      } else if (this.state.slices[screen.id] === undefined) {
        // Screen known but its slice is missing (shouldn't normally happen) — heal it.
        const slice: ScreenSlice = {
          screenId: screen.id,
          canvas: { x: 0, y: 0, w: output.width, h: output.height },
          surfaces: [],
        };
        this.state.slices[screen.id] = slice;
        touchedSlices.push(slice);
        changed = true;
      }

      assignments.push({
        connector: output.connector,
        screenId: screen.id,
        playerUrl: playerUrlFor(screen.id),
      });
    }

    return { assignments, newScreens, touchedSlices, changed };
  }

  /** Write-through newly created screens + their (empty) content rows. */
  private async persistScreens(result: EnsureScreensResult): Promise<void> {
    for (const s of result.newScreens) {
      await this.store.upsertScreen({
        id: s.id,
        friendlyName: s.friendlyName,
        machineId: s.machineId,
        connector: s.connector,
      });
    }
    for (const slice of result.touchedSlices) {
      await this.store.upsertContent({
        screenId: slice.screenId,
        canvas: slice.canvas,
        surfaces: slice.surfaces,
      });
    }
  }

  /**
   * OPEN MODE / admit path. Upsert an `approved` machine and ensure a Screen (+ empty slice) exists
   * per output. Write-through: persists the machine, any newly created screens/content, and the
   * revision (if it changed). Returns the per-output assignments for the `server/apply` reply.
   *
   * `credentialHash`, when given (a token re-enrol of an approved machine), is stored so the machine
   * row persists the freshly issued credential alongside the screen work.
   */
  async registerMachine(
    input: RegisterMachineInput,
    credentialHash?: string,
  ): Promise<RegisterMachineResult> {
    if (credentialHash) this.credentialHashes.set(input.machineId, credentialHash);

    const existing = this.machines.get(input.machineId);
    const machine: Machine = {
      id: input.machineId,
      label: existing?.label ?? input.machineId,
      agentVersion: input.agentVersion,
      backend: input.backend,
      outputs: input.outputs,
      status: "approved",
      lastSeen: new Date().toISOString(),
    };
    this.machines.set(input.machineId, machine);

    const ensured = this.ensureScreens(input.machineId, input.outputs);
    if (ensured.changed) this.bumpRevision();

    await this.store.upsertMachine(this.toPersistedMachine(machine));
    await this.persistScreens(ensured);
    if (ensured.changed) await this.store.setRevision(this.state.revision);

    return { changed: ensured.changed, assignments: ensured.assignments };
  }

  /**
   * GATED first contact. Create (or refresh) the machine as `pending`, persist its reported outputs
   * and the issued credential hash, but create NO screens and do NOT bump the revision — pending
   * machines hold no desired state until an operator approves them.
   */
  async enrollPending(input: RegisterMachineInput, credentialHash: string): Promise<void> {
    this.credentialHashes.set(input.machineId, credentialHash);
    const existing = this.machines.get(input.machineId);
    const machine: Machine = {
      id: input.machineId,
      label: existing?.label ?? input.machineId,
      agentVersion: input.agentVersion,
      backend: input.backend,
      outputs: input.outputs,
      status: "pending",
      lastSeen: new Date().toISOString(),
    };
    this.machines.set(input.machineId, machine);
    await this.store.upsertMachine(this.toPersistedMachine(machine));
  }

  /**
   * Re-issue a credential for an EXISTING machine without changing its status or creating screens
   * (a token re-enrol of a still-pending machine, or refreshing a pending machine's reported
   * outputs on reconnect). Write-through. No-op if the machine is unknown.
   */
  async setMachineCredential(
    machineId: string,
    credentialHash: string,
    outputs?: Output[],
  ): Promise<void> {
    this.credentialHashes.set(machineId, credentialHash);
    const machine = this.machines.get(machineId);
    if (!machine) return;
    machine.lastSeen = new Date().toISOString();
    if (outputs) machine.outputs = outputs;
    await this.store.upsertMachine(this.toPersistedMachine(machine));
  }

  /**
   * Refresh a known machine's lastSeen (+ reported outputs) on reconnect, without touching status or
   * screens. Used when a recognised pending machine re-presents a valid credential. No-op if unknown.
   */
  async touchMachine(machineId: string, outputs: Output[]): Promise<void> {
    const machine = this.machines.get(machineId);
    if (!machine) return;
    machine.lastSeen = new Date().toISOString();
    machine.outputs = outputs;
    await this.store.upsertMachine(this.toPersistedMachine(machine));
  }

  /**
   * Operator approval. Flip the machine to `approved` and create a Screen (+ empty slice) per its
   * PERSISTED output, returning assignments for a live `server/apply`. Write-through (status, any
   * new screens/content, revision). Returns null if the machine is unknown; idempotent if already
   * approved (returns the existing screens' assignments).
   */
  async approveMachine(machineId: string): Promise<RegisterMachineResult | null> {
    const machine = this.machines.get(machineId);
    if (!machine) return null;

    machine.status = "approved";
    const ensured = this.ensureScreens(machineId, machine.outputs);
    if (ensured.changed) this.bumpRevision();

    await this.store.setMachineStatus(machineId, "approved");
    await this.persistScreens(ensured);
    if (ensured.changed) await this.store.setRevision(this.state.revision);

    return { changed: ensured.changed, assignments: ensured.assignments };
  }

  /**
   * Operator rejection. Flip the machine to `rejected` (terminal — it will never be admitted) and
   * write-through. Returns false if the machine is unknown.
   */
  async rejectMachine(machineId: string): Promise<boolean> {
    const machine = this.machines.get(machineId);
    if (!machine) return false;
    machine.status = "rejected";
    await this.store.setMachineStatus(machineId, "rejected");
    return true;
  }

  getScreens(): Screen[] {
    return this.state.screens;
  }

  getScreen(screenId: string): Screen | undefined {
    return this.state.screens.find((s) => s.id === screenId);
  }

  getMachines(): Machine[] {
    return [...this.machines.values()];
  }

  getMachine(machineId: string): Machine | undefined {
    return this.machines.get(machineId);
  }

  /** The stored credential hash for a machine, if it has ever been issued one. */
  getCredentialHash(machineId: string): string | undefined {
    return this.credentialHashes.get(machineId);
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
   * Replace a screen's surfaces wholesale, bump the revision, write-through, return the new slice.
   * Returns null if the screen is unknown.
   */
  async setScreenSurfaces(screenId: string, surfaces: Surface[]): Promise<ScreenSlice | null> {
    const slice = this.state.slices[screenId];
    if (slice === undefined) return null;
    const next: ScreenSlice = { ...slice, surfaces };
    this.state.slices[screenId] = next;
    this.bumpRevision();

    await this.store.upsertContent({
      screenId,
      canvas: next.canvas,
      surfaces: next.surfaces,
    });
    await this.store.setRevision(this.state.revision);
    return next;
  }

  /**
   * Convenience for the demo: replace a screen's slice with ONE full-canvas web surface.
   * Returns null if the screen is unknown.
   */
  async setDemoWeb(screenId: string, url: string): Promise<ScreenSlice | null> {
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

    await this.store.upsertContent({
      screenId,
      canvas: next.canvas,
      surfaces: next.surfaces,
    });
    await this.store.setRevision(this.state.revision);
    return next;
  }

  /**
   * Rename a screen's friendly name and write-through. Does NOT bump the revision: the friendly name
   * is registry metadata (used by ident + the admin UI), not part of any player's render slice — so
   * bumping would make every screen look "behind" in the admin UI (no render is pushed to ack).
   * Returns the updated screen, or null if unknown.
   */
  async renameScreen(screenId: string, friendlyName: string): Promise<Screen | null> {
    const screen = this.state.screens.find((s) => s.id === screenId);
    if (screen === undefined) return null;
    screen.friendlyName = friendlyName;

    await this.store.upsertScreen({
      id: screen.id,
      friendlyName: screen.friendlyName,
      machineId: screen.machineId,
      connector: screen.connector,
    });
    return screen;
  }

  // ── Murals & placement (Phase 3) ────────────────────────────────────────────
  //
  // Murals and placements are spatial layout metadata for the console — they do NOT affect any
  // player's render slice, so (like renameScreen) these mutations write-through but do NOT bump the
  // revision. The admin/state broadcast re-reads the current murals/placements regardless.

  getMurals(): Mural[] {
    return [...this.murals.values()];
  }

  getMural(id: string): Mural | undefined {
    return this.murals.get(id);
  }

  getPlacements(): Placement[] {
    return [...this.placements.values()];
  }

  getPlacement(screenId: string): Placement | undefined {
    return this.placements.get(screenId);
  }

  /** Create a new mural with a server-assigned id. Write-through. */
  async createMural(name: string): Promise<Mural> {
    const id = this.nextMuralId();
    const mural: Mural = { id, name };
    this.murals.set(id, mural);
    await this.store.upsertMural({ id, name });
    return mural;
  }

  /** Rename a mural. Write-through. Returns the updated mural, or null if unknown. */
  async renameMural(id: string, name: string): Promise<Mural | null> {
    const mural = this.murals.get(id);
    if (mural === undefined) return null;
    mural.name = name;
    await this.store.upsertMural({ id: mural.id, name: mural.name });
    return mural;
  }

  /**
   * Delete a mural. Every screen placed on it is unplaced (its placement removed and written through)
   * so those screens fall back to the unplaced tray. Write-through. Returns false if the mural is
   * unknown.
   */
  async deleteMural(id: string): Promise<boolean> {
    const mural = this.murals.get(id);
    if (mural === undefined) return false;

    const placedHere = [...this.placements.values()].filter((p) => p.muralId === id);
    for (const p of placedHere) {
      this.placements.delete(p.screenId);
      await this.store.deletePlacement(p.screenId);
    }

    this.murals.delete(id);
    await this.store.deleteMural(id);
    return true;
  }

  /**
   * Place (or move) a screen on a mural at `{x,y}`; `w`/`h` default to the screen's native resolution
   * (preserving an existing placement's size when omitted, e.g. on a drag-move). A screen is placed
   * on at most one mural, so placing it elsewhere MOVES it. Write-through. Returns the placement, or
   * null if the screen or the mural is unknown.
   */
  async placeScreen(
    screenId: string,
    muralId: string,
    x: number,
    y: number,
    w?: number,
    h?: number,
  ): Promise<Placement | null> {
    const screen = this.getScreen(screenId);
    if (screen === undefined) return null;
    if (!this.murals.has(muralId)) return null;

    const existing = this.placements.get(screenId);
    const res = this.screenResolution(screen);
    const placement: Placement = {
      muralId,
      screenId,
      x,
      y,
      w: w ?? existing?.w ?? res.w,
      h: h ?? existing?.h ?? res.h,
    };
    this.placements.set(screenId, placement);
    await this.store.upsertPlacement(placement);
    return placement;
  }

  /** Remove a screen's placement (return it to the unplaced tray). Write-through. False if unplaced. */
  async unplaceScreen(screenId: string): Promise<boolean> {
    if (!this.placements.has(screenId)) return false;
    this.placements.delete(screenId);
    await this.store.deletePlacement(screenId);
    return true;
  }
}
