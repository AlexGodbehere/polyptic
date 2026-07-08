# Commercialisation — exploration (POL-40)

**Status: exploration, not a decision.** Nothing here is locked. When a call is actually made
(licence, pricing, hosted offering), promote it to `docs/DECISIONS.md` as a numbered entry.
This lives under `docs/business/` deliberately — the Pages workflow publishes only top-level
`docs/*.md`, so this file stays out of the public docs site.

Market figures below were gathered 2026-07-08 from vendor pricing pages (sources at the end).
Prices are per screen per month unless stated; vendors quote USD unless marked.

---

## 1. The question

POL-40's prompt: *self-hosted vs cloud (our infra)? Price per screen? Tiers: Free up to 2
screens, £20/mo for 5, £40 for 15, £100 for 100, then per-usage on top?*

Three sub-questions, in dependency order:

1. **Licence** — Polyptic is public on GitHub under MIT, sole copyright holder. This is the
   decision with a closing window; everything else can wait.
2. **Business model shape** — what is free, what is paid, and on which axis (hosting,
   screens, features, support)?
3. **Price points** — only meaningful once 1 and 2 are settled; the seed tiers are assessed
   against real market data in §6.

## 2. Where Polyptic sits in the market

The commercial digital-signage CMS market in mid-2026 clusters into three bands:

| Band | Vendors | Per-screen/mo | Notes |
|---|---|---|---|
| Budget self-serve | Yodeck $8–16, Kitcast $7–10, OptiSigns $9–13.50, TelemetryTV $8–16, Play $8–16 | **$7–16** | BYO hardware, self-serve onboarding |
| Mid-market | NoviSign $18–44, ScreenCloud $20–30, Fugo $20–40, Screenly $17–27 | **$17–44** | integrations, dashboards, proof-of-play |
| Enterprise | OptiSigns $45 (min 25 screens), TelemetryTV 100+/500+ device blocks, Navori/Signagelive quote-only | **$40+ or quote** | SSO, on-prem options, CSM/SLA |

Operator-reported spend (Kitcast *State of Digital Signage 2026*): **56% pay $11–20/screen/mo**;
20% pay $21–50; only ~1% pay under $5. The same report: the **median signage customer runs 1
screen**, mean ≈ 4, 90th percentile ≤ 8 — revenue concentrates in the small minority of
customers with many screens.

Self-hosted / open-source comparators:

| Product | Free | Paid |
|---|---|---|
| **Xibo** (AGPLv3) | CMS + Windows player, self-hosted, unlimited | Cloud hosting **£3.50–£9/display/mo (min 10)**; proprietary Android/webOS/Tizen player licences ($28–$85 perpetual or ~$1.50–$6/mo) even on self-hosted CMS |
| **Screenly / Anthias** | Anthias (GPLv2), single-screen, local-only, zero shared code with the paid product | Screenly SaaS $17–27/screen/mo (min 2) |
| **piSignage** | MIT server, self-hosted | Hosted $20/player/yr (2 free); **one-time $25/player licence** even against the free server |
| **info-beamer** | 1 device + 1GB forever | Metered: €0.25/device/day (~€7.75/mo) + €0.02/GB/day |
| Concerto, Garlic-Hub, LibreSignage | everything | nothing — and LibreSignage is dead, the others survive on institutional goodwill |

Two observations that matter more than any single price:

- **Nobody successfully charges for the self-hosted CMS itself.** The paid axes the market
  tolerates are (a) hosting convenience, (b) per-device player licences on commercial
  hardware, (c) enterprise features + SLA support. Xibo's community accepts per-device
  licences without complaint precisely because they gate *hardware platforms*, never CMS
  features — the open product never feels crippled.
- **Every surviving open-source signage project has a paid axis, and its unit is the screen.**
  Not seats, not features-only: per screen (or per device). The unmonetised ones stagnate.

**Positioning note.** Polyptic is not really a playlist-signage product; it is wall/fleet
*orchestration* — spatial murals, combined video-wall surfaces, scenes, instant propagation,
air-gapped zero-click boot. The nearest budget-band vendors are weak exactly there (video
walls are a $25/screen/mo *add-on* at OptiSigns), and dedicated control-room video-wall
software (Userful et al.) is quote-only and expensive. That niche — walls of dashboards in
labs, factories, NOCs, offices — supports mid-band pricing and has a much higher
screens-per-customer than the signage median of 1.

