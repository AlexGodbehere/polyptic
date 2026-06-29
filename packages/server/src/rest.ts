/**
 * REST surface of the control plane. Every body/param is parsed with the protocol's zod schemas
 * (or zod built from them) at the edge. A content mutation bumps the revision, persists through the
 * Store, and immediately pushes a `server/render` to the affected screen's player socket(s) — the
 * instant path. Registry mutations (rename) and content mutations also trigger a coalesced
 * `admin/state` broadcast so the Admin UI stays live.
 *
 * Phase 2a routes (all alongside the unchanged Phase 1 routes):
 *   GET  /api/v1/machines                     -> Machine[]
 *   POST /api/v1/screens/:screenId/rename     -> rename + persist + broadcast; 404 unknown
 *   POST /api/v1/screens/:screenId/ident      -> server/ident-pulse to that screen; 404 unknown
 *   POST /api/v1/machines/:machineId/ident    -> ident every screen on a machine; 404 unknown
 *
 * Phase 2b operator routes (enrollment):
 *   POST /api/v1/machines/:machineId/approve  -> pending→approved; create screens; live server/apply
 *                                                if the agent is connected; broadcast; 404 unknown
 *   POST /api/v1/machines/:machineId/reject   -> status→rejected; server/rejected + close if connected;
 *                                                broadcast; optional body {reason?}; 404 unknown
 */
import { z } from "zod";

import {
  IdentBody,
  RenameScreenBody,
  ServerToAgentApply,
  ServerToAgentRejected,
  ServerToPlayerIdent,
  ServerToPlayerRender,
  Surface,
} from "@polyptych/protocol";
import type { FastifyInstance } from "fastify";
import type { Screen, ScreenSlice } from "@polyptych/protocol";

import type { ControlPlane } from "./state";
import type { AgentHub, PlayerHub } from "./hub";
import type { AdminBroadcaster } from "./admin";

const ScreenParams = z.object({ screenId: z.string().min(1) });
const MachineParams = z.object({ machineId: z.string().min(1) });
const SurfacesBody = z.object({ surfaces: z.array(Surface) });
const DemoWebBody = z.object({ screenId: z.string().min(1), url: z.string().url() });
const RejectBody = z.object({ reason: z.string().optional() });

