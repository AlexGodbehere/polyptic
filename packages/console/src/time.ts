/**
 * Small presentation helpers for relative timestamps, shared by the Machines view and the cold-start
 * wizard so a machine's "last seen" reads the same everywhere.
 *
 * Mirrors the old SolidJS admin's formatLastSeen: a coarse, human-friendly relative string computed
 * against a ticking clock (the caller passes `nowMs` from a 1s interval so the value stays fresh).
 */

/** Human-friendly "last seen" relative to a ticking clock (so the value stays fresh on screen). */
export function formatLastSeen(iso: string | undefined, nowMs: number): string {
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

/** "2 screens" / "1 screen". */
export function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
