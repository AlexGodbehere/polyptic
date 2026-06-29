/**
 * REST surface of the control plane. Every body/param is parsed with the protocol's zod schemas
 * (or zod built from them) at the edge. A mutation bumps the revision and immediately pushes a
 * `server/render` to the affected screen's player socket(s) — the instant path.
 */
import { z } from "zod";

import { ServerToPlayerRender, Surface } from "@polyptych/protocol";
import type { FastifyInstance } from "fastify";
import type { ScreenSlice } from "@polyptych/protocol";

import type { ControlPlane } from "./state";
import type { PlayerHub } from "./hub";

const ScreenParams = z.object({ screenId: z.string().min(1) });
const SurfacesBody = z.object({ surfaces: z.array(Surface) });
const DemoWebBody = z.object({ screenId: z.string().min(1), url: z.string().url() });

export function registerRestRoutes(
  fastify: FastifyInstance,
  control: ControlPlane,
  hub: PlayerHub,
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

    const slice = control.setScreenSurfaces(params.data.screenId, body.data.surfaces);
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
    return { ok: true, revision: control.state.revision, slice };
  });

  // POST /api/v1/demo/web  { screenId, url }  -> single full-canvas web surface
  fastify.post("/api/v1/demo/web", async (request, reply) => {
    const body = DemoWebBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const slice = control.setDemoWeb(body.data.screenId, body.data.url);
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
    return { ok: true, revision: control.state.revision, slice };
  });
}
