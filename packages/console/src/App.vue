<script setup lang="ts">
import { watchEffect } from "vue";
import { useConsoleStore } from "./stores/console";

// Reflect the chosen theme onto <html> so the design tokens (and any teleported overlays) cascade
// across the whole document, sign-in screen included.
const store = useConsoleStore();
watchEffect(() => {
  document.documentElement.setAttribute("data-theme", store.theme);
});
</script>

<template>
  <router-view />
</template>
