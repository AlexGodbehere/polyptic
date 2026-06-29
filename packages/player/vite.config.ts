import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The player is the headless page shown fullscreen on each wall screen.
// Dev server is pinned to 5173 (the SERVER advertises PLAYER_BASE_URL=http://localhost:5173).
export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
