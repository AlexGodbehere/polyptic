<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useConsoleStore } from "../stores/console";
import { signIn } from "../auth";
import Logo from "../components/Logo.vue";

// Stub sign-in (D29's real local accounts come later). Any non-empty credentials enter the app.
const store = useConsoleStore();
const router = useRouter();
const route = useRoute();

const email = ref("operator@accent.co");
const password = ref("polyptic");
const error = ref(false);
const loading = ref(false);

const themeIcon = computed(() => (store.theme === "light" ? "☾ Dark" : "☼ Light"));

function onSignIn(): void {
  if (loading.value) return;
  if (!email.value.trim() || !password.value.trim()) {
    error.value = true;
    return;
  }
  loading.value = true;
  error.value = false;
  // A brief, deliberate beat so the spinner reads as "doing something" — matches the prototype.
  window.setTimeout(() => {
    signIn();
    loading.value = false;
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/wall";
    void router.replace(redirect);
  }, 600);
}
</script>

<template>
  <div class="signin">
    <div class="card sheet">
      <div class="brand">
        <Logo :size="40" :rounded="11" />
        <span class="brand-name">Polyptic</span>
      </div>

      <div class="heading">Sign in to the console</div>
      <div class="sub">Operator access to your display fleet.</div>

      <label class="field-label">Email</label>
      <input
        v-model="email"
        class="input field"
        type="email"
        autocomplete="username"
        @keyup.enter="onSignIn"
      />

      <label class="field-label">Password</label>
      <input
        v-model="password"
        class="input field"
        type="password"
        autocomplete="current-password"
        @keyup.enter="onSignIn"
      />

      <div v-if="error" class="error">⚠ Enter an email and password to continue.</div>

      <button class="btn btn-primary submit" :disabled="loading" @click="onSignIn">
        <span v-if="loading" class="spinner"></span>
        {{ loading ? "Signing in…" : "Sign in" }}
      </button>

      <div class="foot">
        <span class="version">Self-hosted · v3.0</span>
        <span class="theme" @click="store.toggleTheme()">{{ themeIcon }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.signin {
  height: 100vh;
  min-height: 640px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
}
.sheet {
  width: 380px;
  padding: 30px 28px;
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
  animation: fadein 0.3s ease;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 22px;
}
.brand-mark {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--primary-fg);
  font-size: 16px;
  font-weight: 700;
}
.brand-name {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.heading {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
}
.sub {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 22px;
}
.field-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--fg2);
  margin-bottom: 6px;
}
.field {
  margin-bottom: 14px;
}
.error {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--bad);
  background: var(--bad-soft);
  border-radius: 8px;
  padding: 9px 11px;
  margin-bottom: 14px;
}
.submit {
  width: 100%;
  padding: 11px;
  font-size: 13.5px;
  margin-bottom: 8px;
}
.submit:disabled {
  cursor: default;
}
.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 14px;
}
.version {
  font-size: 11.5px;
  color: var(--muted2);
}
.theme {
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
}
</style>
