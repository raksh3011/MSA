# ORVMS — Ocean Risk and Vessel Monitoring System

One maritime picture for those who guard the sea, work it and fish it.
Serverless, TypeScript end to end, and **free to host** (no always-on backend server).

| Persona | What they get |
|---|---|
| **Coast Guard / maritime security analysts** | Live vessel picture, rule-based risk alerts (EEZ / territorial-sea entry, boundary crossing, dark vessels, spoofing, loitering, high-risk areas), alert triage with notes, geofences, audit trail |
| **Fleet operators** (tankers, cargo, container) | Private watchlist ("My fleet"), alerts scoped to their own vessels, CSV incident export for insurers/charterers |
| **Fishermen & small boats** | Public, login-free **Boundary Safety** screen: phone GPS → distance to the maritime boundary and which waters you are in. Offline-first, English / हिन्दी / ગુજરાતી |

> **Data limits.** Public AIS only shows vessels that transmit it. Small fishing boats and vessels that switch AIS off are often invisible and AIS positions can be wrong or spoofed. Zones and boundaries are **modelled** (see below), not the official gazetted limits. ORVMS is decision support, not a navigation or legal-boundary tool.

## Real-time data — what is live, and what needs a key

| Source | Coverage | Needs | Where |
|---|---|---|---|
| **Digitraffic Marine** (Fintraffic, CC BY 4.0) | **Real, live AIS — Baltic Sea (~600–1000 vessels)** | Nothing (no key, no signup) | Browser demo (data-source menu) **and** Worker (`DATA_SOURCE=digitraffic`) |
| **aisstream.io** | Global AIS incl. the **Indian Ocean** | Free API key (https://aisstream.io, GitHub sign-in) | Worker (`wrangler secret put AISSTREAM_API_KEY`, `DATA_SOURCE=aisstream`) |
| Built-in simulator | Indian Ocean scenarios (dark vessel, spoofing, boundary crossings…) | Nothing | Browser demo and Worker (`DATA_SOURCE=simulated`) |

There is no free keyless AIS feed covering Indian waters, so for live Indian-Ocean vessels you need the (free) aisstream key. The simulator exists so every alert scenario can be demonstrated on demand.

## Zones and boundaries (modelled)

`scripts/build_zones.py` builds the geometry from **real coastlines** (Natural Earth 1:10m, public domain) with UNCLOS distances:

* territorial sea = 12 nm, contiguous zone = 24 nm, EEZ = 200 nm from Indian land (mainland, Andaman & Nicobar, Lakshadweep);
* where a neighbour's coast is closer, the limit is the **equidistance (median) line** (Voronoi over densified coastlines of India, Pakistan, Sri Lanka, Bangladesh, Myanmar, Maldives, Indonesia, Thailand, Oman, Malaysia);
* the shared edges are the **modelled maritime boundary lines**, and each neighbour's waters are modelled the same way ("Neighbouring waters").
* High-risk areas (Gulf of Aden, Bab-el-Mandeb, Somali Basin, Hormuz, Malacca) are indicative polygons based on public advisories (BMP5 / UKMTO / IMB) with `high` / `elevated` levels.

Output is committed as `src/core/zones.data.json` (the app never needs Python at runtime). To regenerate: `pip install shapely pyproj` then
`python scripts/build_zones.py <ne_10m_admin_0_countries.geojson>`. Simulator routes are checked against land with `scripts/check_routes.py`.

## Architecture (zero-cost)

```
 aisstream.io / Digitraffic ─►  Cloudflare Worker ─► Durable Object "OrvmsHub"   (free tier)
 (or built-in simulator)         /api/*  /ws          • upstream feed only while viewers are connected
                                                      • Hub: vessel state + risk engine + alerts + audit
 Browser  ◄─ REST + WebSocket ─────────────────────   • persists alerts/users/watchlists/geofences in DO storage
  (static assets served by the same Worker; no CORS, one deploy)

 No backend at all?  The same Hono API + risk engine run INSIDE the browser ("demo mode"),
 fed by the simulator or by live Digitraffic AIS → deployable on GitHub Pages with zero configuration.
```

Layers: `core/` (pure domain logic, runs anywhere) → `api/` (Hono REST app, platform-neutral) → `worker/` (Cloudflare adapter) and `web/` (UI).

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173  (auto-falls back to demo mode, no server needed)
npm test             # unit + API tests
npm run lint && npm run typecheck && npm run build
```

Demo-mode accounts (browser-only; password `demo1234`): `analyst`, `operator`, `admin`. Keyboard: `/` focuses vessel search, `Esc` clears selection.

### Run the real Worker locally

```bash
cp .dev.vars.example .dev.vars     # set JWT_SECRET and SEED_PASSWORD (and optionally DATA_SOURCE / AISSTREAM_API_KEY)
npx wrangler dev                   # http://localhost:8787  (REST + WebSocket)
```
Seeded users `admin` / `analyst` / `operator` use the `SEED_PASSWORD` you set.

## Deploy for free

**Option A — GitHub Pages (demo mode, no accounts besides GitHub).**
Push to GitHub → Settings → Pages → Source: *GitHub Actions*. `.github/workflows/pages.yml` runs tests, builds and publishes. Real live AIS (Baltic) works here too.

**Option B — Cloudflare Workers Free (live backend).**
```bash
npm run build
npx wrangler login
npx wrangler secret put JWT_SECRET          # long random string
npx wrangler secret put SEED_PASSWORD       # >= 8 chars, for admin/analyst/operator
npx wrangler secret put AISSTREAM_API_KEY   # optional: free key for Indian-Ocean live AIS
# in wrangler.toml [vars]: DATA_SOURCE = "aisstream" | "digitraffic" | "simulated"
npx wrangler deploy
```
Serves the UI and API from one `*.workers.dev` URL. Rotate any API key that was ever committed — the prototype this project replaces leaked one.

*Free-tier design notes:* the Durable Object holds the upstream feed **only while at least one viewer is connected** (stops after 3 idle minutes), applies a per-vessel 10 s throttle, limits aisstream to the Indian Ocean bounding box, and sends trail-free snapshots every 5 s. Alerts are therefore generated only while someone is watching.

## API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | – | Liveness + feed source |
| `GET /api/public/zones` | – | Modelled boundary lines, neighbouring waters, high-risk areas, method + disclaimer |
| `POST /api/public/boundary-check` | – (rate-limited) | `{lat, lon}` → level, distance, zone, neighbouring state |
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

`eez_entry` · `territorial_sea` · `high_speed_in_eez` · `high_risk_zone` · `loitering` · `ais_gap` (dark vessel; only for vessels that were underway) · `position_jump` (spoofing/bad data) · `fishing_boundary` (names the neighbouring state) · `geofence`.
Severity and thresholds come from an admin-editable **policy** (no hard-coded "unfriendly flags"). Alerts are de-duplicated with per-rule cooldowns.

## Security

PBKDF2-SHA256 password hashing, HS256 JWTs, role-based access, per-user alert scoping (REST and WebSocket), rate limiting on login and public endpoints, strict input validation (MMSI, coordinates, ranges), security headers, audit log, CSV formula-injection protection, no `innerHTML` anywhere in the UI (AIS names are untrusted), secrets only via `wrangler secret`. Static analysis: ESLint + `eslint-plugin-security`, strict TypeScript, `npm audit`, CodeQL in CI.

## Project structure

```
src/
  core/    domain logic: geo, zones (+ zones.data.json), boundary, vessel normalisation, risk engine, Hub, auth, simulator, Digitraffic client
  api/     Hono REST app, rate limiter, CSV export
  worker/  Cloudflare Worker + Durable Object + aisstream parser
  web/     UI: landing, workspace (map, alerts, detail), pages, fisherman view, i18n, theme, canvas vessel layer
scripts/   build_zones.py (zone geometry), check_routes.py, probe.ts (dev helpers)
tests/
  unit/    geo + zones, vessel, engine, hub, auth, helpers
  api/     endpoint tests (auth, RBAC, validation, rate limit, CSV)
.github/workflows/   ci.yml (lint, types, tests, audit, build, CodeQL) · pages.yml · deploy-worker.yml
wrangler.toml        Worker + Durable Object + static assets
```

## What changed from the prototype

Fake login → real auth + RBAC · committed API key / `.pyc` files → secrets + `.gitignore` · open `DELETE`/`POST /vessels/manual` → removed · in-memory global state → Hub with persistence · hard-coded flag politics → admin policy · hand-drawn rectangle "EEZ" → coastline-derived 12/24/200 nm zones with equidistance boundaries · misclassified ship types → fixed + tested · 1,168-line `app.js` → typed modules · no tests → 67 tests · Python server on Render → serverless · simulated-only data → real live AIS option.
