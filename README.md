# ORVMS — Ocean Risk and Vessel Monitoring System

One maritime picture for those who guard the sea, work it and fish it.
Serverless, TypeScript end to end, and **free to host** (no always-on backend server).

| Persona | What they get |
|---|---|
| **Coast Guard controllers / maritime security analysts** | Live vessel picture, rule-based risk alerts (EEZ / territorial-sea entry, dark vessels, spoofing, loitering, high-risk areas), an **incident desk** for reports routed to their station, alert triage with notes, geofences, audit trail |
| **Fleet operators** (tankers, cargo, container) and other **reporters** | A private set of vessels ("My fleet"), alerts scoped to it, **report a suspicious or unidentified vessel** to the nearest Coast Guard controller, CSV incident export for insurers/charterers |

> **Data limits.** Public AIS only shows vessels that transmit it. Small fishing boats and vessels that switch AIS off are often invisible and AIS positions can be wrong or spoofed. Zones and boundaries are **modelled** (see below), not the official gazetted limits. ORVMS is decision support, not a navigation or legal-boundary tool.

## Real-time data — worldwide, focused on India

| Source | Coverage | Needs | Where |
|---|---|---|---|
| **aisstream.io** | **Global AIS**, including every vessel near India's EEZ | Free API key (https://aisstream.io → sign in with GitHub → API Keys) | Server only (Worker / `npm run live`) — aisstream does not allow browser connections |
| **Digitraffic Marine** (Fintraffic, CC BY 4.0) | Real live AIS, Baltic Sea (~650 vessels) | Nothing | Browser demo (data-source menu) **and** Worker |
| Synthetic India traffic | ~85 distinct vessels on real shipping lanes around India (flagged **synthetic**) + scripted scenarios (dark vessel, spoofing, loitering, unidentified fast craft) | Nothing | Browser demo (time-lapse), and blendable into a live feed (real-time pace) |

No free feed covers Indian waters without a key, so global/Indian live data needs the free aisstream key. Fastest way to see it (about 2 minutes, no Cloudflare account):

```bash
npm run live:setup -- <YOUR_AISSTREAM_KEY> india     # writes .dev.vars (git-ignored); region: india | indian-ocean | world
npm run live                                         # builds the UI and starts the relay + app on http://localhost:8787
```
Sign in as `admin` / `analyst` / `operator` with the password printed by `live:setup`.

**Coverage presets (`AIS_REGION`):**
* `india` (default) — India's whole EEZ area (lat -2…28, lon 58…102) **plus** the Red Sea / Gulf of Aden / Arabian Gulf / Hormuz and the Malacca & Singapore Straits;
* `indian-ocean` — lat -40…32, lon 20…125;
* `world` — everything. Reports near India are kept at full rate (one per vessel per 10 s); the rest of the world is thinned to one per minute, and the server keeps the 6,000 most recently seen vessels. `world` is heavy for the Cloudflare *free* tier — fine locally, use `india` when deployed free.

**Coverage near India is sparse — know this before you present it.** aisstream.io is built from volunteer shore receivers. Measured with a real key over 40 s: ~2,200 position reports worldwide but only ~3 inside the India box. Vessels near ports (e.g. Chennai) and busy lanes appear; open ocean mostly does not. So: vessels are kept in memory and fade in the UI as they age (30 min / 6 h); vessels inside the India area are evicted last; and the AIS-gap ("dark vessel") rule is switched off for aisstream data, because silence there means "out of receiver range", not "transponder off". Satellite-AIS (paid) is the real fix for open-ocean India coverage.

The UI shows feed health in the header (a bad key or dropped connection reads "Feed problem: …" instead of silently showing an empty sea) and has jump buttons (India EEZ, Arabian Sea, Bay of Bengal, Palk Strait, Gulf of Aden, Malacca, World). The relay path is covered by a local mock (`node scripts/mock-aisstream.mjs`, then run the Worker with `AISSTREAM_URL=http://localhost:9911` and `AISSTREAM_API_KEY=testkey`); it has not been run against the real service because that needs your key.

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

(For live vessels see "Real-time data" above.)

```bash
npm install
npm run dev          # http://localhost:5173  (auto-falls back to demo mode, no server needed)
npm test             # unit + API tests
npm run lint && npm run typecheck && npm run build
```

