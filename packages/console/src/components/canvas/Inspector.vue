<!--
  Inspector — the right-hand context panel for the canvas selection.

  Three states, mirroring docs/design/console.dc.html:
    - empty   : nothing selected → prompt to pick a screen
    - single  : rename, Ident (flash on wall), status + "Driven by {machine}",
                assign content (type a URL), layout read-out, remove from wall
    - multi   : count + member list + Ident-all; combining lands in 3b

  All reads/writes go through the Pinia store; ident uses the shared composable.
-->
<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useConsoleStore } from "../../stores/console";
import { useIdent } from "./useIdent";

const store = useConsoleStore();
const { ident, identMany, isIdenting } = useIdent();

const selectedIds = computed(() => store.selectedScreenIds);
const count = computed(() => selectedIds.value.length);

const single = computed(() => {
  const id = selectedIds.value[0];
  return count.value === 1 && id ? store.screenById(id) : undefined;
});
const members = computed(() =>
  selectedIds.value
    .map((id) => store.screenById(id))
    .filter((s): s is NonNullable<typeof s> => !!s),
);

// ── rename ─────────────────────────────────────────────────────────────────
const nameDraft = ref("");
watch(
  single,
  (s) => {
    nameDraft.value = s ? s.friendlyName : "";
  },
  { immediate: true },
);
function commitName() {
  const s = single.value;
  if (!s) return;
  const v = nameDraft.value.trim();
  if (v && v !== s.friendlyName) store.renameScreen(s.id, v);
  else nameDraft.value = s.friendlyName;
}

// ── content URL ────────────────────────────────────────────────────────────
const urlDraft = ref("");
watch(single, () => {
  urlDraft.value = "";
});
function submitUrl() {
  const s = single.value;
  if (!s) return;
  const u = urlDraft.value.trim();
  if (!u) return;
  store.setScreenContentUrl(s.id, u);
  urlDraft.value = "";
}

// ── derived single-screen view ─────────────────────────────────────────────
const identingSingle = computed(() => (single.value ? isIdenting(single.value.id) : false));
const statusLabel = computed(() => {
  const s = single.value;
  if (!s) return "";
  if (identingSingle.value) return "Identing…";
  return s.online ? "Connected" : "Unreachable";
});
const statusColor = computed(() => {
  const s = single.value;
  if (!s) return "var(--ok)";
  return s.online ? "var(--ok)" : "var(--bad)";
});
const machineLine = computed(() => {
  const s = single.value;
  if (!s) return "";
  const m = store.machineForScreen(s.id);
  return `${m ? m.label : s.machineId} · ${s.connector}`;
});
const placement = computed(() =>
  single.value ? store.placementForScreen(single.value.id) : undefined,
);
const posText = computed(() => {
  const p = placement.value;
  return p ? `x ${Math.round(p.x)}  y ${Math.round(p.y)}` : "—";
});
const sizeText = computed(() => {
  const p = placement.value;
  return p ? `${Math.round(p.w)} × ${Math.round(p.h)}` : "—";
});
const hasContent = computed(() => (single.value?.surfaceCount ?? 0) > 0);
const surfaceText = computed(() => {
  const n = single.value?.surfaceCount ?? 0;
  return `${n} surface${n === 1 ? "" : "s"} on air`;
});

// ── actions ────────────────────────────────────────────────────────────────
function identSingle() {
  if (single.value) ident(single.value.id);
}
function identAll() {
  identMany([...selectedIds.value]);
}
function unplace() {
  if (single.value) store.unplaceScreen(single.value.id);
}
function selectOne(id: string) {
  store.select([id]);
}
</script>