## 3. Business-model patterns for self-hostable software (what the record says)

From the wider commercial-OSS record (GitLab, Grafana, Plausible, n8n, Portainer, Tailscale,
Sentry, HashiCorp — references at the end):

1. **Self-hosters essentially do not convert to paid.** Open-source/dev-tool freemium
   converts ~0.5–3%. Plausible's self-host donations total ~$300/mo while cloud funds the
   entire company. Treat self-hosters as marketing/funnel, not lost revenue.
2. **The dominant 2026 pattern for infra with a natural device unit** is *free up to N units,
   paid above* (Portainer: full product free ≤3 nodes; Tailscale: free ≤6 users) combined
   with open-core gating of *buyer-with-a-budget* features: audit logs, RBAC, HA, compliance,
   SLA support. Keeping **SSO free** is the emerging community-friendly move (Tailscale's
   explicit anti-"SSO tax" positioning) — vendors increasingly charge for SCIM/provisioning
   instead.
3. **Never relicense restrictively after building a permissive community.** HashiCorp→BSL
   spawned OpenTofu; Redis→SSPL spawned Valkey; Elastic spawned OpenSearch — and the 2024–25
   walk-backs (Elastic and Redis both returned to AGPL) didn't win the forks back. The
   licence must be chosen *before* traction.
