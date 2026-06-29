<script setup lang="ts">
import { useRouter } from "vue-router";
import { useConsoleStore } from "../stores/console";
import { signOut } from "../auth";

// A light-touch Settings stub: the Appearance theme switch and Sign out are wired (they lean on
// core 3a plumbing — toggleTheme + the auth stub); the richer panels arrive in a later sub-phase.
const store = useConsoleStore();
const router = useRouter();

function setTheme(theme: "light" | "dark"): void {
  if (store.theme !== theme) store.toggleTheme();
}

function onSignOut(): void {
  signOut();
  void router.replace({ name: "signin" });
}
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <h1 class="page-title">Settings</h1>

      <div class="card panel">
        <div class="panel-title">Appearance</div>
        <div class="panel-sub">Theme for the console.</div>
        <div class="pill-group">
          <div class="pill" :class="{ active: store.theme === 'light' }" @click="setTheme('light')">
            ☼ Light
          </div>
          <div class="pill" :class="{ active: store.theme === 'dark' }" @click="setTheme('dark')">
            ☾ Dark
          </div>
        </div>
      </div>

      <div class="card panel">
        <div class="panel-title">Enrolment token</div>
        <div class="panel-sub">Managing the shared secret new machines present arrives with the Machines view.</div>
        <span class="cs-badge">Coming soon</span>
      </div>

      <div class="card panel">
        <div class="panel-title">Account</div>
        <div class="account">
          <div class="avatar">OP</div>
          <div class="who">
            <div class="who-name">Operator</div>
            <div class="who-email">operator@accent.co</div>
          </div>
          <button class="btn btn-ghost" @click="onSignOut">Sign out</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.page-inner {
  max-width: 680px;
  margin: 0 auto;
  padding: 30px 32px 60px;
}
.page-title {
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 24px;
}
.panel {
  padding: 18px 20px;
  margin-bottom: 16px;
}
.panel-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 3px;
}
.panel-sub {
  font-size: 12.5px;
  color: var(--muted);
  margin-bottom: 14px;
}
.cs-badge {
  display: inline-block;
  background: var(--accent-soft);
  color: var(--accent-fg);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 4px 10px;
  border-radius: 20px;
}
.account {
  display: flex;
  align-items: center;
  gap: 12px;
}
.avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--muted-bg);
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.who {
  flex: 1;
}
.who-name {
  font-size: 13.5px;
  font-weight: 600;
}
.who-email {
  font-size: 12px;
  color: var(--muted);
}
</style>