<template>
  <div class="inspector">
    <!-- ── SINGLE ─────────────────────────────────────────────────────── -->
    <section v-if="single" class="pad">
      <div class="section-label">Screen</div>
      <input
        v-model="nameDraft"
        class="name-input"
        @blur="commitName"
        @keyup.enter="commitName"
      />

      <button class="ident-btn" :class="{ on: identingSingle }" @click="identSingle">
        <span class="dot accent"></span>
        {{ identingSingle ? "Flashing on wall…" : "Ident — flash on wall" }}
      </button>

      <div class="status-row">
        <span class="dot" :style="{ background: statusColor }"></span>
        <span class="status-text">{{ statusLabel }}</span>
      </div>
      <div class="driven-by">Driven by {{ machineLine }}</div>

      <div class="section-label gap-top">Content</div>
      <div v-if="hasContent" class="content-card">
        <span class="thumb"></span>
        <span class="content-meta">
          <span class="content-name">On air</span>
          <span class="content-kind">{{ surfaceText }}</span>
        </span>
      </div>
      <div v-else class="content-empty">No content yet</div>

      <div class="url-field">
        <input
          v-model="urlDraft"
          class="url-input"
          placeholder="https://…"
          @keyup.enter="submitUrl"
        />
        <button class="url-btn" :disabled="!urlDraft.trim()" @click="submitUrl">Show</button>
      </div>
      <div class="hint">Type a URL to display it on this screen.</div>

      <div class="section-label gap-top">Layout</div>
      <div class="layout-grid">
        <div class="layout-cell">{{ posText }}</div>
        <div class="layout-cell">{{ sizeText }}</div>
      </div>

      <button class="unplace-btn" @click="unplace">Remove from wall</button>
    </section>

    <!-- ── MULTI ──────────────────────────────────────────────────────── -->
    <section v-else-if="count > 1" class="pad">
      <div class="section-label">Selection</div>
      <div class="multi-count">{{ count }} screens selected</div>

      <button class="ident-btn block" @click="identAll">
        <span class="dot accent"></span>Ident all
      </button>

      <div class="member-list">
        <button
          v-for="m in members"
          :key="m.id"
          class="member"
          @click="selectOne(m.id)"
        >
          <span class="dot" :style="{ background: m.online ? 'var(--ok)' : 'var(--bad)' }"></span>
          <span class="member-name">{{ m.friendlyName }}</span>
        </button>
      </div>

      <div class="hint gap-top">
        Combining several panels into one surface — content spanning across, with
        bezel seams — lands in Phase 3b.
      </div>
    </section>

    <!-- ── EMPTY ──────────────────────────────────────────────────────── -->
    <section v-else class="pad">
      <div class="section-label">Screen</div>
      <div class="empty-state">
        <span class="empty-glyph">◫</span>
        <span class="empty-title">Select a screen on the canvas</span>
        <span class="empty-sub">
          Click to rename &amp; ident · shift-click<br />several to multi-select
        </span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  border-left: 1px solid var(--line);
  overflow-y: auto;
}
.pad {
  padding: 18px 16px;
}

.section-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 11px;
}
.gap-top {
  margin-top: 18px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.dot.accent {
  background: var(--accent);
}

.name-input {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  outline: none;
  margin-bottom: 12px;
  font-family: inherit;
}
.name-input:focus {
  border-color: var(--accent);
}

.ident-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  color: var(--fg);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  margin-bottom: 18px;
  font-family: inherit;
}
.ident-btn:hover {
  background: var(--muted-bg);
}
.ident-btn.on {
  border-color: var(--accent-line);
  color: var(--accent-fg);
}
.ident-btn.block {
  margin-bottom: 16px;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.status-text {
  font-size: 12.5px;
  color: var(--fg2);
  font-weight: 500;
}
.driven-by {
  font-size: 12px;
  color: var(--muted);
}

.content-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px;
  border-radius: 9px;
  border: 1px solid var(--line);
}
.thumb {
  width: 44px;
  height: 26px;
  border-radius: 5px;
  background: var(--scr-live);
  flex: 0 0 auto;
}
.content-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}
.content-name {
  font-size: 12.5px;
  color: var(--fg2);
  font-weight: 500;
}
.content-kind {
  font-size: 10.5px;
  color: var(--muted2);
}
.content-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
  border: 1.5px dashed var(--line2);
  border-radius: 9px;
  font-size: 12px;
  color: var(--muted);
}

.url-field {
  display: flex;
  gap: 7px;
  margin-top: 10px;
}
.url-input {
  flex: 1;
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 11px;
  font-size: 12.5px;
  color: var(--fg);
  outline: none;
  font-family: inherit;
}
.url-input:focus {
  border-color: var(--accent);
}
.url-btn {
  padding: 9px 14px;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.url-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.url-btn:not(:disabled):hover {
  opacity: 0.92;
}

.hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.55;
}

.layout-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  font-size: 11.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.layout-cell {
  background: var(--muted-bg);
  border-radius: 7px;
  padding: 7px 9px;
}

.unplace-btn {
  margin-top: 18px;
  width: 100%;
  padding: 9px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.unplace-btn:hover {
  background: var(--bad-soft);
  color: var(--bad);
  border-color: var(--scr-bad-line);
}

.multi-count {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 14px;
}
.member-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.member {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 9px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}
.member:hover {
  background: var(--muted-bg);
}
.member-name {
  font-size: 12.5px;
  color: var(--fg2);
  font-weight: 500;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 34px 12px;
  border: 1.5px dashed var(--line2);
  border-radius: 11px;
  text-align: center;
}
.empty-glyph {
  font-size: 20px;
  color: var(--muted2);
}
.empty-title {
  font-size: 12.5px;
  color: var(--muted);
  font-weight: 500;
}
.empty-sub {
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.5;
}
</style>
