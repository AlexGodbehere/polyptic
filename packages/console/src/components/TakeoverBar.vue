<!--
  TakeoverBar.vue — the live takeover strip (POL-90).

  One row per running takeover, pinned above every view in the app shell, because a takeover is FLEET
  state: an operator who did not start it must still see that the atrium is showing a fire-alarm
  notice, how long is left, and be able to end it. The countdown ticks against a single 1s clock and
  is derived from the server's `expiresAt`, so two consoles never disagree about the time remaining.

  A takeover with no TTL reads "until ended" — the one case where somebody does have to remember.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import type { Override } from "@polyptic/protocol";

import { useConsoleStore } from "../stores/console";
import { formatCountdown } from "../time";

const store = useConsoleStore();

// One ticking clock for every countdown on screen (the same pattern the activity feed uses).
const now = ref(Date.now());
const timer = setInterval(() => (now.value = Date.now()), 1000);
onBeforeUnmount(() => clearInterval(timer));

const overrides = computed(() => store.overrides);

/** What this takeover covers, in the operator's words — the same names the canvas uses. */
function targetLabel(o: Override): string {
  switch (o.scope) {
    case "fleet":
      return "Every screen";
    case "mural":
      return store.murals.find((m) => m.id === o.targetId)?.name ?? "A mural";
    case "wall":
      return o.targetId ? store.wallName(o.targetId) : "A combined surface";
    case "screen":
      return store.screenById(o.targetId ?? "")?.friendlyName ?? "A screen";
  }
}

/** "Cast" when it covers one screen, "Takeover" otherwise — same mechanism, the operator's word for it. */
function kindLabel(o: Override): string {
  return o.scope === "screen" ? "Cast" : "Takeover";
}

function remaining(o: Override): string {
  return o.expiresAt ? `${formatCountdown(o.expiresAt, now.value)} left` : "until ended";
}
</script>

<template>
  <div v-if="overrides.length" class="takeover-bar">
    <div v-for="o in overrides" :key="o.id" class="row">
      <span class="badge">{{ kindLabel(o) }}</span>
      <span class="what">
        <strong>{{ targetLabel(o) }}</strong>
        <span class="arrow">→</span>
        <span class="content">{{ o.label }}</span>
      </span>
      <span class="countdown" :class="{ open: !o.expiresAt }">{{ remaining(o) }}</span>
      <button class="end" @click="store.endTakeover(o.id)">End now</button>
    </div>
  </div>
</template>

<style scoped>
.takeover-bar {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--line);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  background: var(--warn-soft);
  color: var(--fg);
  font-size: 13px;
}
.row + .row {
  border-top: 1px solid var(--line);
}
.badge {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--warn);
  border: 1px solid var(--warn);
  border-radius: 4px;
  padding: 1px 6px;
}
.what {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.arrow {
  color: var(--muted);
}
.content {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
}
.countdown {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--warn);
}
.countdown.open {
  font-weight: 500;
  color: var(--muted);
}
.end {
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--fg);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.end:hover {
  border-color: var(--warn);
  color: var(--warn);
}
</style>
