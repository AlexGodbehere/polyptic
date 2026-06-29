/**
 * Shared "ident" visual state for the Wall view.
 *
 * Ident itself is a fire-and-forget REST pulse (store.identScreen → POST /ident).
 * The contract's admin/state does NOT carry a live "is identing" flag, so the
 * flash-on-wall affordance is reflected in the console purely as ephemeral UI
 * state held here. Any component (tray, inspector, selection toolbar, canvas
 * node) can trigger an ident and observe which screens are currently flashing.
 *
 * The reactive Set is module-level so every `useIdent()` call shares it.
 */
import { reactive } from "vue";
import { useConsoleStore } from "../../stores/console";

const identingIds = reactive(new Set<string>());
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Mirror the player ident-pulse duration (a few seconds) for the on-canvas flash. */
const IDENT_MS = 3200;

export function useIdent() {
  function ident(screenId: string) {
    // Fire the real pulse through the store (REST → server → player).
    useConsoleStore().identScreen(screenId);

    identingIds.add(screenId);
    const prev = timers.get(screenId);
    if (prev) clearTimeout(prev);
    timers.set(
      screenId,
      setTimeout(() => {
        identingIds.delete(screenId);
        timers.delete(screenId);
      }, IDENT_MS),
    );
  }

  function identMany(ids: string[]) {
    for (const id of ids) ident(id);
  }

  function isIdenting(id: string): boolean {
    return identingIds.has(id);
  }

  return { identingIds, ident, identMany, isIdenting };
}
