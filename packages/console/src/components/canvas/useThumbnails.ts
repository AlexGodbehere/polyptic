/**
 * Live-preview thumbnails for screens (Phase 5).
 *
 * A single, module-level manager polls the control plane for each *visible, online* screen's latest
 * capture and hands every interested component a reactive object URL it can paint as the screen's
 * background. The agent already captures on demand (server/capture → grim/scrot → agent/thumbnail);
 * the server caches the most recent frame per machine and serves it at GET
 * /api/v1/screens/:id/thumbnail. Here we just pull that on a throttle and keep the canvas snappy:
 *
 *   • One shared interval drives ALL previews — we never refetch per render, and never spin up a
 *     timer per node. Components register interest on mount and drop it on unmount (ref-counted), so
 *     only screens actually on-screen are polled.
 *   • Each refresh fetches a fresh blob, swaps it in, and revokes the PREVIOUS object URL — no leaks.
 *   • A screen that goes offline is paused immediately (its last frame is cleared so the node falls
 *     back to its neutral/empty styling); coming back online triggers an immediate refetch.
 *   • Overlapping fetches for the same screen are coalesced (an in-flight guard), so a slow capture
 *     can't pile up requests.
 *
 * The reactive URL map is module-scoped so every `useScreenThumbnail()` call observes the same frames.
 */
import { computed, onScopeDispose, reactive, toValue, watch } from "vue";
import type { ComputedRef, MaybeRefOrGetter } from "vue";

import { fetchThumbnail } from "../../api";

/** How often a visible, online screen's preview is refreshed (ms). Throttled to keep the wall calm
 *  and the control plane unhammered; the agent capture itself is the expensive part. */
const REFRESH_MS = 4000;

// screenId → current object URL (or absent when there's no live frame). Reactive so template reads
// repaint automatically; revoked URLs are deleted so `has`/lookup reflects reality.
const urls = reactive(new Map<string, string>());

// How many mounted components currently want each screen's preview. At zero we forget the screen and
// release its frame.
const refCounts = new Map<string, number>();

// Latest known online flag per screen, kept current by each subscriber's watcher. The poll loop only
// fetches screens that are online.
const online = new Map<string, boolean>();

// Screens with an outstanding fetch — guards against overlapping requests for one screen.
const inflight = new Set<string>();

let timer: ReturnType<typeof setInterval> | null = null;

/** Swap in a new object URL for a screen, revoking whatever frame it replaces. Passing null clears. */
function setUrl(screenId: string, url: string | null): void {
  const prev = urls.get(screenId);
  if (prev && prev !== url) {
    try {
      URL.revokeObjectURL(prev);
    } catch {
      /* already revoked */
    }
  }
  if (url) urls.set(screenId, url);
  else urls.delete(screenId);
}

/** Fetch one screen's latest frame (unless one is already in flight, or it went offline meanwhile). */
async function refreshOne(screenId: string): Promise<void> {
  if (inflight.has(screenId)) return;
  if (!online.get(screenId)) return;
  inflight.add(screenId);
  try {
    const url = await fetchThumbnail(screenId);
    // The screen may have unmounted or gone offline while the request was in flight — if so, drop the
    // frame we just got (and revoke it) instead of painting a stale capture.
    if (!refCounts.get(screenId) || !online.get(screenId)) {
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* noop */
        }
      }
      return;
    }
    if (url) setUrl(screenId, url);
    // A 204/null is "no frame yet" — keep the last good frame rather than flashing to empty.
  } finally {
    inflight.delete(screenId);
  }
}

/** Refresh every registered, online screen. The shared interval's tick. */
function refreshAll(): void {
  for (const [screenId, count] of refCounts) {
    if (count > 0 && online.get(screenId)) void refreshOne(screenId);
  }
}

/** Start the shared poll loop if it isn't already running. */
function ensureTimer(): void {
  if (timer !== null) return;
  timer = setInterval(refreshAll, REFRESH_MS);
}

/** Stop the poll loop once nothing is registered (and release any lingering frames). */
function maybeStopTimer(): void {
  if (refCounts.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Subscribe a component to one screen's live preview. Pass the screen id and its current online flag
 * (refs, getters, or plain values — all are unwrapped reactively). Returns a reactive object URL,
 * or null when there's no frame / the screen is offline; paint it as a `background-image`.
 *
 * Registration is ref-counted and automatically released on scope dispose (component unmount), at
 * which point the screen's frame is revoked if nothing else wants it.
 */
export function useScreenThumbnail(
  screenId: MaybeRefOrGetter<string>,
  isOnline: MaybeRefOrGetter<boolean>,
): ComputedRef<string | null> {
  let registered: string | null = null;

  function register(id: string): void {
    refCounts.set(id, (refCounts.get(id) ?? 0) + 1);
    registered = id;
    ensureTimer();
  }

  function release(id: string): void {
    const next = (refCounts.get(id) ?? 1) - 1;
    if (next <= 0) {
      refCounts.delete(id);
      online.delete(id);
      setUrl(id, null); // revoke the frame nobody is watching anymore
    } else {
      refCounts.set(id, next);
    }
    maybeStopTimer();
  }

  // Track the screen id; re-register (and clean up the old id) if it ever changes for this subscriber.
  watch(
    () => toValue(screenId),
    (id, prev) => {
      if (prev && prev !== id) release(prev);
      if (id && id !== registered) register(id);
    },
    { immediate: true },
  );

  // Track online state; an online→ fetch happens immediately so the preview appears without waiting a
  // whole interval, and offline clears the frame so the node falls back to its neutral styling.
  watch(
    () => [toValue(screenId), toValue(isOnline)] as const,
    ([id, on]) => {
      if (!id) return;
      online.set(id, !!on);
      if (on) void refreshOne(id);
      else setUrl(id, null);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    if (registered) release(registered);
  });

  return computed(() => {
    const id = toValue(screenId);
    return id ? (urls.get(id) ?? null) : null;
  });
}
