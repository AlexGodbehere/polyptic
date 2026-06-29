import { createApp } from "vue";
import { createPinia } from "pinia";

import App from "./App.vue";
import { router } from "./router";

// Vue Flow base + default theme styles (the wall canvas, owned by console-wall, builds on these),
// then our design tokens last so they win where they overlap.
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "./styles.css";

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");
