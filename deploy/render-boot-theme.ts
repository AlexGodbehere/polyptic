#!/usr/bin/env bun
/**
 * Print the GRUB boot theme (POL-47) to stdout — BYTE-IDENTICAL to what the control plane serves at
 * `GET /boot/theme.txt` (both call `buildBootThemeTxt()`).
 *
 *     bun deploy/render-boot-theme.ts > theme.txt
 *
 * WHY. `build-boot-medium.sh` bakes this theme onto the boot medium so the OFFLINE/Wi-Fi menu paints
 * the branded splash with no server to fetch it from (POL-74/D69) — GRUB/UEFI cannot join WPA, so the
 * offline path has no control plane to `curl`. POL-74 baked it with a best-effort BUILD-TIME curl,
 * which silently shipped a plain (theme-less) medium whenever the server wasn't reachable yet at build
 * time (exactly what happened on early homelab media). This script bakes it DETERMINISTICALLY instead,
 * from the same source the server serves, so every medium carries the splash regardless of build-time
 * network (POL-80/D75).
 *
 * `packages/server/src/boot-theme.ts` imports nothing, so this needs no `@polyptic/protocol` build and
 * NO network — it runs the same in the rebuild Job's server image (`/repo` + `bun`) and on a macOS
 * laptop building a local dongle. The output being byte-identical to the served theme is pinned by
 * `packages/e2e/boot-splash.test.ts`, so the offline and wired splashes can never drift.
 */
import { buildBootThemeTxt } from "../packages/server/src/boot-theme.ts";

process.stdout.write(buildBootThemeTxt());
