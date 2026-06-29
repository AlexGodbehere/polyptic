# Polyptic

> A **polyptic** is a multi-panel painting whose panels together compose one picture — exactly what a wall of screens is.

**Polyptic is a generic, self-hostable system for centrally orchestrating walls of screens and fleets of display kiosks from a web UI.** Named screens, drag-and-drop layouts, preset **scenes**, a REST/WebSocket API, live preview, and zero-click boot. It is **vendor-neutral**: any web content, dashboard, image or video; any OIDC identity provider; runs on any Kubernetes cluster or plain Docker host.

It replaces the all-too-common pattern of "a fragile per-machine boot script that clicks here, waits, opens a browser, and types a password in plaintext" with one declarative control plane and thin reconciling agents.

> This repo is the **product**. It has **no dependency on any specific stack.** A reference *Example integration* shows how to point it at a Grafana + Keycloak deployment (see `docs/ARCHITECTURE.md`), but Grafana, Keycloak and friends are optional content/identity adapters, never foundations.

---

## Core ideas

- **Screens, not machines.** You drive *named screens* ("Nessie", "Bertha"). A client machine is just plumbing — "this box owns these two outputs." An **ident mode** flashes each screen's name on its physical panel so onboarding/relabelling is point-and-confirm, never remote-desktop-and-guess.
- **One global layout, reconciled.** The control plane holds a single virtual-canvas layout + named **scenes**; each agent renders only *its* slice. This is the same desired-state reconcile loop as a Kubernetes controller (spec/status, generation/observedGeneration) — so the fleet is **one consistent system, not N isolated kiosks**, by construction.
- **Buy the substrate, build the brain.** The device stack (Ubuntu + `sway` + `greetd` + `systemd` + Chromium kiosk) is standard and borrowed wholesale. The only thing Polyptic itself *is*, is the global-layout + scenes + API + UI that no off-the-shelf signage product provides.
- **Typed surfaces.** A tile can be a web page, a dashboard panel, an image, a video, a slideshow, or a native window — so the system is never trapped in an "iframes only" model.
- **Outbound-only agents.** Clients dial out to the control plane (WSS); no inbound ports or NAT holes. Cold boot = reconnect and reconcile.

## Architecture

```
                  ┌──────────────────────────────────────────────┐
                  │  polyptic-server   (control plane)            │
                  │  TypeScript / Fastify · Postgres · ws          │
                  │   • registry: machines · screens · outputs     │
                  │   • ONE global layout + versioned scenes       │
                  │   • REST + WebSocket API                       │
                  │   • web UI: layout editor · scenes · preview · │
                  │     ident-mode · fleet health                 │
                  │  runs on any Kubernetes OR Docker host         │
                  └───────────────▲──────────────▲────────────────┘
                       outbound    │   wss://     │   outbound
              ┌────────────────────┘              └────────────────────┐
     ┌────────┴───────────┐                              ┌─────────────┴──────┐
     │  Display client A  │   (machine = plumbing)        │  Display client C  │
     │  Ubuntu + sway     │            ...                │  Ubuntu + sway     │
     │  polyptic-agent   │  reconciles its slice via     │  polyptic-agent   │
     │  Chromium player   │  swaymsg + the player app     │  Chromium player   │
     │ ┌────────┬────────┐│                              │ ┌────────┬────────┐ │
     │ │ Screen │ Screen ││                              │ │ Screen │ Screen │ │
     │ │"Nessie"│"Bertha"││                              │ │  ...   │  ...   │ │
     │ └────────┴────────┘│                              │ └────────┴────────┘ │
     └────────────────────┘                              └─────────────────────┘
```

### Components
| component | where | tech | role |
|---|---|---|---|
| `polyptic-server` | any k8s / Docker | TypeScript/Node, Fastify, `ws`, Postgres, `zod` | source of truth: registry, global layout, versioned scenes, REST+WS API, web UI |
| `polyptic-agent` | each display client | TypeScript (Bun single-file binary / `.deb`) | outbound WSS, reconciles its slice, drives `swaymsg`, captures `grim`/`wayvnc` preview |
| `polyptic-player` | each screen (Chromium) | web app served by the server | renders the per-screen mosaic of typed surfaces |
| `@polyptic/protocol` | shared | `zod` | wire types shared by server/agent/player |

### Device stack (each display client)
Ubuntu 24.04 LTS minimal → `greetd [initial_session]` passwordless autologin (`kiosk`) → `sway` (outputs pinned by connector) → `systemd --user` services launch the agent + one Chromium `--app` per output (own `--user-data-dir`, popup-suppression flags, `exit_type` reset so a power cut never shows "Restore pages"). No `swayidle`; `output * dpms on`. **Zero clicks, zero sleeps, zero typed passwords.** Wayland's refusal to let clients self-position is a *feature*: all geometry lives in one authoritative place (the compositor, driven by the agent over `swaymsg` IPC).

