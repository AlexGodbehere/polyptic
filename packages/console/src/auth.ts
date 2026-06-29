/**
 * Stub operator session (Phase 3a). Real local accounts (Argon2id + secure session cookies, D29)
 * land in a later sub-phase; for now the sign-in screen just flips this localStorage flag so the
 * router guard lets the operator into the console.
 */
const KEY = "polyptic.signedIn";

export function isSignedIn(): boolean {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

export function signIn(): void {
  try {
    localStorage.setItem(KEY, "true");
  } catch {
    /* storage unavailable — sign-in is a no-op stub anyway */
  }
}

export function signOut(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
