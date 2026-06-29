import { createRouter, createWebHistory } from "vue-router";
import type { RouteLocationNormalized, RouteRecordRaw } from "vue-router";

import AppShell from "./components/AppShell.vue";
import { isSignedIn } from "./auth";

// The Wall view is owned by console-wall; it is lazy-imported so the shell + stub routes build and
// run independently of it.
const routes: RouteRecordRaw[] = [
  {
    path: "/signin",
    name: "signin",
    component: () => import("./views/SignIn.vue"),
    meta: { public: true },
  },
  {
    path: "/",
    component: AppShell,
    children: [
      { path: "", redirect: { name: "wall" } },
      { path: "wall", name: "wall", component: () => import("./views/Wall.vue") },
      { path: "machines", name: "machines", component: () => import("./views/Machines.vue") },
      { path: "content", name: "content", component: () => import("./views/Content.vue") },
      { path: "scenes", name: "scenes", component: () => import("./views/Scenes.vue") },
      { path: "settings", name: "settings", component: () => import("./views/Settings.vue") },
    ],
  },
  { path: "/:pathMatch(.*)*", redirect: { name: "wall" } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to: RouteLocationNormalized) => {
  if (to.meta.public) return true;
  if (!isSignedIn()) {
    return {
      name: "signin",
      query: to.fullPath !== "/" ? { redirect: to.fullPath } : undefined,
    };
  }
  return true;
});
