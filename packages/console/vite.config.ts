import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The operator console (Phase 3). Dev server is pinned to 5175 so it never collides with the
// player (5173), the old SolidJS admin (5174) or the control plane (8080).
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5175,
    strictPort: true,
  },
});
