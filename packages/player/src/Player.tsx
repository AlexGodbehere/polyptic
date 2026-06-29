import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { Geometry, ServerToPlayerMessage, Surface } from "@polyptic/protocol";
import { PlayerSocket, type ConnState } from "./ws";

const SERVER_WS_URL = "ws://localhost:8080/player";
const DEFAULT_CANVAS: Geometry = { x: 0, y: 0, w: 1920, h: 1080 };

/** Read `?screen=<id>` from the URL — the one piece of identity this page is launched with. */
function readScreenId(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get("screen") ?? "").trim();
}

/** Map a surface's region (in canvas pixel space) onto the full viewport as percentages. */
function regionStyle(region: Geometry, canvas: Geometry): JSX.CSSProperties {
  const w = canvas.w || 1;
  const h = canvas.h || 1;
  return {
    left: `${((region.x - canvas.x) / w) * 100}%`,
    top: `${((region.y - canvas.y) / h) * 100}%`,
    width: `${(region.w / w) * 100}%`,
    height: `${(region.h / h) * 100}%`,
  };
}

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

/**
 * Renders one surface inside its region.
 *
 * Because the parent keeps surfaces in a store reconciled BY id, the proxy object handed to this
 * component keeps a stable identity across renders. When only a field changes (e.g. a web/dashboard
 * surface's `url`), Solid's fine-grained reactivity patches that single attribute — the existing
 * <iframe> element is reused and its `src` mutates in place. The page never reloads.
 */
function SurfaceView(props: { surface: Surface; canvas: Geometry }): JSX.Element {
  const frameUrl = (): string => {
    const s = props.surface;
    return s.type === "web" || s.type === "dashboard" ? s.url : "";
  };
  const mediaSrc = (): string => {
    const s = props.surface;
    return s.type === "image" || s.type === "video" ? s.src : "";
  };
  const interactive = (): boolean => {
    const s = props.surface;
    return s.type === "web" ? s.interactive : false;
  };
  const imageFit = (): "cover" | "contain" => {
    const s = props.surface;
    return s.type === "image" ? s.fit : "cover";
  };

  return (
    <div class="surface" style={regionStyle(props.surface.region, props.canvas)}>
      <Switch>
        <Match when={props.surface.type === "web" || props.surface.type === "dashboard"}>
          <iframe
            class="surface-frame"
            classList={{ "is-interactive": interactive() }}
            src={frameUrl()}
            allow="autoplay; encrypted-media; fullscreen; clipboard-read; clipboard-write"
          />
        </Match>
        <Match when={props.surface.type === "image"}>
          <img
            class="surface-media"
            src={mediaSrc()}
            alt=""
            style={{ "object-fit": imageFit() }}
          />
        </Match>
        <Match when={props.surface.type === "video"}>
          <video
            class="surface-media"
            src={mediaSrc()}
            autoplay
            playsinline
            loop={props.surface.type === "video" ? props.surface.loop : true}
            muted={props.surface.type === "video" ? props.surface.muted : true}
          />
        </Match>
      </Switch>
    </div>
  );
}

export function Player(): JSX.Element {
  const screenId = readScreenId();

  // Surfaces live in a store keyed by id so updates DIFF the DOM rather than recreate it.
  const [slice, setSlice] = createStore<{ canvas: Geometry; surfaces: Surface[] }>({
    canvas: { ...DEFAULT_CANVAS },
    surfaces: [],
  });
  const [connState, setConnState] = createSignal<ConnState>("connecting");
  const [revision, setRevision] = createSignal(-1);
  const [ident, setIdent] = createSignal<{ friendlyName: string; color: string } | null>(null);

  let socket: PlayerSocket | undefined;

  const handleMessage = (msg: ServerToPlayerMessage): void => {
    if (msg.t === "server/render") {
      // Keyed reconcile: same id → same DOM node, only changed fields repaint. The headline trick.
      setSlice("canvas", reconcile(msg.slice.canvas));
      setSlice("surfaces", reconcile(msg.slice.surfaces, { key: "id" }));
      setRevision(msg.revision);
      // Close the reconcile loop so the control plane knows this screen is at this revision.
      socket?.send({ t: "player/ack", screenId, revision: msg.revision });
    } else {
      // server/ident-pulse → flash the friendly name so an operator can map physical panels.
      setIdent(msg.on ? { friendlyName: msg.friendlyName, color: msg.color } : null);
    }
  };

  onMount(() => {
    if (!screenId) {
      setConnState("closed");
      return;
    }
    socket = new PlayerSocket(SERVER_WS_URL, screenId, {
      onMessage: handleMessage,
      onState: setConnState,
    });
    socket.start();
  });

  onCleanup(() => socket?.stop());

  return (
    <Show
      when={screenId}
      fallback={
        <div class="notice">
          <p>
            No screen specified. Append <code>?screen=screen-1</code> to the URL.
          </p>
        </div>
      }
    >
      <main class="stage">
        <For each={slice.surfaces}>
          {(surface) => <SurfaceView surface={surface} canvas={slice.canvas} />}
        </For>

        <Show when={ident()}>
          {(id) => (
            <div class="ident" style={{ "background-color": id().color }}>
              <span class="ident-name">{id().friendlyName}</span>
            </div>
          )}
        </Show>

        <Show when={import.meta.env.DEV}>
          <div class="badge">
            <span class={`badge-dot badge-dot--${connState()}`} />
            <span class="badge-text">{connLabel(connState())}</span>
            <span class="badge-sep">·</span>
            <span class="badge-text">{screenId}</span>
            <span class="badge-sep">·</span>
            <span class="badge-text">rev {revision() < 0 ? "—" : revision()}</span>
          </div>
        </Show>
      </main>
    </Show>
  );
}
