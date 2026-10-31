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
| Quality gates | ESLint + security plugin, strict `tsc`, Vitest, `npm audit`, CodeQL | Manual review only | Automated, repeatable evidence for the course's static-analysis and testing criteria. |
