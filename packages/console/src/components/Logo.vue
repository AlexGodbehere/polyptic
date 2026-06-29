<script setup lang="ts">
import { computed } from "vue";

// The Polyptic mark: two hinged side panels + a squared-off centre panel, on a rounded holder.
// Theme-inverting — holder uses --primary, the panels use --primary-fg.
const props = defineProps<{ size?: number; rounded?: number }>();
const s = computed(() => props.size ?? 34);
const rad = computed(() => props.rounded ?? Math.round(s.value * 0.27));
const m = computed(() => Math.round(s.value * 0.76));
</script>

<template>
  <span class="pp-mark" :style="{ width: s + 'px', height: s + 'px', borderRadius: rad + 'px' }">
    <svg :width="m" :height="m" viewBox="0 0 32 32" aria-hidden="true">
      <polygon points="6.6,11 12.3,8.2 12.3,23.8 6.6,21" fill="var(--primary-fg)" opacity=".62" />
      <polygon points="25.4,11 19.7,8.2 19.7,23.8 25.4,21" fill="var(--primary-fg)" opacity=".62" />
      <rect x="13.1" y="8" width="5.8" height="16" fill="var(--primary-fg)" />
    </svg>
  </span>
</template>

<style scoped>
.pp-mark {
  background: var(--primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
</style>