Demo-mode accounts (browser-only; password `demo1234`): `analyst`, `operator`, `admin`, and controllers `cg.mumbai`, `cg.gandhinagar`, `cg.kochi`, `cg.chennai`, `cg.portblair`. Keyboard: `/` focuses vessel search, `Esc` clears selection.

### Run the real Worker locally

```bash
cp .dev.vars.example .dev.vars     # set JWT_SECRET and SEED_PASSWORD (and optionally DATA_SOURCE / AISSTREAM_API_KEY)
npx wrangler dev                   # http://localhost:8787  (REST + WebSocket)
```
Seeded users `admin` / `analyst` / `operator` / `cg.*` use the `SEED_PASSWORD` you set.

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
| `POST /api/auth/login` | – (rate-limited) | JWT (HS256, 8 h) |
| `GET /api/me`, `GET /api/vessels`, `GET /api/vessels/:mmsi` | any role | Identity and vessel state |
| `GET /api/alerts?status=&severity=` | any role (operators see only their fleet) | Alert queue |
| `POST /api/alerts/:id/ack` · `/resolve` | any role (same scoping) | Alert lifecycle with notes |
| `GET /api/reports/alerts.csv` | any role | CSV export (formula-injection safe) |
| `GET/POST/DELETE /api/watchlist` | any role | Per-user set of vessels |
| `GET /api/stations` | any role | Coast Guard stations (approximate) |
| `POST /api/incidents` | any role (rate-limited) | Report a vessel (`mmsi`) or an unidentified boat (`lat`,`lon`) → routed to the nearest station |
| `GET /api/incidents` | any role (reporters see their own) | Incident list |
| `POST /api/incidents/:id/status` | analyst, admin | acknowledged / investigating / closed |
| `PUT /api/feed/synthetic` | analyst, admin | Blend synthetic India traffic into the feed |
| `GET /api/geofences` · `POST/DELETE` | read: any · write: analyst, admin | Circular geofences |
| `GET/PUT /api/policy` | read: any · write: admin | Risk thresholds, flags of interest |
| `GET /api/audit` | admin | Audit trail |
| `WS /ws?token=` | any role | Snapshot stream (alerts filtered per user) |

## Synthetic traffic near India

`src/core/simulator.ts` generates ~85 distinct vessels (cargo, tankers, passenger ferries, Indian Coast Guard / Navy patrols, foreign flags) sailing 13 real shipping lanes (Gulf of Aden – Colombo – Malacca, Mumbai – Kochi, Chennai – Port Blair, …) plus scripted scenarios. Lanes are verified against Natural Earth land (`scripts/check_routes.py`). The vessels go through **exactly the same pipeline as live AIS** — `Hub.ingest` → risk engine → alerts — with AIS-style irregular reports and jitter, and every record carries `origin: 'synthetic'`: amber outline on the map, a SYNTHETIC tag in the detail panel and tooltip, and a layer toggle. Never present them as real vessels.

* Demo mode "Simulated" source: time-lapse (about 40× real time) so scenarios play out in minutes.
* Blend into a live feed: tick **Layers → Blend synthetic India traffic** (analysts/admins), or set `SYNTHETIC=true`. This runs at real-time pace, like live data.

## Reporting suspicious vessels

From any vessel's detail panel (**⚑ Report suspicious vessel**), or the map's **⚑ Report unidentified boat** (click where you saw a boat that is not on AIS), choose a category and add details. ORVMS then:

1. finds the **nearest Coast Guard station** (`src/core/stations.ts`, ~23 regional/district HQs and stations, approximate locations) and its **controller desk**;
2. adds the vessel to the reporter's own set, and for an unidentified boat adds a **user-reported contact** to the map (red diamond);
3. raises a high-priority `user_report` alert (critical for distress) and an **incident** with a timeline;
4. notifies the controllers of that desk (toast + badge on the Incidents tab). Controllers acknowledge → investigate → close; reporters see the status change. Closing a manual contact removes it from the map.

Demo/seeded controller accounts: `cg.mumbai`, `cg.gandhinagar`, `cg.kochi`, `cg.chennai`, `cg.portblair`. Station coordinates are approximate and this is **not a distress system** — use official channels in an emergency.

