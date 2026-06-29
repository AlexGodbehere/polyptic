# Polyptych — Development Roadmap

The remembered path. Fixed direction, flexible detail. Update the **CURRENT** marker as we go. Phases are sequenced by dependency, not by calendar.

> **CURRENT: Phase 1 ✅ done → entering Phase 2.** Vertical slice runs on bun: change a screen's content via REST → player render pushed in ~4ms over WS, stable-id in-place swap, no reload (verified by an e2e harness, 8/8). Next is the screens-first registry + enrollment + ident.

---

## Phase 0 — Foundation ✅ (this commit)
Anchor docs (`CLAUDE.md`, `ROADMAP.md`, `DECISIONS.md`), monorepo skeleton (bun workspaces + `tsconfig.base`), and the shared **contract** (`@polyptych/protocol`, zod). The keystone everything builds against.
**DoD:** workspace resolves; protocol types compile; design + decisions committed.

## Phase 1 — Live vertical slice ✅ (done)
The thinnest end-to-end thing that proves the spine and the **instant** property.
- `server`: in-memory desired-state, Fastify REST + WS hub (`/agent`, `/player`) on :8080.
- `agent`: connects, registers one screen, opens the player via the `dev-open` backend.
- `player`: SolidJS page, connects over WS, renders the slice, **swaps content via keyed DOM diff (no reload)**.
- `deploy`: docker-compose Postgres (Phase 2+, unused by the slice); run everything with `bun run dev`.
**DoD met:** REST change → player render in **~4ms** over WS, **stable-id in-place swap**, no reload. Verified by `scratchpad/harness.ts` (8/8) + typecheck + Vite build. See `docs/DEV.md`. Built in parallel against the locked contract, then cross-reviewed + fixed.

## Phase 2 — Screens-first registry + enrollment + ident
Real Machine/Output/Screen registry in Postgres. Outbound WSS **enrollment** (bootstrap token → claim → mTLS cert). **Ident mode** (flash friendly name on each output). Multiple screens across multiple machines.
**DoD:** image-and-enroll a 2nd machine; name its screens via ident; address screens by name.

## Phase 3 — Layout, scenes, adapters, instant fan-out
Global virtual-canvas **Layout** (arbitrary regions). Named, versioned **Scenes**. **Admin UI** layout editor + scene switcher. **Typed surfaces** + **content adapters** (web, dashboard/Grafana, image, video). Atomic scene fan-out across all screens.
**DoD:** drag content onto named screens; save a scene; switch scenes → all screens flip together, instantly.

## Phase 4 — Real device stack + zero-click boot
Ubuntu image: greetd autologin → compositor → systemd-supervised agent + Chromium per output. `DisplayBackend` (`wayland-sway` default, `x11-i3` fallback). Agent as single-file `.deb`. Declarative provisioning (cloud-init/Ansible/image). Crash/restore hardening.
**DoD:** cold power-on → wall shows the active scene with zero interaction; survives EOD smart-plug cut.

## Phase 5 — Preview, health, resilience, packaging
`grim` thumbnails (always-on) + on-demand `wayvnc`→noVNC through the control plane. Prometheus metrics, fleet/screen health in the admin UI. Agent caches last-good slice (rides out control-plane outages). Helm chart for any cluster.
**DoD:** see every screen live in the UI; control-plane restart never blanks the wall.

## Phase 6 — Auth, properly
Generic **OIDC** for admin UI/API (any IdP). Per-source auth strategies (`public`/`anonymous`/`reverse-proxy`/`oidc`). mTLS agent identity (or OIDC client creds).
**DoD:** a sensitive dashboard shows authenticated content on the wall without a human logging in; admin UI is OIDC-gated.

## Phase 7 — Nice-to-haves
Media: image/video/**slideshow** + Office→media conversion (server-side). **Native-app** surfaces (CAD/RTSP/etc.) via the agent's top-level-window placement.
**DoD:** play a looping video + a converted slide deck as scene content; place one native window beside web tiles.

---

### Parallel AMRC track (independent, anytime)
**Phase 0-AMRC quick win:** point the *existing Windows wall* at anonymous Grafana `&kiosk` / `d-solo` URLs to delete the plaintext-password boot hack now. No Polyptych code; reversible. Relieves pain while the product is built.
