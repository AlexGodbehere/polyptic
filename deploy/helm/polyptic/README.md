# Polyptic — Helm chart (control plane / server)

Deploys the **Polyptic server** (the control plane: Fastify REST + three WebSocket
channels on `:8080`) to Kubernetes. This mirrors `deploy/docker-compose.yml`,
`deploy/server.Dockerfile`, and `deploy/.env.example`.

> **Scope.** This chart deploys ONLY the server. The on-device **agent is installed
> per box** from the `.deb`/`.rpm` package (`deploy/nfpm.yaml`) — it is never run in
> Kubernetes. Agents connect *out* to the server over a WebSocket; expose the server
> (Ingress / LoadBalancer) so the fleet can reach it.

## TL;DR

```sh
# 1. Pull the Postgres subchart dependency (once, or after bumping Chart.yaml deps).
helm dependency update deploy/helm/polyptic

# 2. Install with the in-cluster Postgres subchart (default).
helm install polyptic deploy/helm/polyptic \
  --namespace polyptic --create-namespace \
  --set image.repository=ghcr.io/polyptic/polyptic-server \
  --set image.tag=0.1.0
```

The server image is built from `deploy/server.Dockerfile`:

```sh
docker build -f deploy/server.Dockerfile -t ghcr.io/polyptic/polyptic-server:0.1.0 .
docker push ghcr.io/polyptic/polyptic-server:0.1.0
```

## Production install (HTTPS + Ingress + external Postgres)

```sh
helm install polyptic deploy/helm/polyptic \
  --namespace polyptic --create-namespace \
  --set image.repository=ghcr.io/polyptic/polyptic-server \
  --set image.tag=0.1.0 \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.host=polyptic.example.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=polyptic-tls \
  --set config.corsOrigin=https://polyptic.example.com \
  --set config.playerBaseUrl=https://polyptic.example.com \
  --set config.secureCookies=true \
  --set postgresql.enabled=false \
  --set externalDatabase.url='postgres://user:pass@pg.example:5432/polyptic' \
  --set secrets.cookieSecret="$(openssl rand -hex 32)" \
  --set secrets.bootstrapToken="$(openssl rand -hex 24)" \
  --set secrets.adminEmail=ops@example.com \
  --set secrets.adminPassword="$(openssl rand -base64 18)"
```

## Production note (D29 / Phase 3f) — HTTPS + `SECURE_COOKIES=true`

The operator auth gate (Phase 3f) signs an **http-only session cookie**. In any real
deployment you **MUST**:

1. Serve the console over **HTTPS** (Ingress TLS or an upstream terminator), and
2. Set **`config.secureCookies=true`** (renders `SECURE_COOKIES=true`).

A `secure` cookie is only sent back over HTTPS, so an HTTP origin would silently drop
the session and operators could never stay logged in. The chart defaults
`config.secureCookies: true` and `config.nodeEnv: production` for this reason — only
flip them off for a throwaway HTTP/dev cluster. Likewise set a strong
`secrets.cookieSecret`; if you leave it empty the chart generates one and preserves it
across upgrades, but a managed value is required for reproducible/GitOps installs.

`config.authEnabled` defaults to `true`. **Never** set it false on a reachable
deployment — that leaves every `/api/v1` route and the `/admin` WS unprotected (it
exists only so the e2e suite can run with `AUTH_ENABLED=false`).

## Health, metrics, and the auth gate

`/healthz` and `/metrics` are **top-level (NOT `/api/v1`)** so they are UNgated for
liveness probes and Prometheus scrapers, even with the auth gate on:

- **Readiness + liveness** probes both hit `/healthz` (see `values.yaml` →
  `readinessProbe` / `livenessProbe`).
- **Prometheus** scrape annotations for `/metrics` are added to the pod template when
  `metrics.enabled=true` (`prometheus.io/scrape|path|port`).

## Database options

| Goal | Settings |
| --- | --- |
| In-cluster Postgres (default) | `postgresql.enabled=true` — `DATABASE_URL` is derived from the subchart automatically. |
| External / managed Postgres | `postgresql.enabled=false` + `externalDatabase.url=postgres://…` |
| Pre-made Secret (GitOps) | `secrets.existingSecret=my-secret` with keys `COOKIE_SECRET`, `POLYPTIC_BOOTSTRAP_TOKEN`, `POLYPTIC_ADMIN_EMAIL`, `POLYPTIC_ADMIN_PASSWORD`, `DATABASE_URL`. |
| Ephemeral (dev only) | `config.store=memory`, `postgresql.enabled=false` — registry lost on restart. |

## Key values

| Key | Default | Notes |
| --- | --- | --- |
| `image.repository` / `image.tag` | `ghcr.io/polyptic/polyptic-server` / `""` (→ appVersion) | Server image. |
| `replicaCount` | `1` | Single-writer control plane; keep at 1. |
| `service.type` / `service.port` | `ClusterIP` / `8080` | Container always listens on `containerPort` (8080). |
| `ingress.enabled` / `.host` / `.tls.enabled` / `.tls.secretName` | `false` / `polyptic.example.com` / `false` / `polyptic-tls` | HTTPS in prod. |
| `config.store` | `postgres` | `postgres` or `memory`. |
| `config.corsOrigin` | `https://polyptic.example.com` | Comma-separated browser origins (cookies are cross-origin). |
| `config.authEnabled` | `true` | The Phase 3f gate. Keep true. |
| `config.secureCookies` | `true` | HTTPS-only cookies — see production note. |
| `config.captureIntervalMs` | `""` | Live-preview capture cadence (server default when empty). |
| `secrets.cookieSecret` | `""` (generated) | Session signing key. |
| `secrets.bootstrapToken` | `""` (OPEN) | Set for gated agent enrollment. |
| `secrets.adminEmail` / `secrets.adminPassword` | `""` | Seed operator on first boot. |
| `metrics.enabled` | `true` | Prometheus scrape annotations for `/metrics`. |
| `postgresql.enabled` | `true` | Bitnami Postgres subchart toggle. |
| `externalDatabase.url` | `""` | Used when `postgresql.enabled=false`. |

## Render / lint locally

```sh
helm dependency update deploy/helm/polyptic
helm lint deploy/helm/polyptic
helm template polyptic deploy/helm/polyptic --namespace polyptic
```

## Uninstall

```sh
helm uninstall polyptic --namespace polyptic
```

The chart-managed Secret carries `helm.sh/resource-policy: keep` so a generated
`COOKIE_SECRET` survives a reinstall — delete it manually if you want a clean slate.
