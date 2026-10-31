# ORVMS — Ocean Risk and Vessel Monitoring System

**A multi-tenant maritime risk and supply-chain visibility platform** for shipping companies and the Indian Coast Guard.
It links *risk at sea* (live and synthetic AIS, modelled maritime zones, graded alerts) to *voyages*, *customer shipments* and *delivery commitments*, with approvals, SLAs, audit and integrations — serverless and free to host.

> Business case, requirements and architecture: [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (four-layer diagrams) · [`docs/TECH_DECISIONS.md`](docs/TECH_DECISIONS.md) · [`docs/openapi.yaml`](docs/openapi.yaml)

## What the business gets

| Capability | Who | What it does |
|---|---|---|
| **Supply-chain control tower** | Shipping companies | Customer shipments with live ETA from the vessel's position, delivery risk vs. the committed date, cargo value passing through risk areas, advisories |
| **Voyage risk management** | Operators, risk officers, org admins | Plan a voyage → automatic route risk assessment → approval workflow (low auto-approves; high needs a risk officer; critical needs two people; the preparer can never approve) → live route monitoring |
| **Fleet registry & plans** | Org admins | Master data with CSV import; subscription plans with quotas, usage metering and an invoice estimate |
| **Case desk with SLAs** | Coast Guard controllers | Suspicious-vessel reports routed to the nearest station/desk, priority P1–P4, SLA timers, assignment, closure codes, automatic escalation |
| **Graded alerts** | Coast Guard | Indian vessels in critical zones / foreign waters; foreign & unknown vessels approaching, entering and present in Indian waters; dark vessels; spoofing |
| **Integration** | Customer IT | API keys (hashed, scoped, quota-metered), OpenAPI, HMAC-signed webhooks with retries and a delivery log |
| **Platform administration** | Platform owner | Onboard customers, change plans, suspend accounts, risk policy, audit trail |
| **Multi-tenancy** | Everyone | Every customer is an isolated organisation; one tenant can never read or change another's data |

> **Honest scope.** Zones and boundaries are *modelled* (not official limits); synthetic vessels are always labelled; Coast Guard station locations are approximate; payments are not processed (invoices are estimates); this is decision support, not a navigation, legal or distress system.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173 — demo mode: the whole platform runs in your browser, no server
npm test             # 169 unit + API tests (business API runs against memory AND SQL storage)
npm run lint && npm run typecheck && npm run build
```

### Demo accounts (password `demo1234` in demo mode)

| Account | Role | Organisation |
|---|---|---|
| `operator` | operator | Bharat Ocean Carriers (professional plan, 10-vessel fleet) |
| `riskofficer` | risk officer | Bharat Ocean Carriers |
| `orgadmin` | organisation admin | Bharat Ocean Carriers |
| `kt.operator`, `kt.admin` | operator / org admin | Konkan Tankers Pvt Ltd (starter plan — shows quotas and tenant isolation) |
| `analyst`, `cg.mumbai`, `cg.gandhinagar`, `cg.kochi`, `cg.chennai`, `cg.portblair` | Coast Guard controllers | Indian Coast Guard (demo tenant) |
| `admin` | platform admin | ORVMS Platform Operations |

**A 5-minute walkthrough**
1. `operator` → *Supply chain*: six shipments; one is **late**, one **at risk** (value passing through the Gulf of Aden); *Voyages*: open `BOC KAVERI` (critical: crude/refined cargo through the Gulf of Aden).
2. `riskofficer` → *Voyages* → `BOC KAVERI` → Approve with a note → it stays *Awaiting approval* (critical needs a second person). `orgadmin` approves → *Approved*.
3. `operator` → *Live map* → select a vessel → **Report suspicious vessel** (distress) → `cg.kochi` → *Case desk*: the P1 case counts down its SLA and **escalates automatically** if unacknowledged.
4. `orgadmin` → *Organisation*: plan, usage vs. quotas, invoice estimate, users, API keys, webhooks. `kt.admin` sees *Starter* limits and no integrations.
5. `admin` → *Customers*: change a plan, suspend an account, onboard a customer.

## Live data

| Source | Coverage | Needs |
|---|---|---|
| **aisstream.io** | Global AIS | Free key from https://aisstream.io — server relay only (`npm run live`) |
| **Digitraffic** (CC BY 4.0) | Real live AIS, Baltic Sea | Nothing |
| **Synthetic India traffic** | ~90 distinct vessels on real shipping lanes, two customer fleets, scripted scenarios — always labelled | Nothing |

```bash
npm run live:setup -- <YOUR_AISSTREAM_KEY> world   # writes .dev.vars (git-ignored); region: india | indian-ocean | world
npm run live                                       # app + relay + local D1 database on http://localhost:8787
```
`live:setup` prints the password for the seeded accounts. **Coverage near India is sparse** (volunteer shore receivers: ~3 reports per 40 s in the India box vs ~2,200 worldwide), so vessels fade with age, the AIS-gap rule is off for terrestrial data, and the synthetic fleet exists to demonstrate every scenario.

## Alerts (Indian maritime-security perspective)

Vessels are classed **Indian / foreign / unknown**. *Indian vessels:* `indian_critical_zone`, `indian_foreign_waters`, `ais_gap`, `position_jump`. *Foreign & unknown:* `eez_approach` → `eez_entry` → `contiguous_entry` → `territorial_sea` (severity rises each step; an unidentified vessel or foreign warship in the territorial sea is critical), `loitering` (present in Indian waters), `high_speed_in_eez`. *Business:* `voyage_deviation`, `voyage_exposure`, `case_sla`, `user_report`, `geofence`. Thresholds and flags of interest are an admin-editable policy.

## Architecture in one picture

```
 SPA (TypeScript) ──REST/WebSocket──► Hono API ──► Application services ──► Pure domain logic
                                                       │                    (risk, voyage rules, ETA, SLA, plans)
                                                       ▼
                                          Repository interface ──► MemoryRepo (browser demo, tests)
                                                                └─► SqlRepo ──► Cloudflare D1 / SQLite (migrated on boot)
 Live feeds ─► adapters ─► Hub (vessel state + alerts, Durable Object) ─► background runner ─► webhooks (HMAC, retries)
```
Layers: `core/` (geo, zones, engine, hub) → `domain/` (voyage, supply chain, cases, plans, webhooks) → `services/` → `api/` → `web/`. See the diagrams in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Deploy for free

**A — GitHub Pages (demo mode, GitHub account only):** push, Settings → Pages → *GitHub Actions*; `.github/workflows/pages.yml` publishes.

**B — Cloudflare Workers Free (real backend + database):**
```bash
npm run build
npx wrangler login
npx wrangler d1 create orvms            # paste the printed database_id into wrangler.toml
npx wrangler secret put JWT_SECRET
npx wrangler secret put SEED_PASSWORD   # >= 8 chars; password of the seeded demo accounts
npx wrangler secret put AISSTREAM_API_KEY   # optional
npx wrangler deploy
```
The Worker applies database migrations itself on boot and seeds the demo tenants on first run. Upstream feeds run only while someone is connected (free-tier friendly).

## Security

PBKDF2-SHA256 passwords; signed expiring JWTs; role checks on every route; **tenant scoping in every query** (organisation id is a parameter of every repository call); API keys stored as SHA-256 hashes and shown once; scoped keys with monthly quotas; webhook targets restricted to public HTTPS; signed, retried deliveries; rate limiting (login, reporting); strict input validation; CSV formula-injection protection; no `innerHTML` in the UI; audit trail. Static analysis: ESLint + `eslint-plugin-security`, strict TypeScript, `npm audit`, CodeQL in CI.

## Testing

`npm test` runs 169 tests: pure-domain unit tests (scoring, state machine, SLA, ETA, quotas, webhook safety), the **repository contract suite on both storage implementations**, and the **whole business API suite on both** (tenant isolation, RBAC, quotas, four-eyes approvals, SLA escalation with a controllable clock, signed webhook delivery with retries, API-key metering, audit). `npm run test:coverage` for coverage.

## Project structure

```
src/
  core/      geo, modelled zones (+ zones.data.json), engine (alert rules), hub (live state), simulator, auth
  domain/    voyage scoring + state machine, supply-chain ETA/risk, case SLA, plans/quotas, webhooks, ports & routes
  data/      repository interface, MemoryRepo, SqlRepo, versioned migrations
  services/  org/registry, voyages, shipments, cases, background runner, seed, context
  api/       Hono app (core routes) + routes/enterprise.ts, rate limiter, CSV
  worker/    Cloudflare Worker + Durable Object, AIS parser, regions
  web/       SPA: workspace, map, enterprise screens, reporting dialog, theme
docs/        REQUIREMENTS.md, ARCHITECTURE.md, TECH_DECISIONS.md, openapi.yaml
tests/       unit/ (domain, engine, repo contract, geo…), api/ (core + enterprise), helpers/
scripts/     build_zones.py, check_routes.py, setup-live.mjs, mock-aisstream.mjs …
.github/workflows/  ci.yml (lint, types, tests, audit, build, CodeQL) · pages.yml · deploy-worker.yml
```
