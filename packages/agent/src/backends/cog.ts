/**
 * cog — WPE/WebKit kiosk-browser launcher (D27 fallback).
 *
 * On Ubuntu/arm64 there is no real `.deb` Chromium (only the confined snap, which a kiosk must
 * avoid), so cog — the WPE WebKit single-page "kiosk" browser — is the browser there. cog
 * auto-detects the Wayland platform when `WAYLAND_DISPLAY` is set and runs fullscreen; `cog <url>`
 * shows one page per process, one process per output — which is all the per-output isolation we
 * need (cog has no Chromium-style `--user-data-dir`; isolation comes from separate processes/pids).
 *
 * The shape deliberately mirrors chromium.ts so the two are interchangeable behind the `Browser`
 * abstraction (backends/browser.ts), but it stays minimal + robust: cog takes the URL as a
 * POSITIONAL arg (NOT `--app=`) and none of Chromium's flags apply. This file can't be exercised on
 * the dev host, so it does as little as possible.
 */
import type { ChromiumLaunchSpec } from "./chromium";
import { which } from "./proc";

/** Candidate cog binary names, most-preferred first; `POLYPTIC_COG` overrides. */
export const COG_CANDIDATES = ["cog"] as const;

/**
 * Resolve the cog binary (or throw a clear error). `POLYPTIC_COG` (or the generic
 * `POLYPTIC_BROWSER_BIN`) overrides; else the first candidate on PATH.
 */
export async function resolveCog(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const override = env.POLYPTIC_COG?.trim() || env.POLYPTIC_BROWSER_BIN?.trim();
  const candidates = override ? [override] : [...COG_CANDIDATES];
  for (const c of candidates) {
    if (await which(c)) return c;
  }
  throw new Error(
    "cog (WPE WebKit) not found — install it or set POLYPTIC_COG; on Ubuntu/arm64 cog is the " +
      "kiosk browser since Chromium is snap-only (D27).",
  );
}

/**
 * Build cog's argv for a given output. cog auto-detects the Wayland platform from
 * `WAYLAND_DISPLAY`, so this is minimal: any `spec.extra`, then `POLYPTIC_BROWSER_ARGS`
 * (space-split, if set), then the URL **last** (cog takes the URL as a positional arg, NOT
 * `--app=`). No Chromium-only flags, and no `--user-data-dir` (cog has none).
 *
 * `cog <url>` runs fullscreen under sway; the sway backend fullscreens + places it via swaymsg.
 */
export function buildCogArgs(
  spec: ChromiumLaunchSpec,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args: string[] = [];
  if (spec.extra && spec.extra.length > 0) args.push(...spec.extra);
  const extra = env.POLYPTIC_BROWSER_ARGS?.trim();
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));
  args.push(spec.url); // URL is the positional arg, and must come last
  return args;
}
