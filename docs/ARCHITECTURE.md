# ORVMS — Architecture

Four views of the multi-tier design. Diagrams are Mermaid (render on GitHub, VS Code, or <https://mermaid.live>).

## 1. Logical layer — what the user sees and how requests are orchestrated

```mermaid
flowchart TB
  subgraph UI["Presentation (single-page app, TypeScript)"]
    MAP["Live map / alert queue"]
    SC["Supply-chain control tower"]
    VY["Voyages & approvals"]
    FL["Fleet registry"]
    CD["Case desk (SLA)"]
    ORG["Organisation: plan, users, API keys, webhooks"]
    ADM["Platform admin: customers, policy, audit"]
  end
  subgraph API["API / controller layer (Hono REST + WebSocket)"]
    AUTH["Auth & RBAC middleware (JWT)"]
    RT1["Core routes: vessels, alerts, geofences, policy, audit"]
    RT2["Enterprise routes: org, registry, voyages, shipments, cases, catalog, admin"]
    RT3["Integration API (X-API-Key)"]
  end
  subgraph SVC["Application services (business orchestration)"]
    S1["Org / registry / quota"]
    S2["Voyage service"]
    S3["Shipment service (control tower)"]
    S4["Case service (SLA)"]
    S5["Webhook dispatcher"]
    S6["Background runner"]
  end
  subgraph DOM["Domain logic (pure functions)"]
    D1["Risk engine & zone model"]
    D2["Voyage scoring + state machine"]
    D3["Supply-chain ETA / delivery risk"]
    D4["SLA & escalation rules"]
    D5["Plans, quotas, invoice estimate"]
  end
  UI --> API --> SVC --> DOM
```

## 2. Technical layer — services, messaging and data translation

```mermaid
flowchart LR
  AIS1["aisstream.io (WebSocket, binary JSON)"] --> ADP["Feed adapters: parse, validate, normalise, throttle"]
  AIS2["Digitraffic (REST poll)"] --> ADP
  SYN["Synthetic traffic generator (labelled)"] --> ADP
  ADP --> HUB["Hub: vessel state + risk engine + alerts"]
  HUB -->|alerts, positions| BG["Background runner every 5 s"]
  BG --> VM["Voyage monitor"]
  BG --> SLA["SLA sweeper"]
  BG --> SH["Shipment sweeper"]
  VM & SLA & SH -->|domain events| EV["emit()"]
  EV --> WH["Webhook dispatcher: HMAC-SHA256 signature, 3 attempts, delivery log"]
  WH --> ERP["Customer ERP / TMS (HTTPS)"]
  HUB -->|snapshots per user, alerts filtered by tenant| WS["WebSocket fan-out"]
  WS --> BROWSER["Browsers"]
  API2["REST API"] <--> SVC2["Application services"] <--> REPO["Repository interface"]
```

Key translations: AIS message type → `PositionReport` → normalised `Vessel` (flag from MMSI MID, category from ship type); route template → sampled polyline → exposure by zone → risk score; vessel position + voyage → projected ETA → delivery risk; domain event → signed JSON envelope.

## 3. Data layer — relational schema (Cloudflare D1 / SQLite)

```mermaid
erDiagram
  organizations ||--o{ registry_vessels : owns
  organizations ||--o{ voyages : plans
  organizations ||--o{ shipments : books
  organizations ||--o{ api_keys : issues
  organizations ||--o{ webhooks : subscribes
  organizations ||--o{ usage : metered
  voyages ||--o{ shipments : carries
  webhooks ||--o{ webhook_deliveries : "delivery log"
  organizations { text id PK text name text kind text plan_id text status int created_at }
  registry_vessels { text org_id PK text mmsi PK text imo text name text vessel_type text flag int gross_tonnage text status }
  voyages { text id PK text org_id FK text reference text mmsi text status int risk_score text risk_level json waypoints json assessment json approvals json history int etd int eta }
  shipments { text id PK text org_id FK text reference text customer real value_inr int required_by text voyage_id FK text status text delivery_risk json history }
  cases { text id PK text org_id text mmsi text priority text status text desk text assignee int ack_due_at int resolve_due_at int escalation_level int sla_breached json history }
  api_keys { text id PK text org_id FK text prefix text hash UK json scopes int revoked_at }
  webhooks { text id PK text org_id FK text url text secret json events int active }
  webhook_deliveries { text id PK text webhook_id text event text status int attempts int response_status }
  usage { text org_id PK text period PK text metric PK int count }
```

*Operational (non-relational) state:* live vessel positions, alerts, watchlists, geofences, users (identity) and the audit trail live in the Durable Object's storage; they are high-churn and rebuilt from the feed. *Reference data in code:* ports, route templates, plans, Coast Guard stations, modelled zone geometry.

## 4. Infrastructure layer — repository, CI/CD and runtime

```mermaid
flowchart TB
  DEV["Developer"] -->|git push| GH["GitHub repository (main / dev)"]
  GH --> CI["GitHub Actions: lint, strict typecheck, 150+ tests, npm audit, build, CodeQL"]
  CI -->|manual| DEPLOY["wrangler deploy"]
  subgraph CF["Cloudflare (free tier)"]
    ASSETS["Static assets (SPA)"]
    W["Worker: routing"]
    DO["Durable Object: hub, REST, WebSocket, background runner"]
    D1[("D1 database: business records, auto-migrated on boot")]
  end
  DEPLOY --> CF
  W --> DO --> D1
  DO -->|outbound WebSocket / HTTPS| EXT["aisstream.io · Digitraffic · customer webhooks"]
  USER["Browsers"] --> ASSETS
  USER --> W
```

Environments: local (`npm run dev` demo, `npm run live` with local D1), staging/production (Cloudflare), CI. Secrets only via `wrangler secret` / `.dev.vars` (git-ignored).
