# NavSight — Maritime Situational Awareness Platform

One shared picture of the sea for the people who guard it, work it and fish it.
Serverless, TypeScript end to end, and **free to host** (no always-on backend server).

| Persona | What they get |
|---|---|
| **Coast Guard / maritime security analysts** | Live vessel picture, rule-based risk alerts (EEZ entry, dark vessels, spoofing, loitering, high-risk zones), alert triage with notes, geofences, audit trail |
| **Fleet operators** (tankers, cargo, container) | Private watchlist ("My fleet"), alerts scoped to their own vessels, CSV incident export for insurers/charterers |
| **Fishermen & small boats** | Public, login-free **Boundary Safety** screen: phone GPS → distance to the maritime boundary. Offline-first, English / हिन्दी / ગુજરાતી, large touch targets |

> **Data limits.** Public AIS only shows vessels that transmit it. Small fishing boats and vessels that switch AIS off are often invisible and AIS positions can be wrong or spoofed. EEZ, high-risk-zone and boundary geometry in this repo is simplified and **illustrative** — NavSight is decision support, not a navigation or legal-boundary tool.

## Architecture (zero-cost)

```
 aisstream.io ──WS──►  Cloudflare Worker ─► Durable Object "NavSightHub"      (free tier)
 (optional key)         /api/*  /ws          • one upstream AIS socket, only while viewers are connected
                                             • Hub: vessel state + risk engine + alerts + audit
 Browser  ◄─ REST + WebSocket ─────────────  • persists alerts/users/watchlists/geofences in DO storage
  (static assets served by the same Worker; no CORS, one deploy)

 No backend at all?  The same Hono API + risk engine run INSIDE the browser ("demo mode"),
 fed by a deterministic simulator → deployable on GitHub Pages with zero configuration.
```

Layers: `core/` (pure domain logic, runs anywhere) → `api/` (Hono REST app, platform-neutral) → `worker/` (Cloudflare adapter) and `web/` (UI).

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173  (auto-falls back to demo mode, no server needed)
npm test             # unit + API tests
npm run lint && npm run typecheck && npm run build
```

Demo-mode accounts (browser-only demo; password `demo1234`): `analyst`, `operator`, `admin`.

### Run the real Worker locally

```bash
cp .dev.vars.example .dev.vars     # set JWT_SECRET and SEED_PASSWORD
npx wrangler dev                   # http://localhost:8787  (REST + WebSocket)
```
Seeded users `admin` / `analyst` / `operator` use the `SEED_PASSWORD` you set.

## Deploy for free

**Option A — GitHub Pages (demo mode, no accounts besides GitHub).**
Push to GitHub → Settings → Pages → Source: *GitHub Actions*. `.github/workflows/pages.yml` runs tests, builds and publishes.

**Option B — Cloudflare Workers Free (live backend).**
```bash
npm run build
npx wrangler login
npx wrangler secret put JWT_SECRET        # long random string
npx wrangler secret put SEED_PASSWORD     # >= 8 chars, for admin/analyst/operator
npx wrangler secret put AISSTREAM_API_KEY # optional; free key from https://aisstream.io, else server-side simulator
npx wrangler deploy
```
Serves the UI and API from one `*.workers.dev` URL. Rotate any API key that was ever committed — this repo's predecessor leaked one.

*Free-tier design notes:* the Durable Object holds the upstream AIS socket **only while at least one viewer is connected** (stops after 3 idle minutes), applies a per-vessel 10 s throttle, limits the feed to the Indian Ocean bounding box, and sends trail-free snapshots every 5 s. Alerts are therefore generated only while someone is watching.

## API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | – | Liveness + feed source |
| `GET /api/public/zones` | – | EEZ / high-risk / boundary geometry |
| `POST /api/public/boundary-check` | – (rate-limited) | `{lat, lon}` → safety level and distance |
| `POST /api/auth/login` | – (rate-limited) | JWT (HS256, 8 h) |
| `GET /api/me`, `GET /api/vessels`, `GET /api/vessels/:mmsi` | any role | Identity and vessel state |
| `GET /api/alerts?status=&severity=` | any role (operators see only their fleet) | Alert queue |
| `POST /api/alerts/:id/ack` · `/resolve` | any role (same scoping) | Alert lifecycle with notes |
| `GET /api/reports/alerts.csv` | any role | CSV export (formula-injection safe) |
| `GET/POST/DELETE /api/watchlist` | any role | Per-user watchlist |
| `GET /api/geofences` · `POST/DELETE` | read: any · write: analyst, admin | Circular geofences |
| `GET/PUT /api/policy` | read: any · write: admin | Risk thresholds, flags of interest |
| `GET /api/audit` | admin | Audit trail |
| `WS /ws?token=` | any role | Snapshot stream (alerts filtered per user) |

## Risk rules

`eez_entry` · `high_speed_in_eez` · `high_risk_zone` · `loitering` · `ais_gap` (dark vessel) · `position_jump` (spoofing/bad data) · `fishing_boundary` · `geofence`.
Severity and thresholds come from an admin-editable **policy** (no hard-coded "unfriendly flags"). Alerts are de-duplicated with per-rule cooldowns.

## Security

PBKDF2-SHA256 password hashing, HS256 JWTs, role-based access, per-user alert scoping, rate limiting on login and public endpoints, strict input validation (MMSI, coordinates, ranges), security headers, audit log, CSV formula-injection protection, no `innerHTML` anywhere in the UI (AIS names are untrusted), secrets only via `wrangler secret`. Static analysis: ESLint + `eslint-plugin-security`, strict TypeScript, `npm audit`, CodeQL in CI.

## Project structure

```
src/
  core/    domain logic: geo, zones, vessel normalisation, risk engine, Hub, auth, simulator
  api/     Hono REST app, rate limiter, CSV export
  worker/  Cloudflare Worker + Durable Object + AIS parser
  web/     UI: landing, analyst/operator app, fisherman view, i18n, map
tests/
  unit/    geo, vessel, engine, hub, auth, helpers
  api/     endpoint tests (auth, RBAC, validation, rate limit, CSV)
.github/workflows/   ci.yml (lint, types, tests, audit, build, CodeQL) · pages.yml · deploy-worker.yml
wrangler.toml        Worker + Durable Object + static assets
```

## What changed from v2 (the prototype)

Fake login → real auth + RBAC · committed API key / `.pyc` files → secrets + `.gitignore` · open `DELETE`/`POST /vessels/manual` → removed · in-memory global state → Hub with persistence · hard-coded flag politics → admin policy · misclassified ship types (naval code unreachable) → fixed + tested · 1,168-line `app.js` → typed modules · no tests → 63 tests · Python server on Render → serverless.