### Content model — typed surfaces
`web-url` · `dashboard-panel` · `dashboard-page` (rendered as player iframes) · `web-window` · `native-app` (the agent places these as **top-level windows** via `swaymsg` — the escape hatch for framing-blocked or non-web sources) · `image` · `video` · `slideshow`.

**Content adapters** are pluggable: an adapter turns a logical source into a concrete URL/launch-spec + an auth strategy. A **Grafana adapter** (kiosk-URL / `d-solo` single-panel helper) ships as a first-class *optional* example — not a dependency. Office documents (e.g. PowerPoint) are handled by **pre-converting to images/PDF/MP4 server-side**, never rendered live.

### Auth (generic)
- **Admin UI / API:** generic **OIDC/OAuth2** via standard discovery — works with any IdP (Keycloak, Auth0, Entra, Google, Authelia…). Anonymous/local fallback for trivial deployments.
- **Per-content-source strategies:** `public` · `anonymous-viewer` · `reverse-proxy-header-injection` (a proxy adds `Authorization:` because iframes can't set headers) · `persisted-session` · `oidc`. Chosen per source by its adapter.
- **Agent ↔ server:** bootstrap token → durable **mTLS client cert keyed to `/etc/machine-id`** (or OIDC client credentials). No inbound ports.

### Live preview
Always-on `grim` per-output **JPEG thumbnails** pushed up the existing outbound WSS (shows *real* render + auth state — you'd see a login page if auth broke). On-demand `wayvnc` bound to `127.0.0.1`, tunnelled through the authenticated control plane to **noVNC** for deep debugging. Plus a WYSIWYG "intended layout" diagram next to the real thumbnail.

## Deploy / Distribution
Polyptic ships as **two artifacts** — see **[`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md)** for the full packaging story (image, `.deb`/`.rpm`, the tag-driven release flow, env reference, and the optional private-npm options):

- **Server** — one **Docker image** (`ghcr.io/<owner>/polyptic-server`) that bundles the control plane **plus** the console and player SPAs, served same-origin so the session cookie just works. Deploy with `docker run`, the **docker-compose** `full` profile (server + Postgres), or the **Helm chart** in `deploy/helm/polyptic` (any cluster, bring-your-own Postgres). You don't `npm install` Polyptic — you run the image.
- **Agent** — a per-box **`.deb`/`.rpm`** from the GitHub Release: `sudo apt install ./polyptic-agent_*.deb` then `polyptic-agent setup …`. The device-side guide (cold-boot chain, backends, troubleshooting, VM walkthrough) is **[`docs/DEPLOY.md`](docs/DEPLOY.md)**.
- **Releases** are **tag-driven**: pushing `vX.Y.Z` builds the image + packages and attaches them to the Release. Nothing publishes on a normal push.
- `polyptic-player`: static assets served by the server (bundled into the image).

## Roadmap
- **Phase 0 — Quick win (days):** point an *existing* wall at anonymous/`kiosk` dashboard URLs to delete any plaintext-password boot hack immediately and validate that the wall can be decoupled from human auth. Reversible, no new infra.
- **Phase 1:** one Ubuntu client — autologin → `sway` → systemd-supervised Chromium per screen, static config. Proves zero-click cold-boot. *Verify GPU/Wayland on the real hardware.*
- **Phase 2:** control-plane MVP + agent reconciling one scene; screen registry + ident mode.
- **Phase 3:** mosaic player across all screens + typed surfaces + scenes + layout editor + atomic fan-out.
- **Phase 4:** thumbnails + on-demand VNC; Helm + compose packaging; OIDC + mTLS identity; Prometheus metrics; last-good-slice caching.
- **Phase 5 (nice-to-have):** image/video/slideshow + Office→media conversion; native-app surfaces as concrete needs arrive.

Est. ~1.5–3 engineer-months to a production v1 for 1–2 engineers comfortable with TypeScript + Linux/k8s.

## Example integrations
- **Grafana + Keycloak (reference):** anonymous-Viewer org for public dashboards, or reverse-proxy header injection for protected ones; `d-solo` panels for fine mosaic control. See `docs/ARCHITECTURE.md` → *Example integration*.

## Status
Foundation in place: monorepo + the shared contract (`@polyptic/protocol`). **Next: Phase 1** — the live vertical slice (instant content on one screen). See `docs/ROADMAP.md` for the path, `docs/DECISIONS.md` for locked calls, and `CLAUDE.md` for working conventions. Full design narrative in `docs/DESIGN.md`; build reference in `docs/ARCHITECTURE.md`.

## Naming note
"Polyptic" was chosen over the working name "Mural" after a name-clash review: nothing in the display-wall/signage/kiosk space is named Mural, but **MURAL by Tactivos** (the $2B visual-collaboration whiteboard) holds registered software trademarks (USPTO `97134497`) and the entire `mural.*` domain/package namespace — fine for an internal codename, risky for a public/open-source product. Polyptic keeps the multi-panel metaphor with a clean namespace.
