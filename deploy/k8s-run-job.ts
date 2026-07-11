/**
 * deploy/k8s-run-job.ts — the IMAGE_REBUILD_CMD / IMAGE_FULL_REBUILD_CMD hook for Kubernetes
 * (POL-43). The POL-41 contract says the rebuild hook is a COMMAND the server shells out to; in a
 * cluster that command is this script: create a privileged rebuild Job from a chart-rendered
 * template, wait for it, and relay its logs + exit status back to the server's Settings card.
 *
 *   IMAGE_REBUILD_CMD="bun deploy/k8s-run-job.ts refresh"
 *   IMAGE_FULL_REBUILD_CMD="bun deploy/k8s-run-job.ts full"
 *
 * The Helm chart renders the Job manifests into a ConfigMap mounted at POLYPTIC_JOB_TEMPLATE_DIR
 * (default /etc/polyptic/jobs), ONE PER ARCH the cluster builds (POL-75): `refresh-<arch>.json`
 * (nightly in-place apt refresh, kernel held) and `full-<arch>.json` (weekly rebuild from
 * ubuntu-base — the kernel-CVE cycle). Both run privileged (chroot + loop mounts) with the
 * image-depot PVC mounted, and carry ttlSecondsAfterFinished so Kubernetes GCs finished Jobs.
 *
 *   IMAGE_REBUILD_CMD="bun deploy/k8s-run-job.ts refresh"        # every configured arch
 *   IMAGE_FULL_REBUILD_CMD="bun deploy/k8s-run-job.ts full"      # every configured arch
 *   bun deploy/k8s-run-job.ts full amd64                          # one arch (optional 2nd arg)
 *
 * With no arch argument it fans out over EVERY `<kind>-*.json` the chart rendered, SEQUENTIALLY —
 * emulated foreign-arch builds are heavy and share one RWO depot PVC, so serialising is deliberate,
 * not incidental. Any single arch failing fails the whole run (non-zero exit), but the others still
 * get their turn so a good arch is not held hostage to a broken one.
 *
 * Talks to the API server directly with the pod's ServiceAccount (token + CA from the usual
 * projected volume) via Bun's fetch — no kubectl in the image. RBAC needed: create/get jobs,
 * list pods, get pods/log (see the chart's role.yaml).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const TEMPLATE_DIR = process.env.POLYPTIC_JOB_TEMPLATE_DIR?.trim() || "/etc/polyptic/jobs";
/** Per-arch wait, bounded below the server's hook killer so THIS process reports a timeout.
 *  Configurable because an EMULATED foreign-arch build can run far past a native one's 40 min. */
const WAIT_TIMEOUT_MS = Number(process.env.POLYPTIC_JOB_WAIT_TIMEOUT_MS) || 40 * 60 * 1000;
const POLL_MS = 10 * 1000;
const LOG_TAIL_LINES = 120;

const kind = process.argv[2];
const wantArch = process.argv[3]?.trim();
if (kind !== "refresh" && kind !== "full") {
  console.error("usage: bun deploy/k8s-run-job.ts <refresh|full> [arch]");
  process.exit(2);
}

/** The per-arch template files this run drives: the named arch, else every `<kind>-*.json` the chart
 *  rendered. Falls back to a legacy single `<kind>.json` so an older ConfigMap still works. */
function templateFiles(): string[] {
  if (wantArch) return [`${kind}-${wantArch}.json`];
  const perArch = readdirSync(TEMPLATE_DIR)
    .filter((f) => f.startsWith(`${kind}-`) && f.endsWith(".json"))
    .sort();
  return perArch.length > 0 ? perArch : [`${kind}.json`];
}

const token = readFileSync(join(SA_DIR, "token"), "utf8").trim();
const ca = readFileSync(join(SA_DIR, "ca.crt"), "utf8");
const namespace = readFileSync(join(SA_DIR, "namespace"), "utf8").trim();
const apiBase = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT ?? "443"}`;

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    // Bun extension: pin the cluster CA instead of the system trust store.
    tls: { ca },
  } as RequestInit);
}

/** Create one Job from `templateFile`, wait for it, relay its pod log tail. Returns true on success.
 *  A missing template (an arch not built here) is a hard failure — the caller asked for it. */
async function runOne(templateFile: string): Promise<boolean> {
  const template = JSON.parse(readFileSync(join(TEMPLATE_DIR, templateFile), "utf8")) as {
    metadata: { name?: string; generateName?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  // Unique per run; generateName keeps concurrent-history names readable (polyptic-image-refresh-xxxxx).
  delete template.metadata.name;
  template.metadata.generateName = `polyptic-image-${kind}-`;

  const created = await api("POST", `/apis/batch/v1/namespaces/${namespace}/jobs`, template);
  if (!created.ok) {
    console.error(`failed to create ${templateFile} job: HTTP ${created.status} ${await created.text()}`);
    return false;
  }
  const jobName = ((await created.json()) as { metadata: { name: string } }).metadata.name;
  console.log(`created job ${namespace}/${jobName} (${templateFile})`);

  let succeeded = false;
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const res = await api("GET", `/apis/batch/v1/namespaces/${namespace}/jobs/${jobName}`);
    if (!res.ok) {
      console.error(`job status poll failed: HTTP ${res.status}`);
      continue; // transient API blips must not fail a long build
    }
    const status = ((await res.json()) as { status?: { succeeded?: number; failed?: number } }).status ?? {};
    if ((status.succeeded ?? 0) > 0) {
      succeeded = true;
      break;
    }
    // Templates set backoffLimit: 0 — one failed pod IS the verdict.
    if ((status.failed ?? 0) > 0) break;
    if (Date.now() > deadline) {
      console.error(`job ${jobName} still running after ${WAIT_TIMEOUT_MS / 60000} minutes — giving up (job left for inspection)`);
      break;
    }
  }

  // Relay the pod log tail so apt's verdict / the failure lands in the Settings card.
  try {
    const pods = await api(
      "GET",
      `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`,
    );
    const items = ((await pods.json()) as { items: { metadata: { name: string } }[] }).items ?? [];
    for (const pod of items) {
      const log = await api(
        "GET",
        `/api/v1/namespaces/${namespace}/pods/${pod.metadata.name}/log?tailLines=${LOG_TAIL_LINES}`,
      );
      if (log.ok) {
        console.log(`--- ${pod.metadata.name} (last ${LOG_TAIL_LINES} lines) ---`);
        console.log(await log.text());
      }
    }
  } catch (err) {
    console.error(`log relay failed (job outcome unaffected): ${(err as Error).message}`);
  }

  console.log(`job ${jobName}: ${succeeded ? "SUCCEEDED" : "FAILED"}`);
  return succeeded;
}

const files = templateFiles();
console.log(`${kind}: building ${files.length} arch(es) sequentially — ${files.join(", ")}`);
let allOk = true;
for (const f of files) {
  // eslint-disable-next-line no-await-in-loop -- deliberate: emulated builds share one RWO PVC.
  const ok = await runOne(f);
  allOk = allOk && ok;
}
process.exit(allOk ? 0 : 1);
