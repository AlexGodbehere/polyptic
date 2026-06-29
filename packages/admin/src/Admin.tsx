/**
 * Admin console — the operator-facing view of the live registry.
 *
 * Connects to the server's /admin channel, renders the pushed `admin/state` snapshot, and exposes
 * the operator actions:
 *   - Phase 2a: rename a screen, pulse ident (per screen, or all of a machine's screens).
 *   - Phase 2b (enrollment): each machine carries an enrollment `status` (pending | approved |
 *     rejected). A freshly enrolled machine arrives `pending` with its reported `outputCount` but no
 *     screens yet; the operator APPROVES it (admits its screens) or REJECTS it. Pending machines are
 *     visually distinguished; rejected machines stay listed but greyed/marked. Rename + ident apply
 *     only to approved machines that already have screens.
 *
 * Snapshots are reconciled BY id so an in-flight rename keeps focus while the surrounding registry
 * repaints live. `admin/state` now carries `status` + `outputCount` per machine.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { MachineView, ScreenView, ServerToAdminMessage } from "@polyptych/protocol";
import { AdminSocket, type ConnState } from "./ws";

const SERVER_WS_URL = "ws://localhost:8080/admin";
const API_BASE = "http://localhost:8080/api/v1";
const IDENT_TTL_MS = 4000;

function connLabel(state: ConnState): string {
  switch (state) {
    case "open":
      return "live";
    case "connecting":
      return "connecting";
    case "closed":
      return "offline";
  }
}

/** POST JSON to the control plane, swallowing/logging transport errors so the UI never wedges. */
async function postJson(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[admin] POST ${path} -> ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[admin] POST ${path} failed`, err);
    return false;
  }
}

/** Human-friendly "last seen" relative to a ticking clock (so the value stays fresh on screen). */
function formatLastSeen(iso: string | undefined, nowMs: number): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const secs = Math.max(0, Math.round((nowMs - then) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** "2 outputs" / "1 output". */
function outputsLabel(count: number): string {
  return `${count} ${count === 1 ? "output" : "outputs"}`;
}

/** One screen row: status dot, inline rename, metadata chips, and an ident pulse button. */
function ScreenRow(props: { screen: ScreenView }): JSX.Element {
  const [draft, setDraft] = createSignal(props.screen.friendlyName);
  const [focused, setFocused] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  // Mirror inbound name changes into the draft unless the operator is mid-edit (keeps focus/typed text).
  createEffect(() => {
    const incoming = props.screen.friendlyName;
    if (!focused()) setDraft(incoming);
  });

  const trimmed = createMemo(() => draft().trim());
  const canRename = createMemo(() => {
    const n = trimmed();
    return n.length >= 1 && n.length <= 64 && n !== props.screen.friendlyName;
  });

  const submitRename = async (): Promise<void> => {
    if (busy() || !canRename()) return;
    setBusy(true);
    await postJson(`/screens/${encodeURIComponent(props.screen.id)}/rename`, {
      friendlyName: trimmed(),
    });
    setBusy(false);
    // The server broadcasts admin/state; the createEffect above re-syncs the draft on the next snapshot.
  };

  const identScreen = async (): Promise<void> => {
    await postJson(`/screens/${encodeURIComponent(props.screen.id)}/ident`, {
      on: true,
      ttlMs: IDENT_TTL_MS,
    });
  };

  return (
    <li class="screen">
      <span
        class="dot"
        classList={{ "dot--online": props.screen.online, "dot--offline": !props.screen.online }}
        title={props.screen.online ? "player connected" : "player offline"}
      />

      <div class="screen-name">
        <input
          class="rename-input"
          value={draft()}
          disabled={busy()}
          spellcheck={false}
          autocomplete="off"
          aria-label={`Rename ${props.screen.friendlyName}`}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void submitRename();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setDraft(props.screen.friendlyName);
              e.currentTarget.blur();
            }
          }}
        />
        <button
          class="btn btn--rename"
          disabled={!canRename() || busy()}
          onClick={() => void submitRename()}
        >
          Rename
        </button>
      </div>

      <div class="screen-meta">
        <span class="chip mono">{props.screen.id}</span>
        <span class="chip chip--ghost">{props.screen.connector}</span>
        <span class="mono screen-rev">rev {props.screen.revision}</span>
        <span class="screen-surfaces">
          {props.screen.surfaceCount} {props.screen.surfaceCount === 1 ? "surface" : "surfaces"}
        </span>
      </div>

      <button class="btn btn--ident" onClick={() => void identScreen()}>
        Ident
      </button>
    </li>
  );
}

/** One machine card: header (status badge, label, id, backend, agent, last-seen) + a body that is
 * either the enrollment gate (pending / rejected) or the machine's screens (approved). */
function MachineCard(props: { machine: MachineView; now: number }): JSX.Element {
  const [busy, setBusy] = createSignal(false);

  const isPending = createMemo(() => props.machine.status === "pending");
  const isRejected = createMemo(() => props.machine.status === "rejected");
  const isApproved = createMemo(() => props.machine.status === "approved");

  // The header badge: pending folds in the reported output count ("pending · 2 outputs").
  const statusLabel = createMemo(() =>
    isPending()
      ? `pending · ${outputsLabel(props.machine.outputCount)}`
      : props.machine.status,
  );

  const identAll = async (): Promise<void> => {
    await postJson(`/machines/${encodeURIComponent(props.machine.id)}/ident`, {
      on: true,
      ttlMs: IDENT_TTL_MS,
    });
  };

  const approve = async (): Promise<void> => {
    if (busy()) return;
    setBusy(true);
    // Server creates screens from the machine's persisted outputs and live-admits a connected agent;
    // the resulting admin/state broadcast repaints this card as approved (with its screens).
    await postJson(`/machines/${encodeURIComponent(props.machine.id)}/approve`, {});
    setBusy(false);
  };

  const reject = async (): Promise<void> => {
    if (busy()) return;
    setBusy(true);
    // Optional {reason?} body — the operator console rejects without a typed reason; the server
    // closes a connected agent's WS and never admits it. The broadcast greys this card out.
    await postJson(`/machines/${encodeURIComponent(props.machine.id)}/reject`, {});
    setBusy(false);
  };

  return (
    <section
      class="machine"
      classList={{
        "machine--offline": !props.machine.online && !isRejected(),
        "machine--pending": isPending(),
        "machine--rejected": isRejected(),
      }}
    >
      <header class="machine-head">
        <div class="machine-ident">
          <span
            class="dot dot--lg"
            classList={{
              "dot--online": props.machine.online,
              "dot--offline": !props.machine.online,
            }}
            title={props.machine.online ? "agent connected" : "agent offline"}
          />
          <div class="machine-id-text">
            <div class="machine-label-row">
              <span class="machine-label">{props.machine.label}</span>
              <span
                class="status-badge"
                classList={{
                  "status-badge--pending": isPending(),
                  "status-badge--approved": isApproved(),
                  "status-badge--rejected": isRejected(),
                }}
                title={`Enrollment status: ${props.machine.status}`}
              >
                {statusLabel()}
              </span>
            </div>
            <span class="machine-uid mono">{props.machine.id}</span>
          </div>
        </div>

        <div class="machine-meta">
          <Show when={props.machine.backend}>{(b) => <span class="chip">{b()}</span>}</Show>
          <Show when={props.machine.agentVersion}>
            {(v) => <span class="chip chip--ghost">agent {v()}</span>}
          </Show>
          <span class="machine-seen">
            {props.machine.online
              ? "online"
              : `last seen ${formatLastSeen(props.machine.lastSeen, props.now)}`}
          </span>
          <Show when={isApproved()}>
            <button
              class="btn btn--ident"
              onClick={() => void identAll()}
              disabled={props.machine.screens.length === 0}
            >
              Ident all
            </button>
          </Show>
        </div>
      </header>

      {/* Pending — enrollment gate: the heart of 2b. Approve admits the machine's screens. */}
      <Show when={isPending()}>
        <div class="machine-gate machine-gate--pending">
          <div class="machine-gate-text">
            <strong>Awaiting approval</strong>
            <span>
              This machine enrolled and reported {outputsLabel(props.machine.outputCount)}. Approve
              to admit its screens, or reject to deny it.
            </span>
          </div>
          <div class="machine-gate-actions">
            <button
              class="btn btn--approve"
              disabled={busy()}
              onClick={() => void approve()}
              aria-label={`Approve ${props.machine.label}`}
            >
              Approve
            </button>
            <button
              class="btn btn--reject"
              disabled={busy()}
              onClick={() => void reject()}
              aria-label={`Reject ${props.machine.label}`}
            >
              Reject
            </button>
          </div>
        </div>
      </Show>

      {/* Rejected — stays listed, greyed and marked; no admit path. */}
      <Show when={isRejected()}>
        <div class="machine-gate machine-gate--rejected">
          <div class="machine-gate-text">
            <strong>Rejected</strong>
            <span>
              This machine was rejected{" "}
              {props.machine.outputCount > 0
                ? `(reported ${outputsLabel(props.machine.outputCount)}) `
                : ""}
              and will not be admitted.
            </span>
          </div>
        </div>
      </Show>

      {/* Approved — the Phase 2a view: this machine's screens (rename + ident). */}
      <Show when={isApproved()}>
        <Show
          when={props.machine.screens.length > 0}
          fallback={<p class="machine-empty">No screens enrolled on this machine yet.</p>}
        >
          <ul class="screens">
            <For each={props.machine.screens}>{(s) => <ScreenRow screen={s} />}</For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}

export function Admin(): JSX.Element {
  // Reconciled BY id so machines/screens keep stable identity across snapshots — an in-flight
  // rename input keeps focus while everything around it repaints live.
  const [state, setState] = createStore<{ revision: number; machines: MachineView[] }>({
    revision: -1,
    machines: [],
  });
  const [connState, setConnState] = createSignal<ConnState>("connecting");
  const [now, setNow] = createSignal(Date.now());

  let socket: AdminSocket | undefined;

  const handleMessage = (msg: ServerToAdminMessage): void => {
    if (msg.t === "admin/state") {
      setState("revision", msg.revision);
      setState("machines", reconcile(msg.machines, { key: "id" }));
    }
  };

  const screenCount = createMemo(() =>
    state.machines.reduce((sum, m) => sum + m.screens.length, 0),
  );

  // Surface machines awaiting approval at a glance in the header.
  const pendingCount = createMemo(
    () => state.machines.filter((m) => m.status === "pending").length,
  );

  onMount(() => {
    socket = new AdminSocket(SERVER_WS_URL, {
      onMessage: handleMessage,
      onState: setConnState,
    });
    socket.start();

    // Tick so "last seen" stays fresh without waiting for the next server push.
    const clock = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(clock));
  });

  onCleanup(() => socket?.stop());

  return (
    <div class="admin">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true" />
          <div class="brand-text">
            <h1>Polyptych</h1>
            <p class="brand-sub">Display-wall control</p>
          </div>
        </div>

        <div class="topbar-status">
          <Show when={pendingCount() > 0}>
            <span class="pending-pill" title="Machines awaiting approval">
              {pendingCount()} pending
            </span>
          </Show>
          <span class="count">
            {state.machines.length} {state.machines.length === 1 ? "machine" : "machines"}
            <span class="count-sep"> · </span>
            {screenCount()} {screenCount() === 1 ? "screen" : "screens"}
          </span>
          <span class="conn">
            <span
              class="dot"
              classList={{
                "dot--online": connState() === "open",
                "dot--offline": connState() === "closed",
                "dot--pending": connState() === "connecting",
              }}
            />
            <span class="conn-label">{connLabel(connState())}</span>
            <span class="conn-sep">·</span>
            <span class="mono">rev {state.revision < 0 ? "—" : state.revision}</span>
          </span>
        </div>
      </header>

      <main class="content">
        <Show
          when={state.machines.length > 0}
          fallback={
            <div class="empty">
              <span class="empty-spinner" aria-hidden="true" />
              <p class="empty-title">Waiting for machines…</p>
              <p class="empty-sub">
                Start an agent and it will appear here. Connection:{" "}
                <span class="mono">{connLabel(connState())}</span>.
              </p>
            </div>
          }
        >
          <div class="machines">
            <For each={state.machines}>{(m) => <MachineCard machine={m} now={now()} />}</For>
          </div>
        </Show>
      </main>
    </div>
  );
}
