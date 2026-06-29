# Polyptych — local development

How to run the **Phase 1 vertical slice** on your dev machine and see the headline
**instant** property: change a screen's content with one REST call and watch the
player swap it in place in **< ~150 ms, with no page reload**.

The slice runs on **Bun** and keeps all desired-state **in memory** — no Postgres,
no Docker, no compositor. It works on macOS and Linux as-is.

---

## Prerequisites

- **Bun ≥ 1.1** — <https://bun.sh> (`curl -fsSL https://bun.sh/install | bash`). Check with `bun --version`.

> No Node, nvm, pnpm, or tsx needed — Bun installs the deps, runs the TypeScript
> server/agent natively, and serves the Vite player.
>
> You do **not** need Docker for Phase 1. `deploy/docker-compose.yml` (Postgres) is
> Phase 2+ scaffolding and is ignored by the slice.

---

## Install & run

From the repo root:

```sh
bun install
bun run dev
```

`bun run dev` first builds the shared contract (`@polyptych/protocol`) and then starts
all three processes together under [`concurrently`](https://www.npmjs.com/package/concurrently),
colour-coded by name:

| name (colour)   | process                 | what it does                                                        |
| --------------- | ----------------------- | ------------------------------------------------------------------- |
| `server` (green)  | `@polyptych/server`   | HTTP + WS on **:8080**; holds desired-state in memory; REST API     |
| `player` (cyan)   | `@polyptych/player`   | Vite dev server on **:5173**; the per-screen renderer (SolidJS)     |
| `agent`  (yellow) | `@polyptych/agent`    | dials the server, registers one screen, opens the player page       |

Stop everything with **Ctrl-C**.

### What to expect

1. **server** logs that it is listening on `:8080`.
2. **agent** connects to `ws://localhost:8080/agent`, sends `agent/hello`, and the
   server registers the machine and assigns the first screen the id **`screen-1`**
   (ids are handed out sequentially `screen-1`, `screen-2`, … in registration order;
   default `friendlyName` is "Screen N").
3. The agent's **`dev-open`** backend opens the player URL in your default browser
   (`open` on macOS, `xdg-open` on Linux). **A browser tab opens automatically** at
   roughly `http://localhost:5173/?screen=screen-1`.
4. **player** connects to `ws://localhost:8080/player`, sends `player/hello`, and the
   server replies with `server/render`. Initially the screen's slice has no surfaces,
   so you'll see an empty canvas — that's expected.

> **Ports:** server `8080`, player `5173`. If either is busy, free it before
> `bun run dev` (the slice has no fallback ports).

---

## The demo — prove "instant"

With `bun run dev` running, push content to `screen-1` over the convenience REST route.
This replaces the screen's slice with **one full-canvas web surface** and pushes it
live to the player:

```sh
curl -X POST localhost:8080/api/v1/demo/web \
  -H 'content-type: application/json' \
  -d '{"screenId":"screen-1","url":"https://example.com"}'
```

The player iframes `https://example.com` immediately — no reload.

Now run it again with a **different** URL and watch the player **swap the content in
place**, instantly, with no page reload (the demo surface keeps a stable id, so the
DOM diff just changes the existing iframe's `src`):

```sh
curl -X POST localhost:8080/api/v1/demo/web \
  -H 'content-type: application/json' \
  -d '{"screenId":"screen-1","url":"https://wikipedia.org"}'
```

That snappy, reload-free swap **is** the Phase 1 headline property.

### Manual fallback

If the browser tab didn't open automatically (e.g. no default handler for `open`/
`xdg-open`), open the player by hand:

```sh
open "http://localhost:5173/?screen=screen-1"
```

(On Linux use `xdg-open`, or just paste the URL into a browser.)

---

## Other REST routes

All bodies are validated against the `@polyptych/protocol` zod schemas. CORS is
enabled for the player origin `http://localhost:5173`.

| method & path                              | body                              | effect                                                            |
| ------------------------------------------ | --------------------------------- | ----------------------------------------------------------------- |
| `GET  /api/v1/state`                       | —                                 | the full `DesiredState`                                           |
| `GET  /api/v1/screens`                     | —                                 | registered `Screen[]`                                             |
| `POST /api/v1/screens/:screenId/surfaces`  | `{ "surfaces": Surface[] }`       | replace that screen's slice surfaces, bump revision, push render  |
| `POST /api/v1/demo/web`                    | `{ "screenId", "url" }`           | convenience: one full-canvas web surface (used by the demo above) |

Example with the general route (two side-by-side surfaces on a 1920×1080 canvas):

```sh
curl -X POST localhost:8080/api/v1/screens/screen-1/surfaces \
  -H 'content-type: application/json' \
  -d '{
    "surfaces": [
      { "id": "left",  "type": "web", "url": "https://example.com",
        "region": { "x": 0,   "y": 0, "w": 960, "h": 1080 } },
      { "id": "right", "type": "web", "url": "https://wikipedia.org",
        "region": { "x": 960, "y": 0, "w": 960, "h": 1080 } }
    ]
  }'
```

---

## Configuration

| env var             | default                    | meaning                                                    |
| ------------------- | -------------------------- | ---------------------------------------------------------- |
| `PLAYER_BASE_URL`   | `http://localhost:5173`    | base the server uses to build each `playerUrl`             |
| `POLYPTYCH_BACKEND` | _(auto → `dev-open`)_      | force the agent's display backend (`dev-open` in Phase 1)  |

The dev canvas defaults to **1920×1080**. The dev `machineId` is read from
`/etc/machine-id` if present, else falls back to `dev-mac`.

---

## Phase 1 — Definition of Done

> Change a screen's content via a REST call → the player updates in **< ~150 ms with
> no page reload** (DOM diff). Demo-able.

If the two `curl` calls above swap the player's content instantly without a reload,
the slice is doing its job. See [`ROADMAP.md`](./ROADMAP.md) for what comes next
(Phase 2 brings the Postgres registry in `deploy/docker-compose.yml` to life).
