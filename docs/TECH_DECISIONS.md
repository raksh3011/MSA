# ORVMS — Technology and architecture decisions

Each decision states the alternative and the reasoning for *this* system.

| Decision | Chosen | Alternative considered | Why |
|---|---|---|---|
| Architecture style | Layered modular monolith (core → domain → services → API → UI) | Microservices | One small team and a free-tier runtime. Strict module boundaries (pure domain, services, repository) give the testability and replaceability of services without network hops or operational cost. Modules can later be split along the same seams. |
| Business logic placement | Pure functions in `domain/` | Logic inside route handlers | Risk scoring, approval rules, SLA and ETA maths are the product's value; as pure functions they are unit-tested exhaustively and run unchanged on server, browser and in tests. |
| Persistence | Relational (D1 / SQLite) for business records; Durable Object storage for live operational state | Document store for everything | Business data has relationships, constraints and tenant filters (organisations → vessels → voyages → shipments); relational integrity and indexed queries fit. Live positions are high-churn and rebuildable, so they stay in memory with periodic persistence. |
| Data access | Repository interface with `MemoryRepo` and `SqlRepo` | Direct SQL in services | One contract test-suite and the whole API suite run against both implementations, proving behaviour is identical and keeping the tests fast and database-free. Tenant id is a parameter of every tenant query, so cross-tenant access is impossible by construction. |
| Migrations | Versioned SQL applied at boot | Manual DDL | Zero-ops deployments on a free tier; migrations are tested in CI. |
| Runtime | Cloudflare Workers + Durable Object | Node server on a VM / container | No always-on cost; a Durable Object can hold one upstream WebSocket and run background processing, which plain functions cannot. |
| API | REST + WebSocket (Hono) | GraphQL / gRPC | Simple, cacheable, easy for ERP partners; Hono runs identically in Workers, Node and the browser. |
| Auth | Stateless JWT (HS256) + role model + organisation scoping; API keys (hashed) for machines | Session cookies | No session store; works for WebSocket and integrations. Short expiry; revocation of API keys is immediate. |
| Integration | HMAC-signed webhooks + API keys + OpenAPI | Direct DB access / file drops | Standard, verifiable, retried delivery that ERP/TMS vendors already support. |
| Language | TypeScript (strict) everywhere | Python backend | One language and shared domain code across browser, Worker and tests; strict typing catches data-shape errors early. |
| Map rendering | Canvas layer + Leaflet | DOM markers / WebGL library | Thousands of moving vessels with smooth animation need canvas; Leaflet keeps tiles/zones simple and dependency-light. |
| Zones | Modelled from real coastlines (UNCLOS distances, equidistance) | Hand-drawn polygons | Defensible, reproducible (`scripts/build_zones.py`), and honestly labelled as not official. |
| Money handling | Amounts as INR with two decimals, GST computed once per invoice; one invoice per organisation and period enforced by a unique constraint; overdue derived from the due date, never stored | Stored status flags updated by a job | A derived status cannot go stale if a job is late; the unique constraint makes month-end billing safe to re-run. |
| Payments | Sandbox gateway behind one function (`payInvoice`) | Real gateway integration | Real payment handling is out of scope and risky; the seam is identical to where a PSP SDK would be called. |
| Documents | Invoices and reports as HTML "paper" views printed to PDF by the browser, plus CSV | Server-side PDF library | Zero dependencies and no server cost; the same view serves screen and print. |
| Scheduled work | Idempotent sweepers run from the Durable Object tick, throttled by timestamps (billing, reports every 10 min; retention hourly) | Cron triggers / queues | Works on the free tier with one mechanism; every job is safe to repeat. |
| Observability | JSON log lines on the console plus an in-memory ring shown in the ops console | External log service | Workers logs capture the console; the ring gives the administrator immediate visibility without another service. |
| Environments | `wrangler` environments (staging, production) with separate D1 databases and an `ENVIRONMENT` variable | Single environment | Safe rehearsal of migrations and releases; the deploy workflow takes the target as an input. |
| Quality gates | ESLint + security plugin, strict `tsc`, Vitest, `npm audit`, CodeQL | Manual review only | Automated, repeatable evidence for the course's static-analysis and testing criteria. |