4. **Support/services-only is not a primary model** ("the Red Hat model only worked for Red
   Hat") — fine as a secondary line inside an enterprise tier.
5. Licence menu for a single-vendor project: **MIT/Apache** (max adoption, zero moat — anyone
   may sell hosted Polyptic), **AGPL + CLA** (fully open source, network copyleft scares
   commercial free-riders, the fashionable 2024–26 default: Grafana, Plausible, Cal.com,
   MinIO), **FSL/Fair Source** (Sentry's model: source-available, non-compete, auto-converts
   to Apache/MIT after 2 years — strongest moat, some community cost), **BSL** (widely
   distrusted).

## 4. Self-hosted vs cloud: not either/or, but sequenced

Polyptic's architecture already answers this better than the market does:

- **Agents are outbound-only** (D12) — they dial the control plane over WSS. A control plane
  hosted on *our* infra works today with zero inbound holes into the customer LAN. The
  player channel is likewise outbound. A hosted offering is an ops exercise (multi-tenancy,
  a tenant column, quotas), not an architecture change.
- **Air-gap is a hard product requirement** (D35 — the control plane is the provisioning
  depot; edge boxes may reach only the server). Air-gapped and regulated customers *cannot*
  use a cloud offering. Self-hosted therefore can never be a crippled demo; it is the
  flagship deployment mode for exactly the customers with the most screens and budget.

So the shape is:

- **Self-hosted Community** — the current product, free, genuinely production-usable
  (Xibo's lesson: an uncrippled open product is what earns the community). This is also the
  only honest option today: pre-revenue, zero users — **adoption is the scarce asset, not
  revenue**.
- **Polyptic Cloud** (later, when there's pull) — we run the control plane, per-screen/mo.
  Captures everyone who doesn't want to run Postgres + a Docker host. This is where the
  signage market's median customer (1–8 screens, $11–20/screen) actually lives.
- **Self-hosted Enterprise** (later still) — paid pack on top of Community: SLA support,
  offline licence, and the buyer-with-a-budget features (§5).

Multi-tenancy is the main technical prerequisite for Cloud and is worth keeping in mind
whenever the store/API grows — but not worth building until commercialisation is actually
pulled on.

## 5. What is free vs paid (the gating line)

Proposed line, applying §3's heuristic (individuals/homelabs never pay; things only an
organisation with a budget needs are paid):

**Always free (Community):** the full orchestration core — murals, combined surfaces,
scenes, content library + media, instant propagation, ident, enrollment, local auth, the
depot/kiosk installer, metrics, thumbnails. *Also basic OIDC*: D11/D17 make generic identity
a product seam, and the "no SSO tax" trend makes gating it both off-brand and
community-hostile.

**Paid (Cloud subscription and/or Enterprise pack):** hosted control plane; screens above
the free allowance; audit log / activity-feed retention & export; fine-grained RBAC and
multi-team workspaces; SCIM provisioning; HA control plane guidance; proof-of-play-style
reporting; priority support with SLA; offline (air-gap) licence issuance.

**Enforcement mechanics.** Screens are first-class registry objects, so a licence that sets
`maxScreens` is a natural, cheap gate. Xibo's 30-day phone-home is tolerated by its market
but is wrong for an air-gap-first product — use **signed offline licence files** (an
Ed25519-signed JSON blob in config; no callback), exactly the kind Xibo makes you pay extra
for. Note the honesty limit: with an AGPL codebase, a screen-count gate is trivially
forkable — it's a tollbooth for honest organisations (which is what actually pays:
Docker's audit-risk-driven compliance), not DRM. If a *hard* per-screen gate above a free
tier is wanted for the self-hosted product itself (Portainer-style), that pushes the
licence choice toward FSL/Fair Source.

## 6. Pricing: the seed tiers vs the market

Seed proposal: Free ≤2 · £20/mo→5 · £40→15 · £100→100 (+ usage on top).

| Tier | Per-screen | Cheapest real comparator at that count | Gap |
|---|---|---|---|
| Free ≤2 | — | Yodeck 1 free, OptiSigns 3 free, piSignage 2 free | **matches market norms** |
| £20 → 5 | £4.00 | Yodeck Basic ≈ £30/mo; Xibo Cloud min ≈ £35/mo | ~⅓ of the cheapest |
| £40 → 15 | £2.67 | Yodeck ≈ £90/mo; Xibo Pro ≈ £52 | ½–¼ |
| £100 → 100 | £1.00 | Xibo Pro ≈ £350; Yodeck ≈ £600; TelemetryTV ≈ £630 | **3.5–6× under the floor** |

Assessment:

- **Free ≤2 screens is exactly right.** It clears the homelab/evaluation bar and matches the
  most common free-tier shapes (1–3 screens).
- **The paid tiers are priced like a race to the bottom that nobody is running.** Even the
  budget band holds $7–16/screen; 56% of real operators already pay $11–20. £1/screen at
  100 screens gives away the product precisely where revenue concentrates (the >8-screen
  minority) — and 100 screens is a customer with a serious budget, not a price-sensitive one.
- **Flat bundles create perverse cliffs** (a 6th screen quadruples nothing, a 16th screen
  jumps £60). The market norm — and what buyers expect — is **linear per-screen with volume
  breaks**.
- **"Per-usage on top" has no natural meter here.** Signage/orchestration has no usage unit
  customers recognise except media storage/bandwidth, and that only exists on *our* infra.
  Confine metering to Cloud media storage beyond an included allowance (info-beamer
  precedent: ~€0.62/GB/mo); drop it everywhere else. Two prices (per screen + per GB) is
  already the complexity ceiling.

**Suggested shape instead** (Cloud, GBP, indicative — sanity-check against COGS later):

- **Free** — 2 screens, community support, fair storage cap.
- **Standard — £6/screen/mo** (annual: £5). Undercuts the $11–20 median, sits above Xibo's
  hosted floor (£3.50), signals "real product" rather than "hobby".
- **Volume breaks** published on the pricing page: e.g. screens 21–100 at £4.50, 101+ at
  £3.50 — at 100 screens that's ~£480/mo, still comfortably under Yodeck/TelemetryTV while
  being 5× the seed proposal's £100.
- **Enterprise — quote**, anchored ~£10–12/screen: Enterprise pack features (§5), SLA,
  offline licences, invoicing. Screen floor (e.g. min 25) rather than a price cliff.
- **Self-hosted:** Community free and unlimited; Enterprise pack priced per screen per year
  (rule of thumb: ~50–60% of Cloud, since we carry no infra) with the same volume breaks.

## 7. Licence — the decision that can't wait

Today: **MIT, public repo, sole copyright holder.** MIT means anyone — including an
established signage vendor — may legally take Polyptic and sell it, hosted or embedded,
without contributing anything back. Being sole author means relicensing is currently a
one-commit decision; every merged outside contribution adds a copyright holder whose
consent (or a CLA) is needed later. §3's record says this is the one decision that must be
made *before* traction, because making it after is remembered as a rug-pull.

| Option | Moat | Community cost | Fits Polyptic |
|---|---|---|---|
| Stay MIT | none | none | only if commercialisation is abandoned or purely Cloud-ops-based |
| **AGPLv3 (+ CLA from first outside contributor)** | network copyleft deters commercial hosters/embedders; fully OSI open source | minimal — the 2024–26 default for single-vendor infra | **recommended default** |
| FSL / Fair Source | explicit non-compete; enables hard paid gates in the self-hosted product | "source-available" label; some purist pushback | the fallback if Portainer-style paid self-host tiers become the model |
| BSL | strong | high distrust | avoid |

**Recommendation: relicense to AGPLv3 now** (while the contributor count is one), state the
intent plainly in the README ("open source forever; we sell hosting and enterprise
support"), and adopt a CLA the day the first outside PR arrives. AGPL keeps every
non-negotiable intact — self-hostable, vendor-neutral, air-gappable — while making
"free-ride hosting by a competitor" legally unattractive. Revisit FSL only if the model
shifts to hard-gated self-hosted tiers.

## 8. Recommendation summary

1. **Now (one commit):** relicense MIT → AGPLv3; add a README sentence on the model. The
   only time-sensitive act in this document.
2. **Now (free):** keep the seed free tier — Community self-hosted is free and unlimited;
   the *hosted* free tier is 2 screens.
3. **When there's pull (not before):** Polyptic Cloud at ~£6/screen/mo with published volume
   breaks — per-screen linear, no flat bundles, no usage metering except Cloud storage.
4. **Later:** Enterprise pack (audit/RBAC/SCIM/SLA/offline licence) for both Cloud and
   self-hosted; signed offline licence files, never phone-home; SSO/OIDC stays free.
5. **Keep in mind while building:** tenancy-shaped store/API decisions; screens as the
   licensing unit (`maxScreens` in a signed licence blob).

## 9. Open questions

- **Who is the first paying customer, concretely?** Walls-of-dashboards buyers (labs,
  factories, NOCs) vs generic signage — the answer moves pricing band and feature order.
  The niche thesis in §2 needs validating against real prospects.
- Control-room incumbents (Userful, Barco CMS) were not priced in this pass — worth a look
  before setting Enterprise anchors, since that's the segment Polyptic undercuts hardest.
- Does a per-machine (agent) unit ever beat per-screen? Per-screen matches the product's
  soul (screens are first-class; machines are plumbing) and the market — but multi-output
  boxes make the two diverge.
- Legal plumbing when real: a company to sell through, VAT/MOSS for Cloud, GBP vs USD
  price lists (the market quotes USD; the seed tiers are GBP).

## Sources

Vendor pricing (fetched 2026-07-08): yodeck.com/pricing · screencloud.com/pricing ·
optisigns.com/pricing · fugo.ai/pricing · telemetrytv.com/digital-signage-software-pricing ·
novisign.com/pricing · lookdigitalsignage.com/pricing · playsignage.com/pricing ·
kitcast.tv/pricing · ablesign.tv · navori.com/pricing · screenly.io/pricing ·
xibosignage.com/pricing + /hosting + /open-source · pisignage.com/homepage/pricing.html ·
info-beamer.com/pricing · github.com/Screenly/Anthias · github.com/colloqi/pisignage-server.

Market data: Kitcast, *State of Digital Signage 2026* (kitcast.tv/reports/state-of-digital-signage-2026).

Business-model record: Open Core Ventures handbook + "The Red Hat model only worked for Red
Hat" · Sentry FSL announcement + fair.io · InfoQ on Elastic (2024) and Redis (2025) AGPL
returns · plausible.io/blog/community-edition · sso.tax · a16z "Open Source: From Community
to Commercialization" · FOSSA BSL/source-available guides · getmonetizely/withdaydream
freemium conversion benchmarks.
