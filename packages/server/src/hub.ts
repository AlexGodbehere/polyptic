/**
 * Player socket registry — the "instant" fan-out path.
 *
 * Tracks live player WebSockets keyed by screenId so a render push reaches exactly the
 * player(s) showing that screen (a screen may have >1 socket open during reconnects).
 * Content goes server → player directly (never through the agent) for speed.
 */
import { WebSocket } from "ws";

import type { ServerToPlayerMessage } from "@polyptych/protocol";

export class PlayerHub {
  private readonly byScreen = new Map<string, Set<WebSocket>>();

  add(screenId: string, socket: WebSocket): void {
    let set = this.byScreen.get(screenId);
    if (!set) {
      set = new Set<WebSocket>();
      this.byScreen.set(screenId, set);
    }
    set.add(socket);
  }

  remove(screenId: string, socket: WebSocket): void {
    const set = this.byScreen.get(screenId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.byScreen.delete(screenId);
  }

  count(screenId: string): number {
    return this.byScreen.get(screenId)?.size ?? 0;
  }

  /** Send a validated server→player message to every open socket on a screen. Returns count delivered. */
  send(screenId: string, message: ServerToPlayerMessage): number {
    const set = this.byScreen.get(screenId);
    if (!set || set.size === 0) return 0;
    const data = JSON.stringify(message);
    let delivered = 0;
    for (const socket of set) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
        delivered += 1;
      }
    }
    return delivered;
  }
}
