<!--
  TakeoverModal.vue — the takeover composer (POL-90).

  "Put THIS on THAT, right now, for 30 minutes." Three questions, in that order: what to show (a
  library source, or an ad-hoc link — both ride the same ContentAssignment path the canvas uses, so
  credential stamping and the reachability prober apply for free), what it covers, and for how long.

  Duration is a row of presets because the failure mode this feature exists to kill is "somebody
  forgot to put it back" — so the DEFAULT is a bounded 30 minutes, and "Until I end it" is a
  deliberate, named choice rather than the path of least resistance.

  The dialog lives once, in the app shell; the Wall top bar and the Inspector's Cast action both open
  it through the store, pre-scoped to whatever the operator had selected.
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { OverrideScope } from "@polyptic/protocol";

import { useConsoleStore } from "../stores/console";
import { kindLabel } from "../content";

const store = useConsoleStore();

/** The presets. `null` = no TTL: it runs until an operator ends it (and says so, plainly). */
const DURATIONS: { label: string; ttlSeconds: number | null }[] = [
  { label: "5 min", ttlSeconds: 300 },
  { label: "15 min", ttlSeconds: 900 },
  { label: "30 min", ttlSeconds: 1800 },
  { label: "1 hour", ttlSeconds: 3600 },
  { label: "Until I end it", ttlSeconds: null },
];

const open = computed(() => store.takeoverDialog !== null);
const scope = ref<OverrideScope>("fleet");
const targetId = ref<string | undefined>(undefined);
const sourceId = ref<string>("");
const url = ref<string>("");
const ttlSeconds = ref<number | null>(1800);
const busy = ref(false);
const error = ref<string | null>(null);

// Re-seed the form each time the dialog is opened against a target.
watch(
  () => store.takeoverDialog,
  (dialog) => {
    if (!dialog) return;
    scope.value = dialog.scope;
    targetId.value = dialog.targetId;
    sourceId.value = "";
    url.value = "";
    ttlSeconds.value = 1800;
    error.value = null;
    busy.value = false;
  },
  { immediate: true },
);

const sources = computed(() => store.sources);

/** The scopes an operator can pick right now — a mural/wall/screen scope needs a target to exist. */
const scopeOptions = computed(() => {
  const opts: { scope: OverrideScope; targetId?: string; label: string; hint: string }[] = [
    { scope: "fleet", label: "Whole fleet", hint: "every screen, everywhere" },
  ];
  const dialog = store.takeoverDialog;
  if (dialog?.scope === "screen" && dialog.targetId) {
    const screen = store.screenById(dialog.targetId);
    if (screen) {
      opts.push({
        scope: "screen",
        targetId: dialog.targetId,
        label: screen.friendlyName,
        hint: "this screen only",
      });
    }
  }
  if (dialog?.scope === "wall" && dialog.targetId) {
    opts.push({
      scope: "wall",
      targetId: dialog.targetId,
      label: store.wallName(dialog.targetId),
      hint: "spans this combined surface",
    });
  }
  for (const mural of store.murals) {
    opts.push({ scope: "mural", targetId: mural.id, label: mural.name, hint: "every screen on this mural" });
  }
  return opts;
});

/** Which option is selected (scope + target together identify one). */
const selectedKey = computed(() => `${scope.value}:${targetId.value ?? ""}`);

function pickScope(opt: { scope: OverrideScope; targetId?: string }): void {
  scope.value = opt.scope;
  targetId.value = opt.targetId;
}

const canStart = computed(() => sourceId.value !== "" || url.value.trim() !== "");

async function start(): Promise<void> {
  if (!canStart.value || busy.value) return;
  busy.value = true;
  error.value = null;
  const failure = await store.startTakeover({
    scope: scope.value,
    ...(targetId.value ? { targetId: targetId.value } : {}),
    ...(sourceId.value ? { sourceId: sourceId.value } : { url: url.value.trim() }),
    ...(ttlSeconds.value !== null ? { ttlSeconds: ttlSeconds.value } : {}),
  });
  busy.value = false;
  if (failure) {
    error.value = failure;
    return;
  }
  store.closeTakeoverDialog();
}
</script>

<template>
  <div v-if="open" class="scrim" @click.self="store.closeTakeoverDialog()">
    <div class="modal" role="dialog" aria-label="Start a takeover">
      <header class="head">
        <h2>Takeover</h2>
        <p class="sub">
          Put content on the wall right now, over whatever it is showing. Nothing underneath is
          changed — when this ends, the wall goes straight back to it.
        </p>
      </header>

      <section class="field">
        <label class="label">Show</label>
        <select v-model="sourceId" class="input">
          <option value="">Content library…</option>
          <option v-for="s in sources" :key="s.id" :value="s.id">
            {{ kindLabel(s.kind) }} · {{ s.name }}
          </option>
        </select>
        <div class="or">or</div>
        <input
          v-model="url"
          class="input"
          type="url"
          placeholder="https://… (an ad-hoc link)"
          :disabled="sourceId !== ''"
        />
      </section>

      <section class="field">
        <label class="label">On</label>
        <div class="scopes">
          <button
            v-for="opt in scopeOptions"
            :key="`${opt.scope}:${opt.targetId ?? ''}`"
            class="scope"
            :class="{ on: selectedKey === `${opt.scope}:${opt.targetId ?? ''}` }"
            @click="pickScope(opt)"
          >
            <span class="scope-label">{{ opt.label }}</span>
            <span class="scope-hint">{{ opt.hint }}</span>
          </button>
        </div>
      </section>

      <section class="field">
        <label class="label">For</label>
        <div class="durations">
          <button
            v-for="d in DURATIONS"
            :key="d.label"
            class="duration"
            :class="{ on: ttlSeconds === d.ttlSeconds }"
            @click="ttlSeconds = d.ttlSeconds"
          >
            {{ d.label }}
          </button>
        </div>
        <p v-if="ttlSeconds === null" class="warn-note">
          This one will not revert on its own — somebody has to end it.
        </p>
      </section>

      <p v-if="error" class="error">{{ error }}</p>

      <footer class="actions">
        <button class="ghost" @click="store.closeTakeoverDialog()">Cancel</button>
        <button class="primary" :disabled="!canStart || busy" @click="start">
          {{ busy ? "Starting…" : "Start takeover" }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(9, 9, 11, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.modal {
  width: 100%;
  max-width: 460px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow-lg, 0 24px 48px rgba(16, 24, 40, 0.18));
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 90vh;
  overflow-y: auto;
}
.head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  color: var(--fg);
}
.sub {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
  color: var(--fg);
  padding: 8px 10px;
  font-size: 13px;
}
.input:disabled {
  opacity: 0.5;
}
.or {
  font-size: 11px;
  color: var(--muted);
  text-align: center;
}
.scopes,
.durations {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.scope {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
  color: var(--fg);
  padding: 6px 10px;
  cursor: pointer;
  text-align: left;
}
.scope.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.scope-label {
  font-size: 13px;
  font-weight: 550;
}
.scope-hint {
  font-size: 11px;
  color: var(--muted);
}
.duration {
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--card);
  color: var(--fg);
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
}
.duration.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-fg);
  font-weight: 600;
}
.warn-note {
  margin: 0;
  font-size: 11px;
  color: var(--warn);
}
.error {
  margin: 0;
  font-size: 12px;
  color: var(--bad);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.ghost {
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--fg);
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
}
.primary {
  border: 1px solid var(--primary);
  background: var(--primary);
  color: var(--primary-fg);
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
