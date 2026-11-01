# ORVMS — Software Requirements Specification

**Product:** Ocean Risk and Vessel Monitoring System (ORVMS) — a multi-tenant maritime risk and supply-chain visibility platform.
**Customers:** shipping companies (B2B tenants) and the Indian Coast Guard (government tenant). **Operator:** the platform owner.

## 1. Business problem (Problem → Root cause → Impact → Target outcome)

| | |
|---|---|
| **Problem** | Shipping companies and coast guards manage voyage risk, suspicious-vessel reports and customer delivery commitments with phone calls, e-mail and spreadsheets. |
| **Root cause** | Live vessel data, maritime zone rules, approvals, incident handling and customer shipments live in separate tools; no shared, auditable record connects a *risk at sea* to a *voyage* to a *customer delivery*. |
| **Impact** | Slow, inconsistent decisions; voyages sail through high-risk areas without documented approval; customers are told about delays after the fact; reports to the Coast Guard have no owner, deadline or audit trail; insurers cannot be shown evidence. |
| **Target outcome** | Voyage risk assessed and approved within minutes with a four-eyes audit trail; every delivery commitment shown against a live ETA and cargo value at risk; every report routed to the nearest controller and worked against an SLA with automatic escalation; ERP/TMS systems notified by signed webhooks. |

## 2. Actors and roles

| Role | Organisation type | Responsibilities |
|---|---|---|
| `operator` | Shipping company | Maintains fleet registry, plans voyages, books shipments, reports suspicious vessels |
| `risk_officer` | Shipping company | Approves / rejects / returns voyages (four-eyes) |
| `org_admin` | Shipping company | Users, API keys, webhooks, second approver of critical voyages, retires vessels |
| `analyst` (controller) | Coast Guard | Triage alerts, work cases against SLAs, assign and close, geofences |
| `admin` | Platform operator | Onboards customer organisations, changes plans, risk policy, audit trail |
| API client | External system | Reads fleet, alerts, voyages, shipments; creates draft voyages (API key) |

## 3. Functional requirements

| ID | Requirement | Module |
|---|---|---|
| FR-1 | The system shall ingest live AIS (aisstream.io, Digitraffic) and a labelled synthetic feed, normalise and validate every position report, and keep current vessel state. | `core/hub`, `worker/` |
| FR-2 | The system shall classify vessels as Indian / foreign / unknown and raise graded alerts for EEZ approach, EEZ, contiguous-zone and territorial-sea entry, presence, dark vessels, spoofing, and Indian vessels entering critical zones or foreign waters. | `core/engine` |
| FR-3 | The system shall support multiple customer organisations (tenants) with isolated data; every user belongs to exactly one organisation and can only read and change that organisation's records. | `api`, `data/repo` |
| FR-4 | An organisation admin shall maintain a fleet registry (add, edit, retire, CSV import) with validation, within the organisation's plan quota. | `services/org` |
| FR-5 | An operator shall plan a voyage (vessel, route, cargo, ETD/ETA); the system shall compute a route risk assessment (score, level, factors, recommended controls) using zone exposure, cargo, speed and live incidents. | `domain/voyage` |
| FR-6 | Voyages shall follow an approval workflow: low risk auto-approves; medium/high needs a risk officer; critical needs a risk officer and an organisation admin; the preparer cannot approve (four-eyes); decisions require notes where specified; every step is recorded. | `domain/voyage` |
| FR-7 | Active voyages shall be monitored against live positions, raising alerts for route deviation and unplanned risk-area exposure. | `services/voyages` |
| FR-8 | An operator shall book customer shipments (reference, customer, commodity, value, incoterm, delivery commitment) and allocate them to voyages. | `services/shipments` |
| FR-9 | The system shall project a live ETA for each shipment, grade delivery risk (on track / at risk / late / no vessel), compute cargo value passing through risk areas, give advisories, and keep shipment status in step with its voyage. | `domain/supplychain` |
| FR-10 | Any user shall be able to report a suspicious vessel or an unidentified boat at a position; the system shall open a case with a priority, route it to the nearest Coast Guard station and controller desk, add the vessel to the reporter's set and notify the desk. | `services/cases` |
| FR-11 | Cases shall carry SLA deadlines by priority; controllers assign, acknowledge, investigate and close with a closure code; overdue cases shall escalate automatically (desk lead, then regional controller) with an alert and an audit record. | `domain/cases` |
| FR-12 | Each organisation shall have a subscription plan with limits (vessels, users, voyages/month, API calls/month, integrations); the system shall meter usage and show an invoice estimate. | `domain/plans` |
| FR-13 | An organisation admin shall create API keys (shown once, stored hashed, scoped) and webhooks; the integration API shall authenticate by key, enforce scopes and the monthly quota. | `services/org`, `api/routes` |
| FR-14 | The system shall deliver domain events (`voyage.status_changed`, `voyage.deviation`, `case.*`, `shipment.at_risk`, `alert.created`) to subscribed webhooks, HMAC-signed, retried up to three times, with a delivery log. | `domain/webhooks` |
| FR-15 | The platform admin shall onboard customer organisations, change plans, suspend accounts, edit risk policy and read the audit trail. | `api/routes` |
| FR-16 | The system shall export an organisation's alerts as CSV and keep a tamper-evident audit trail of sign-ins, workflow actions, administration and integration changes. | `api`, `core/hub` |
| FR-17 | Each customer shall have a contract record (support tier, term and renewal, payment terms, availability SLA, billing contact, GSTIN); the customer edits its billing details and the platform administrator edits the commercial terms. | `services/billing` |
| FR-18 | The system shall issue a monthly invoice per customer (subscription + support add-on + usage-based overage, GST at 18 %), idempotently per period, from a scheduled month-end run or on demand, and notify the customer by webhook. | `domain/billing`, `services/background` |
| FR-19 | The customer shall view invoices, download them as CSV or print them as PDF, and pay through a sandbox payment gateway (UPI, card, net banking); overdue status and days overdue are derived from the due date. | `services/billing`, `web/business` |
| FR-20 | The platform administrator shall see recurring revenue, receivables, collections and customer mix. | `services/billing` |
| FR-21 | The system shall generate a monthly risk and compliance report pack per customer (voyages, approvals, deliveries, incidents, alerts, approval-control checks, posture score) as an immutable snapshot, on demand or on a schedule, exportable as CSV or PDF. | `domain/reports`, `services/reports` |
| FR-22 | The system shall apply a per-customer retention setting to stored reports and webhook delivery logs, and let a customer export all of its data (portability). | `services/reports`, `services/ops` |
| FR-23 | Controllers shall file a post-incident report (summary, findings, actions, lessons) for closed cases; the system shall report service levels (SLA compliance, response times, outcomes, desk performance). | `services/cases`, `domain/reports` |
| FR-24 | The platform administrator shall see an operations console: version and environment, storage and schema version, feed health, scheduled-job status, webhook success rate, record counts and a structured event log, and shall be able to download a full platform backup. | `services/ops` |
| FR-25 | Customer users shall see an executive overview that joins fleet, voyages, shipments, incidents, plan usage and invoices, with a prioritised list of items needing attention. | `services/overview` |

