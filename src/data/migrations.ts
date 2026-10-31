/**
 * Relational schema (SQLite / Cloudflare D1). One statement per entry (D1-safe), applied in order and recorded in
 * `schema_migrations`, so the Worker can migrate itself on boot and tests can run the same SQL.
 */
export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core business schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('shipping_company','coast_guard','platform')),
        plan_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','suspended')), created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS registry_vessels (
        org_id TEXT NOT NULL REFERENCES organizations(id), mmsi TEXT NOT NULL, imo TEXT, name TEXT NOT NULL, vessel_type TEXT NOT NULL,
        flag TEXT NOT NULL, gross_tonnage INTEGER, owner TEXT, status TEXT NOT NULL CHECK (status IN ('active','retired')), created_at INTEGER NOT NULL,
        PRIMARY KEY (org_id, mmsi))`,
      `CREATE TABLE IF NOT EXISTS voyages (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), reference TEXT NOT NULL, mmsi TEXT NOT NULL, vessel_name TEXT NOT NULL,
        origin_port TEXT NOT NULL, destination_port TEXT NOT NULL, route_id TEXT, waypoints TEXT NOT NULL, etd INTEGER NOT NULL, eta INTEGER NOT NULL,
        cargo TEXT NOT NULL, status TEXT NOT NULL, risk_score INTEGER, risk_level TEXT, assessment TEXT, approvals_required TEXT NOT NULL,
        approvals TEXT NOT NULL, conditions TEXT, history TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_voyages_org_status ON voyages (org_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_voyages_status ON voyages (status)`,
      `CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, reporter TEXT NOT NULL, reporter_role TEXT NOT NULL, mmsi TEXT NOT NULL, vessel_name TEXT NOT NULL,
        lat REAL NOT NULL, lon REAL NOT NULL, category TEXT NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL,
        station_id TEXT NOT NULL, station_name TEXT NOT NULL, station_distance_nm INTEGER NOT NULL, desk TEXT NOT NULL, manual INTEGER NOT NULL,
        assignee TEXT, created_at INTEGER NOT NULL, ack_due_at INTEGER NOT NULL, resolve_due_at INTEGER NOT NULL, acked_at INTEGER, closed_at INTEGER,
        closure_code TEXT, escalation_level INTEGER NOT NULL DEFAULT 0, sla_breached INTEGER NOT NULL DEFAULT 0, history TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_cases_org_status ON cases (org_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_cases_desk_status ON cases (desk, status)`,
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL,
        active INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, webhook_id TEXT NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL, response_status INTEGER, error TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER)`,
      `CREATE INDEX IF NOT EXISTS idx_deliveries_org ON webhook_deliveries (org_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS usage (
        org_id TEXT NOT NULL, period TEXT NOT NULL, metric TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (org_id, period, metric))`,
    ],
  },
  {
    version: 2,
    name: 'supply chain: shipments',
    statements: [
      `CREATE TABLE IF NOT EXISTS shipments (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), reference TEXT NOT NULL, customer TEXT NOT NULL, commodity TEXT NOT NULL,
        cargo TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL, value_inr REAL NOT NULL, incoterm TEXT NOT NULL, origin_port TEXT NOT NULL,
        destination_port TEXT NOT NULL, required_by INTEGER NOT NULL, voyage_id TEXT REFERENCES voyages(id), status TEXT NOT NULL, delivery_risk TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, history TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_shipments_org ON shipments (org_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_shipments_voyage ON shipments (voyage_id)`,
    ],
  },
];
