<!--
  WallCanvas — the spatial Vue Flow canvas of placed screens.

  Renders store.placedScreens(activeMuralId) as custom "screen" nodes at their
  placement {x,y} sized to {w,h}. Placement coordinates are in *canvas pixels*
  where the default w/h equal a screen's native resolution (≈1920×1080), so we
  apply a fixed display scale to keep tiles tile-sized and labels legible at
  zoom 1 (Vue Flow's own pan/zoom still works on top).

  Interactions:
    - drag a node  → store.moveScreen (converted back to canvas px)
    - drop a tray item (HTML5 DnD, screenId in dataTransfer) → store.placeScreen
    - click        → store.select([id]); shift-click toggles multi-select
    - click pane   → clear selection
-->
<script setup lang="ts">
import { ref, watch, computed } from "vue";
import type { Ref } from "vue";
import { VueFlow, useVueFlow } from "@vue-flow/core";
import type { Node } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import type { ScreenView } from "@polyptic/protocol";

import { useConsoleStore } from "../../stores/console";
import { useIdent } from "./useIdent";
import ScreenNode from "./ScreenNode.vue";
import SelectionToolbar from "./SelectionToolbar.vue";

/** Canvas-px → display-px. 0.0625 maps a 1920×1080 screen to a 120×67.5 tile. */
const SCALE = 0.0625;

const store = useConsoleStore();
const { identingIds } = useIdent();

const vf = useVueFlow();
const { onNodeClick, onPaneClick, onNodeDragStart, onNodeDragStop, onPaneReady, fitView } = vf;

// Cast past UnwrapRef: wrapping Vue Flow's deeply-generic Node in a ref otherwise trips TS2589.
const nodes = ref([]) as Ref<Node[]>;
const draggingIds = new Set<string>();
let didInitialFit = false;

const hasPlaced = computed(() =>
  store.activeMuralId ? store.placedScreens(store.activeMuralId).length > 0 : false,
);

function statusOf(screen: ScreenView): "live" | "empty" | "offline" {
  if (!screen.online) return "offline";
  return screen.surfaceCount > 0 ? "live" : "empty";
}

function buildData(screen: ScreenView) {
  const machine = store.machineForScreen(screen.id);
  const selected = store.selectedScreenIds.includes(screen.id);
  return {
    screenId: screen.id,
    name: screen.friendlyName,
    status: statusOf(screen),
    online: !!screen.online,
    surfaceCount: screen.surfaceCount ?? 0,
    machineLabel: machine ? machine.label : screen.machineId,
    connector: screen.connector,
    identing: identingIds.has(screen.id),
    selected,
    selectedAlone: selected && store.selectedScreenIds.length === 1,
  };
}

/** Reconcile the Vue Flow node list with the store, mutating in place so the
 *  canvas doesn't lose drag/selection state on every server push. */
function reconcile() {
  const muralId = store.activeMuralId;
  const placed = muralId ? store.placedScreens(muralId) : [];
  const wanted = new Map(placed.map((p) => [p.screen.id, p]));

  // Drop nodes that are no longer placed on this mural.
  for (let i = nodes.value.length - 1; i >= 0; i--) {
    const n = nodes.value[i];
    if (n && !wanted.has(n.id)) nodes.value.splice(i, 1);
  }

  for (const { screen, placement } of placed) {
    const data = buildData(screen);
    const pos = { x: placement.x * SCALE, y: placement.y * SCALE };
    const zIndex = data.identing ? 55 : data.selectedAlone ? 50 : data.selected ? 40 : 10;
    const style = {
      width: `${placement.w * SCALE}px`,
      height: `${placement.h * SCALE}px`,
      zIndex: String(zIndex),
    };
    const existing = nodes.value.find((n) => n.id === screen.id);
    if (existing) {
      existing.data = data;
      existing.style = style;
      // Don't yank a node out from under an in-progress drag.
      if (!draggingIds.has(screen.id)) {
        const cx = existing.position?.x ?? 0;
        const cy = existing.position?.y ?? 0;
        if (Math.abs(cx - pos.x) > 0.5 || Math.abs(cy - pos.y) > 0.5) existing.position = pos;
      }
    } else {
      nodes.value.push({
        id: screen.id,
        type: "screen",
        position: pos,
        data,
        style,
        draggable: true,
        selectable: true,
      } as Node);
    }
  }
}

watch(
  () => [
    store.activeMuralId,
    store.placements,
    store.machines,
    store.selectedScreenIds,
    [...identingIds],
  ],
  reconcile,
  { deep: true, immediate: true },
);

// Frame the wall once the first screens appear.
watch(
  () => nodes.value.length,
  (len) => {
    if (len > 0 && !didInitialFit) {
      didInitialFit = true;
      requestAnimationFrame(() => {
        try {
          fitView({ padding: 0.25 });
        } catch {
          /* canvas not ready yet — onPaneReady will catch it */
        }
      });
    }
  },
);

onPaneReady(() => {
  if (nodes.value.length > 0 && !didInitialFit) {
    didInitialFit = true;
    try {
      fitView({ padding: 0.25 });
    } catch {
      /* noop */
    }
  }
});

onNodeDragStart((p: any) => {
  const list = p?.nodes ?? (p?.node ? [p.node] : []);
  for (const n of list) draggingIds.add(n.id);
});

onNodeDragStop((p: any) => {
  const list = p?.nodes ?? (p?.node ? [p.node] : []);
  for (const n of list) {
    draggingIds.delete(n.id);
    store.moveScreen(n.id, Math.round(n.position.x / SCALE), Math.round(n.position.y / SCALE));
  }
});

onNodeClick((p: any) => {
  const id = p.node.id as string;
  const ev = p.event;
  const shift = !!(ev && (ev.shiftKey || (ev.srcEvent && ev.srcEvent.shiftKey)));
  if (shift) {
    const cur = new Set(store.selectedScreenIds);
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    store.select([...cur]);
  } else {
    store.select([id]);
  }
});

onPaneClick(() => store.select([]));

// ── Drop a screen from the Unplaced tray onto the canvas ───────────────────
function toFlow(clientX: number, clientY: number): { x: number; y: number } {
  const anyVf = vf as any;
  if (typeof anyVf.screenToFlowCoordinate === "function") {
    return anyVf.screenToFlowCoordinate({ x: clientX, y: clientY });
  }
  // Fallback for older @vue-flow/core: invert the viewport transform manually.
  const rect = anyVf.vueFlowRef?.value?.getBoundingClientRect?.();
  const vp = anyVf.viewport?.value ?? { x: 0, y: 0, zoom: 1 };
  const left = rect ? rect.left : 0;
  const top = rect ? rect.top : 0;
  return { x: (clientX - left - vp.x) / vp.zoom, y: (clientY - top - vp.y) / vp.zoom };
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  const dt = e.dataTransfer;
  const id = dt
    ? dt.getData("application/x-polyptic-screen") || dt.getData("text/plain")
    : "";
  if (!id || !store.activeMuralId) return;
  const f = toFlow(e.clientX, e.clientY);
  store.placeScreen(id, store.activeMuralId, Math.round(f.x / SCALE), Math.round(f.y / SCALE));
}

function onDragOver(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
}
</script>

<template>
  <div class="wall-canvas" @drop="onDrop" @dragover="onDragOver">
    <VueFlow
      v-model:nodes="nodes"
      class="wall-flow"
      :min-zoom="0.2"
      :max-zoom="2"
      :snap-to-grid="true"
      :snap-grid="[12, 12]"
      :default-viewport="{ x: 40, y: 40, zoom: 1 }"
      :select-nodes-on-drag="false"
      :nodes-connectable="false"
      :elements-selectable="true"
    >
      <Background :gap="24" :size="1.2" pattern-color="var(--dot)" />
      <Controls :show-interactive="false" />

      <template #node-screen="nodeProps">
        <ScreenNode :id="nodeProps.id" :data="nodeProps.data" />
      </template>
    </VueFlow>

    <SelectionToolbar />

    <div v-if="!hasPlaced" class="empty-canvas">
      <div class="empty-card">
        <div class="empty-glyph">▦</div>
        <div class="empty-title">No screens on this mural yet</div>
        <div class="empty-sub">
          Drag a screen from the <b>Unplaced</b> tray onto the canvas, or hit <b>Place</b>.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wall-canvas {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
  background: var(--bg);
  overflow: hidden;
}
.wall-flow {
  width: 100%;
  height: 100%;
}

.empty-canvas {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 26px 30px;
  border: 1.5px dashed var(--line2);
  border-radius: 13px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  text-align: center;
  max-width: 320px;
}
.empty-glyph {
  font-size: 22px;
  color: var(--muted2);
}
.empty-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--fg2);
}
.empty-sub {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}

/* Tone Vue Flow's chrome to the console palette. */
.wall-flow :deep(.vue-flow__node) {
  font-family: inherit;
}
/* Selection + focus are drawn by ScreenNode's own ring — silence Vue Flow's. */
.wall-flow :deep(.vue-flow__node:focus),
.wall-flow :deep(.vue-flow__node:focus-visible) {
  outline: none;
}
.wall-flow :deep(.vue-flow__node-screen.selected) {
  box-shadow: none;
}
.wall-flow :deep(.vue-flow__controls) {
  box-shadow: var(--shadow);
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid var(--line);
}
.wall-flow :deep(.vue-flow__controls-button) {
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  color: var(--fg2);
  width: 28px;
  height: 28px;
}
.wall-flow :deep(.vue-flow__controls-button:hover) {
  background: var(--muted-bg);
}
.wall-flow :deep(.vue-flow__controls-button svg) {
  fill: currentColor;
}
</style>
