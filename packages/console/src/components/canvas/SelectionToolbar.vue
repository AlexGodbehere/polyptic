<!--
  SelectionToolbar — floating affordance shown when more than one screen is
  selected on the canvas. For 3a, selection only highlights; *combining*
  several panels into one surface lands in 3b, so the combine action is shown
  as a disabled hint. Ident-all is live.
-->
<script setup lang="ts">
import { computed } from "vue";
import { useConsoleStore } from "../../stores/console";
import { useIdent } from "./useIdent";

const store = useConsoleStore();
const { identMany } = useIdent();

const count = computed(() => store.selectedScreenIds.length);

function identAll() {
  identMany([...store.selectedScreenIds]);
}
</script>

<template>
  <div v-if="count > 1" class="sel-toolbar">
    <span class="sel-count">{{ count }} screens selected</span>
    <button class="sel-btn" @click="identAll">
      <span class="dot"></span>Ident all
    </button>
    <span class="sel-combine" title="Combining lands in Phase 3b">▦ Combine · 3b</span>
  </div>
</template>

<style scoped>
.sel-toolbar {
  position: absolute;
  left: 50%;
  top: 14px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 6px 8px 6px 12px;
  box-shadow: var(--shadow-lg);
  z-index: 90;
}
.sel-count {
  font-size: 12px;
  color: var(--fg2);
  font-weight: 500;
  white-space: nowrap;
}
.sel-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 12px;
  color: var(--fg2);
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.sel-btn:hover {
  background: var(--muted-bg);
}
.sel-btn .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.sel-combine {
  display: flex;
  align-items: center;
  padding: 6px 11px;
  border-radius: 7px;
  background: var(--muted-bg);
  color: var(--muted2);
  font-size: 12px;
  font-weight: 600;
  cursor: not-allowed;
  white-space: nowrap;
}
</style>
