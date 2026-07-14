<script setup lang="ts">
import { onMounted } from "vue";
import NavRail from "./NavRail.vue";
import TakeoverBar from "./TakeoverBar.vue";
import TakeoverModal from "./TakeoverModal.vue";
import { useConsoleStore } from "../stores/console";

// The shell is mounted for the whole authenticated session, so it owns the admin-channel lifecycle.
// `connect()` is idempotent and self-heals via backoff, so a single call here is enough.
const store = useConsoleStore();
onMounted(() => store.connect());
</script>

<template>
  <div class="app-shell">
    <NavRail />
    <main class="app-main">
      <!-- POL-90 — a live takeover is fleet state: every console shows it, on every page, counting
           down, with an End button. The composer lives here too, opened from anywhere via the store. -->
      <TakeoverBar />
      <router-view />
    </main>
    <TakeoverModal />
  </div>
</template>

<style scoped>
.app-shell {
  height: 100vh;
  min-height: 640px;
  display: flex;
  background: var(--bg);
  overflow: hidden;
}
.app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
</style>