## 4. Non-functional requirements

| ID | Requirement | How it is met / verified |
|---|---|---|
| NFR-1 Security | Passwords hashed (PBKDF2-SHA256); signed expiring tokens; role-based access on every route; per-tenant scoping in every tenant query; API keys stored as SHA-256 hashes; webhook targets restricted to public HTTPS; rate limiting on login and reporting; input validation; CSV formula-injection protection; no `innerHTML` in the UI. | RBAC/isolation tests, webhook URL tests, ESLint security plugin, CodeQL |
| NFR-2 Data integrity | Business records are stored relationally with referential integrity, constraints and versioned migrations; workflow transitions are validated server-side. | SQL contract tests, migration tests, state-machine tests |
| NFR-3 Portability | The same business logic runs on Cloudflare Workers + D1 and in tests, behind one repository interface. | Contract suite runs against `MemoryRepo` and `SqlRepo`; API suite runs against both |
| NFR-4 Performance | Live alerting must keep up with the feed: per-vessel throttling, bounded memory, viewport-efficient canvas rendering of thousands of vessels. | Throttle and eviction tests; manual check with the global live feed |
| NFR-5 Availability / cost | Must run on free tiers without an always-on server; upstream feed connections only while users are connected. | Serverless architecture; documented limits |
| NFR-6 Auditability | Every business action records actor, time and detail; approvals and case history are immutable timelines. | Audit tests |
| NFR-7 Maintainability | Layered modules (core → domain → services → api → UI), strict TypeScript, ≥ 150 automated tests, static analysis in CI. | `npm test`, `npm run lint`, `npm run typecheck` |
| NFR-8 Usability | Role-specific navigation, accessible controls, keyboard search, responsive layout, plain-language alerts and advisories. | Manual UI verification |
| NFR-9 Honest data | Zones are *modelled*, synthetic vessels are always labelled, stations are approximate; the product is decision support, not a navigation or legal tool. | UI disclaimers, README |
| NFR-11 Operability | Structured JSON logs, a health console, scheduled housekeeping (billing, reports, retention), a documented backup and restore procedure, and separate staging and production environments. | `docs/OPERATIONS.md`, ops tests, `wrangler.toml` |
| NFR-10 Interoperability | A documented REST integration API and signed webhooks let ERP/TMS systems consume risk events. | `docs/openapi.yaml`, integration tests |

## 5. Out of scope
Real payment processing (the gateway is a sandbox), tax filing, real routing engine, official EEZ gazette limits, distress/SAR communications, mobile apps.

## 6. Traceability
Each FR maps to a module above and to tests in `tests/unit/domain.test.ts`, `tests/unit/billing.test.ts`, `tests/unit/engine.test.ts`, `tests/unit/repo.test.ts`, `tests/api/api.test.ts`, `tests/api/enterprise.test.ts` and `tests/api/business.test.ts` (the last two run against both storage implementations).