## Alerts (Indian maritime security perspective)

Every vessel is classed **Indian** (flag India), **foreign** (valid foreign flag) or **unknown** (no valid flag state / user-reported contact), and alerts carry that class (filter chips in the queue; most urgent first).

**Indian vessels**
* `indian_critical_zone` — an Indian vessel enters a critical (high-risk) area: Gulf of Aden / Bab-el-Mandeb (high), Somali Basin / Hormuz / Malacca (medium) → advise the operator;
* `indian_foreign_waters` — crosses into a neighbour's (modelled) waters: high for small / non-merchant craft (risk of detention), low for merchant ships trading with the neighbour;
* `ais_gap` (dark vessel) and `position_jump` (spoofing / impossible movement) — high for Indian vessels.

**Foreign and unknown vessels vs. the Indian maritime boundary** — graded by who they are (merchant < other < warship / unidentified; flags of interest and fast movers add a level):
* `eez_approach` — closing on the EEZ limit, alert once when it crosses the approach window (default 60 nm; admin-configurable). Ordinary merchant traffic is ignored here;
* `eez_entry` → `contiguous_entry` (12–24 nm) → `territorial_sea` (12 nm) — rising severity with each step; an unidentified vessel or a foreign warship in the territorial sea is **critical**;
* `loitering` ("present in Indian waters") — a foreign/unknown vessel stationary inside the EEZ, contiguous zone or territorial sea (stricter closer in);
* `high_speed_in_eez`, `geofence` (analyst-defined), `user_report` (see above), and `high_risk_zone` (foreign traffic in a risk area — low-priority note).

Severity and thresholds come from an admin-editable **policy** (no hard-coded "unfriendly flags"). Alerts are de-duplicated with per-rule cooldowns.

## Demo fleet

The operator account manages **Bharat Ocean Carriers** (a fictional company): 10 Indian-flag tankers, bulkers and container ships (`BOC ARAVALI`, `BOC NILGIRI`, …) on real lanes, so the operator sees realistic alerts — e.g. `BOC ARAVALI` entering the Gulf of Aden, `BOC NILGIRI` entering the Strait of Hormuz approaches. The fleet page shows fleet KPIs, each vessel's current zone and any open alerts.

## Security

PBKDF2-SHA256 password hashing, HS256 JWTs, role-based access, per-user alert scoping (REST and WebSocket), rate limiting on login and public endpoints, strict input validation (MMSI, coordinates, ranges), security headers, audit log, CSV formula-injection protection, no `innerHTML` anywhere in the UI (AIS names are untrusted), secrets only via `wrangler secret`. Static analysis: ESLint + `eslint-plugin-security`, strict TypeScript, `npm audit`, CodeQL in CI.

## Project structure

```
src/
  core/    domain logic: geo, zones (+ zones.data.json), boundary, vessel normalisation, risk engine, Hub, auth, simulator, Digitraffic client
  api/     Hono REST app, rate limiter, CSV export
  worker/  Cloudflare Worker + Durable Object + aisstream parser
  web/     UI: landing, workspace (map, alerts, detail), pages, incident reporting dialog, theme, animated canvas vessel layer
scripts/   build_zones.py (zone geometry), check_routes.py, probe.ts (dev helpers)
tests/
  unit/    geo + zones, vessel, engine, hub, auth, helpers
  api/     endpoint tests (auth, RBAC, validation, rate limit, CSV)
.github/workflows/   ci.yml (lint, types, tests, audit, build, CodeQL) · pages.yml · deploy-worker.yml
wrangler.toml        Worker + Durable Object + static assets
```

## What changed from the prototype

Fake login → real auth + RBAC · committed API key / `.pyc` files → secrets + `.gitignore` · open `DELETE`/`POST /vessels/manual` → removed · in-memory global state → Hub with persistence · hard-coded flag politics → admin policy · hand-drawn rectangle "EEZ" → coastline-derived 12/24/200 nm zones with equidistance boundaries · misclassified ship types → fixed + tested · 1,168-line `app.js` → typed modules · no tests → 79 tests · Python server on Render → serverless · simulated-only data → real live AIS option.
