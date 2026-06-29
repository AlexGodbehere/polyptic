/**
 * The two WebSocket channels, multiplexed onto Fastify's underlying HTTP server.
 *
 *   /agent   (machine ↔ server): enrollment + status. On `agent/hello` we register the machine,
 *            ensure a Screen per output, and reply `server/apply` with each output's screen id and
 *            player URL. The agent then opens those URLs via its DisplayBackend.
 *
 *   /player  (screen ↔ server): the instant content path. On `player/hello` we register the socket
 *            under its screenId and reply `server/render` with the screen's current slice. Subsequent
 *            slice changes are pushed by the REST layer through the PlayerHub.
 *
 * Every inbound frame is parsed with the protocol's zod schemas at the edge; malformed frames are
 * logged and dropped, never trusted.
 */
import { WebSocket, WebSocketServer } from "ws";

import {
  AgentMessage,
  PlayerMessage,
  ServerToAgentApply,
  ServerToPlayerRender,
  parseMessage,
} from "@polyptych/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { Server } from "node:http";
import type { RawData } from "ws";

import type { ControlPlane } from "./state";
import type { PlayerHub } from "./hub";

interface WsDeps {
  server: Server;
  control: ControlPlane;
  hub: PlayerHub;
  log: FastifyBaseLogger;
}

export function attachWebSockets({ server, control, hub, log }: WsDeps): void {
  const agentWss = new WebSocketServer({ noServer: true });
  const playerWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname === "/agent") {
      agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit("connection", ws, req));
    } else if (pathname === "/player") {
      playerWss.handleUpgrade(req, socket, head, (ws) => playerWss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  agentWss.on("connection", (ws: WebSocket) => handleAgent(ws, control, log));
  playerWss.on("connection", (ws: WebSocket) => handlePlayer(ws, control, hub, log));
}

function handleAgent(ws: WebSocket, control: ControlPlane, log: FastifyBaseLogger): void {
  log.info({ event: "agent.connected" }, "agent socket opened");
  let machineId: string | null = null;

  ws.on("message", (data: RawData) => {
    let msg: AgentMessage;
    try {
      msg = parseMessage(AgentMessage, data.toString());
    } catch (err) {
      log.warn({ event: "agent.frame.invalid", err: String(err) }, "rejected invalid agent frame");
      return;
    }

    if (msg.t === "agent/hello") {
      machineId = msg.machineId;
      const { changed, assignments } = control.registerMachine({
        machineId: msg.machineId,
        agentVersion: msg.agentVersion,
        backend: msg.backend,
        outputs: msg.outputs,
      });
      const apply = ServerToAgentApply.parse({
        t: "server/apply",
        revision: control.state.revision,
        machineId: msg.machineId,
        screens: assignments,
      });
      ws.send(JSON.stringify(apply));
      log.info(
        {
          event: "agent.hello",
          machineId: msg.machineId,
          agentVersion: msg.agentVersion,
          backend: msg.backend,
          outputs: msg.outputs.length,
          screens: assignments.map((a) => a.screenId),
          revision: control.state.revision,
          changed,
        },
        "agent registered",
      );
    } else if (msg.t === "agent/status") {
      log.info(
        { event: "agent.status", machineId: msg.machineId, observedRevision: msg.observedRevision },
        "agent status",
      );
    } else {
      // agent/thumbnail — captured but not yet stored (Phase 5).
      log.debug(
        { event: "agent.thumbnail", machineId: msg.machineId, connector: msg.connector, mime: msg.mime },
        "agent thumbnail",
      );
    }
  });

  ws.on("close", (code) => log.info({ event: "agent.disconnected", machineId, code }, "agent socket closed"));
  ws.on("error", (err) => log.warn({ event: "agent.error", machineId, err: String(err) }, "agent socket error"));
}

function handlePlayer(
  ws: WebSocket,
  control: ControlPlane,
  hub: PlayerHub,
  log: FastifyBaseLogger,
): void {
  log.info({ event: "player.connected" }, "player socket opened");
  let screenId: string | null = null;

  ws.on("message", (data: RawData) => {
    let msg: PlayerMessage;
    try {
      msg = parseMessage(PlayerMessage, data.toString());
    } catch (err) {
      log.warn({ event: "player.frame.invalid", err: String(err) }, "rejected invalid player frame");
      return;
    }

    if (msg.t === "player/hello") {
      screenId = msg.screenId;
      hub.add(screenId, ws);
      const slice = control.sliceForPlayer(screenId);
      const render = ServerToPlayerRender.parse({
        t: "server/render",
        revision: control.state.revision,
        slice,
      });
      ws.send(JSON.stringify(render));
      log.info(
        {
          event: "player.hello",
          screenId,
          revision: control.state.revision,
          surfaces: slice.surfaces.length,
          sockets: hub.count(screenId),
        },
        "player registered",
      );
    } else {
      // player/ack
      log.debug(
        { event: "player.ack", screenId: msg.screenId, revision: msg.revision },
        "player ack",
      );
    }
  });

  ws.on("close", (code) => {
    if (screenId) hub.remove(screenId, ws);
    log.info({ event: "player.disconnected", screenId, code }, "player socket closed");
  });
  ws.on("error", (err) => log.warn({ event: "player.error", screenId, err: String(err) }, "player socket error"));
}
