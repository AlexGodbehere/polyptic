<!--
  ScreenNode — the custom Vue Flow node for a placed screen.

  Purely presentational: it is driven entirely by the `data` object that
  WallCanvas builds from the store (friendly name, connection/online state,
  surface count, machine label, selection + ident flags). It mirrors the
  "screen tile" visual language from docs/design/console.dc.html (buildScreen):
  a translucent label chip with a connection dot, and live / empty / offline /
  ident states. (An `error` branch is included to match the design; the 3a
  contract carries no per-screen error signal, so it is never triggered yet.)
-->
<script setup lang="ts">
import { computed } from "vue";

type ScreenStatus = "live" | "empty" | "offline" | "error";

interface ScreenNodeData {
  screenId: string;
  name: string;
  status: ScreenStatus;
  online: boolean;
  surfaceCount: number;
  machineLabel: string;
  connector: string;
  identing: boolean;
  selected: boolean;
  selectedAlone: boolean;
}

const props = defineProps<{ id: string; data: ScreenNodeData }>();

const dotColor = computed(() => {
  if (props.data.status === "offline") return "var(--bad)";
  if (props.data.status === "error") return "var(--warn)";
  return "var(--ok)";
});

const bgBorder = computed<Record<string, string>>(() => {
  switch (props.data.status) {
    case "offline":
      return { background: "var(--scr-off-bg)", border: "1px solid var(--line)" };
    case "error":
      return { background: "var(--scr-bad-bg)", border: "1px solid var(--scr-bad-line)" };
    case "empty":
      return { background: "var(--scr-empty-bg)", border: "1.5px dashed var(--scr-empty-line)" };
    default:
      return { background: "var(--scr-live)", border: "1px solid var(--line)" };
  }
});

const ring = computed(() => {
  if (props.data.selectedAlone) return "0 0 0 2px var(--accent), var(--shadow-lg)";
  if (props.data.selected) return "0 0 0 1.5px var(--accent-line), var(--shadow)";
  return "var(--shadow-sm)";
});

const nodeStyle = computed<Record<string, string>>(() => {
  const s: Record<string, string> = { ...bgBorder.value };
  // While identing, the keyframe animation owns box-shadow.
  if (!props.data.identing) s.boxShadow = ring.value;
  return s;
});

const contentLabel = computed(() =>
  props.data.surfaceCount === 1 ? "Showing content" : `${props.data.surfaceCount} surfaces`,
);
const kindLabel = computed(() =>
  `${props.data.surfaceCount} surface${props.data.surfaceCount === 1 ? "" : "s"}`,
);
</script>

<template>
  <div class="screen-node" :class="{ identing: data.identing }" :style="nodeStyle">
    <!-- label chip -->
    <div class="label">
      <span class="dot" :style="{ background: dotColor }"></span>
      <span class="name">{{ data.name }}</span>
    </div>

    <!-- ident overlay (wins over everything else) -->
    <div v-if="data.identing" class="state ident-state">
      <span class="ident-tag">IDENT</span>
      <span class="ident-name">{{ data.name }}</span>
      <span class="ident-sub">flashing on wall…</span>
    </div>

    <template v-else>
      <!-- live -->
      <template v-if="data.status === 'live'">
        <div class="state live-state">
          <span class="content-name">{{ contentLabel }}</span>
        </div>
        <span class="kind-label">{{ kindLabel }}</span>
      </template>

      <!-- error (not reachable from the 3a contract; kept for parity) -->
      <div v-else-if="data.status === 'error'" class="state error-state">
        <span class="err-glyph">⚠</span>
        <span class="err-text">Content failed to load<br />retrying…</span>
      </div>

      <!-- empty -->
      <div v-else-if="data.status === 'empty'" class="state empty-state">
        <span class="plus">+</span>
        <span class="empty-text">Drop content</span>
      </div>

      <!-- offline -->
      <div v-else class="state offline-state">
        <span class="off-1">Screen dark</span>
        <span class="off-2">Machine unreachable</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.screen-node {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 9px;
  overflow: hidden;
  cursor: grab;
  user-select: none;
  box-sizing: border-box;
}
.screen-node.identing {
  animation: ident-flash 1.4s infinite;
}

.label {
  position: absolute;
  top: 7px;
  left: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--label-bg);
  padding: 3px 8px;
  border-radius: 6px;
  z-index: 4;
  backdrop-filter: blur(3px);
  max-width: calc(100% - 16px);
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.name {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.state {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 5px;
  padding: 0 10px;
  text-align: center;
}
.live-state {
  gap: 3px;
}
.content-name {
  font-size: 11.5px;
  color: var(--fg2);
  font-weight: 500;
}
.kind-label {
  position: absolute;
  bottom: 7px;
  left: 8px;
  font-size: 9.5px;
  color: var(--muted);
  font-weight: 500;
  z-index: 3;
}

.err-glyph {
  font-size: 15px;
  color: var(--bad);
}
.err-text {
  font-size: 10px;
  color: var(--bad);
  font-weight: 500;
  line-height: 1.45;
}

.plus {
  font-size: 16px;
  color: var(--accent);
  font-weight: 300;
}
.empty-text {
  font-size: 10px;
  color: var(--muted);
  font-weight: 500;
}

.off-1 {
  font-size: 10px;
  color: var(--muted);
  font-weight: 500;
}
.off-2 {
  font-size: 9.5px;
  color: var(--bad);
  font-weight: 500;
}

.ident-state {
  gap: 3px;
  background: rgba(37, 99, 235, 0.16);
  z-index: 6;
}
.ident-tag {
  font-size: 9px;
  letter-spacing: 0.12em;
  color: var(--accent-fg);
  font-weight: 600;
}
.ident-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
}
.ident-sub {
  font-size: 9.5px;
  color: var(--accent-fg);
}

@keyframes ident-flash {
  0%,
  100% {
    box-shadow: 0 0 0 2px var(--accent), 0 0 26px rgba(59, 130, 246, 0.55);
  }
  50% {
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
  }
}
</style>