export function registerRestRoutes(
  fastify: FastifyInstance,
  control: ControlPlane,
  hub: PlayerHub,
  agentHub: AgentHub,
  broadcaster: AdminBroadcaster,
): void {
  function pushRender(screenId: string, slice: ScreenSlice): number {
    const message = ServerToPlayerRender.parse({
      t: "server/render",
      revision: control.state.revision,
      slice,
    });
    const delivered = hub.send(screenId, message);
    fastify.log.info(
      {
        event: "render.push",
        screenId,
        revision: control.state.revision,
        surfaces: slice.surfaces.length,
        delivered,
      },
      "pushed render to player(s)",
    );
    return delivered;
  }

  /** Flash (or clear) a screen's friendly name on its player overlay. Returns sockets delivered. */
  function sendIdentPulse(screen: Screen, on: boolean): number {
    const pulse = ServerToPlayerIdent.parse({
      t: "server/ident-pulse",
      on,
      friendlyName: screen.friendlyName,
      // color omitted → schema default "#00c2ff" fills it, so the wire frame carries {on, friendlyName, color}.
    });
    const delivered = hub.send(screen.id, pulse);
    fastify.log.info(
      { event: "ident.pulse", screenId: screen.id, friendlyName: screen.friendlyName, on, delivered },
      "pushed ident pulse to player(s)",
    );
    return delivered;
  }

  /** Schedule the auto-off pulse after ttlMs (re-resolving the screen so a rename mid-window is honoured). */
  function scheduleIdentOff(screenId: string, ttlMs: number): void {
    setTimeout(() => {
      const screen = control.getScreen(screenId);
      if (screen) sendIdentPulse(screen, false);
    }, ttlMs);
  }

  // ── Phase 1 routes (unchanged behaviour) ────────────────────────────────────

  // GET /api/v1/state -> DesiredState
  fastify.get("/api/v1/state", async () => control.state);

  // GET /api/v1/screens -> Screen[]
  fastify.get("/api/v1/screens", async () => control.getScreens());

  // POST /api/v1/screens/:screenId/surfaces  { surfaces: Surface[] }
  fastify.post("/api/v1/screens/:screenId/surfaces", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = SurfacesBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const slice = await control.setScreenSurfaces(params.data.screenId, body.data.surfaces);
    if (!slice) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    fastify.log.info(
      {
        event: "revision.bump",
        reason: "surfaces",
        screenId: params.data.screenId,
        surfaces: slice.surfaces.length,
        revision: control.state.revision,
      },
      "revision bumped",
    );
    pushRender(params.data.screenId, slice);
    broadcaster.broadcast(); // surfaceCount changed
    return { ok: true, revision: control.state.revision, slice };
  });

  // POST /api/v1/demo/web  { screenId, url }  -> single full-canvas web surface
  fastify.post("/api/v1/demo/web", async (request, reply) => {
    const body = DemoWebBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const slice = await control.setDemoWeb(body.data.screenId, body.data.url);
    if (!slice) {
      return reply.code(404).send({ error: `unknown screen: ${body.data.screenId}` });
    }

    fastify.log.info(
      {
        event: "revision.bump",
        reason: "demo/web",
        screenId: body.data.screenId,
        url: body.data.url,
        revision: control.state.revision,
      },
      "revision bumped",
    );
    pushRender(body.data.screenId, slice);
    broadcaster.broadcast(); // surfaceCount changed
    return { ok: true, revision: control.state.revision, slice };
  });

  // ── Phase 2a routes ─────────────────────────────────────────────────────────

  // GET /api/v1/machines -> Machine[]
  fastify.get("/api/v1/machines", async () => control.getMachines());

  // POST /api/v1/screens/:screenId/rename  { friendlyName }
  fastify.post("/api/v1/screens/:screenId/rename", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = RenameScreenBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const screen = await control.renameScreen(params.data.screenId, body.data.friendlyName);
    if (!screen) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    fastify.log.info(
      { event: "screen.rename", screenId: screen.id, friendlyName: screen.friendlyName },
      "screen renamed",
    );
    broadcaster.broadcast();
    return { ok: true, screen };
  });

  // POST /api/v1/screens/:screenId/ident  { on, ttlMs? }
  fastify.post("/api/v1/screens/:screenId/ident", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = IdentBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const screen = control.getScreen(params.data.screenId);
    if (!screen) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    const delivered = sendIdentPulse(screen, body.data.on);
    if (body.data.on && body.data.ttlMs) {
      scheduleIdentOff(screen.id, body.data.ttlMs);
    }
    return { ok: true, screenId: screen.id, on: body.data.on, delivered };
  });

  // POST /api/v1/machines/:machineId/ident  { on, ttlMs? }  -> ident every screen on the machine
  fastify.post("/api/v1/machines/:machineId/ident", async (request, reply) => {
    const params = MachineParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = IdentBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const machine = control.getMachine(params.data.machineId);
    if (!machine) {
      return reply.code(404).send({ error: `unknown machine: ${params.data.machineId}` });
    }

    const screens = control.getScreens().filter((s) => s.machineId === machine.id);
    let delivered = 0;
    for (const screen of screens) {
      delivered += sendIdentPulse(screen, body.data.on);
      if (body.data.on && body.data.ttlMs) {
        scheduleIdentOff(screen.id, body.data.ttlMs);
      }
    }
    return {
      ok: true,
      machineId: machine.id,
      on: body.data.on,
      screens: screens.map((s) => s.id),
      delivered,
    };
  });

  // ── Phase 2b operator routes (enrollment) ─────────────────────────────────────

  // POST /api/v1/machines/:machineId/approve  -> pending → approved; create screens; live apply.
  fastify.post("/api/v1/machines/:machineId/approve", async (request, reply) => {
    const params = MachineParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    const result = await control.approveMachine(params.data.machineId);
    if (!result) {
      return reply.code(404).send({ error: `unknown machine: ${params.data.machineId}` });
    }

    // Live admit: if the agent is connected NOW, push it server/apply for its (new) screens.
    const apply = ServerToAgentApply.parse({
      t: "server/apply",
      revision: control.state.revision,
      machineId: params.data.machineId,
      screens: result.assignments,
    });
    const delivered = agentHub.send(params.data.machineId, apply);

    fastify.log.info(
      {
        event: "machine.approve",
        machineId: params.data.machineId,
        screens: result.assignments.map((a) => a.screenId),
        revision: control.state.revision,
        changed: result.changed,
        delivered,
      },
      "machine approved",
    );
    broadcaster.broadcast();
    return {
      ok: true,
      machineId: params.data.machineId,
      status: "approved",
      screens: result.assignments.map((a) => a.screenId),
      revision: control.state.revision,
      delivered,
    };
  });

  // POST /api/v1/machines/:machineId/reject  { reason? }  -> status → rejected; close if connected.
  fastify.post("/api/v1/machines/:machineId/reject", async (request, reply) => {
    const params = MachineParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    // Body is optional; tolerate an absent/empty body, only read a {reason?} when present.
    const parsedBody = RejectBody.safeParse(request.body ?? {});
    const reason = parsedBody.success ? parsedBody.data.reason : undefined;

    const ok = await control.rejectMachine(params.data.machineId);
    if (!ok) {
      return reply.code(404).send({ error: `unknown machine: ${params.data.machineId}` });
    }

    // If the agent is connected NOW, tell it why and close its socket — it will never be admitted.
    const rejected = ServerToAgentRejected.parse({
      t: "server/rejected",
      reason: reason ?? "rejected by operator",
    });
    const delivered = agentHub.send(params.data.machineId, rejected);
    const closed = agentHub.close(params.data.machineId);

    fastify.log.info(
      { event: "machine.reject", machineId: params.data.machineId, reason, delivered, closed },
      "machine rejected",
    );
    broadcaster.broadcast();
    return {
      ok: true,
      machineId: params.data.machineId,
      status: "rejected",
      delivered,
      closed,
    };
  });
}
