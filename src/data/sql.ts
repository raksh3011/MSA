/** SQL implementation of the repository (Cloudflare D1 or any SQLite adapter with the same shape). */
import type { ApiKey, CaseRecord, Contract, Delivery, Invoice, Organization, ReportSnapshot, RegistryVessel, Shipment, UsageMetric, Voyage, Webhook } from '../domain/types';
import { MIGRATIONS } from './migrations';
import type { CaseFilter, Repo } from './repo';

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface SqlDb {
  prepare(sql: string): SqlStatement;
}

type Row = Record<string, unknown>;
const json = (v: unknown): string => JSON.stringify(v ?? null);
const parse = <T>(s: unknown): T => JSON.parse(String(s)) as T;
const nul = (v: unknown): unknown => (v === undefined ? null : v);
const opt = <T>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : (v as T));

/** Apply pending migrations; safe to call on every boot. */
export async function migrate(db: SqlDb): Promise<number> {
  await db.prepare('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)').run();
  const done = new Set((await db.prepare('SELECT version FROM schema_migrations').all<{ version: number }>()).results.map((r) => r.version));
  let applied = 0;
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    for (const sql of m.statements) await db.prepare(sql).run();
    await db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').bind(m.version, m.name, Date.now()).run();
    applied++;
  }
  return applied;
}

const orgOf = (r: Row): Organization => ({ id: r.id as string, name: r.name as string, kind: r.kind as Organization['kind'], planId: r.plan_id as Organization['planId'], status: r.status as Organization['status'], createdAt: r.created_at as number });

const vesselOf = (r: Row): RegistryVessel => ({
  orgId: r.org_id as string, mmsi: r.mmsi as string, imo: opt(r.imo), name: r.name as string, vesselType: r.vessel_type as string, flag: r.flag as string,
  grossTonnage: opt(r.gross_tonnage), owner: opt(r.owner), status: r.status as RegistryVessel['status'], createdAt: r.created_at as number,
});

const voyageOf = (r: Row): Voyage => ({
  id: r.id as string, orgId: r.org_id as string, reference: r.reference as string, mmsi: r.mmsi as string, vesselName: r.vessel_name as string,
  originPort: r.origin_port as string, destinationPort: r.destination_port as string, routeId: opt(r.route_id), waypoints: parse(r.waypoints),
  etd: r.etd as number, eta: r.eta as number, cargo: r.cargo as Voyage['cargo'], status: r.status as Voyage['status'],
  assessment: r.assessment ? parse(r.assessment) : undefined, approvalsRequired: parse(r.approvals_required), approvals: parse(r.approvals),
  conditions: opt(r.conditions), history: parse(r.history), createdBy: r.created_by as string, createdAt: r.created_at as number, updatedAt: r.updated_at as number,
});

const shipmentOf = (r: Row): Shipment => ({
  id: r.id as string, orgId: r.org_id as string, reference: r.reference as string, customer: r.customer as string, commodity: r.commodity as string,
  cargo: r.cargo as Shipment['cargo'], quantity: r.quantity as number, unit: r.unit as string, valueInr: r.value_inr as number, incoterm: r.incoterm as string,
  originPort: r.origin_port as string, destinationPort: r.destination_port as string, requiredBy: r.required_by as number, voyageId: opt(r.voyage_id),
  status: r.status as Shipment['status'], deliveryRisk: r.delivery_risk as Shipment['deliveryRisk'], createdBy: r.created_by as string,
  createdAt: r.created_at as number, updatedAt: r.updated_at as number, history: parse(r.history),
});

const caseOf = (r: Row): CaseRecord => ({
  id: r.id as string, orgId: r.org_id as string, reporter: r.reporter as string, reporterRole: r.reporter_role as CaseRecord['reporterRole'],
  mmsi: r.mmsi as string, vesselName: r.vessel_name as string, lat: r.lat as number, lon: r.lon as number, category: r.category as CaseRecord['category'],
  note: r.note as string, status: r.status as CaseRecord['status'], priority: r.priority as CaseRecord['priority'],
  station: { id: r.station_id as string, name: r.station_name as string, distanceNm: r.station_distance_nm as number, desk: r.desk as string },
  manual: r.manual === 1, assignee: opt(r.assignee), createdAt: r.created_at as number, ackDueAt: r.ack_due_at as number, resolveDueAt: r.resolve_due_at as number,
  ackedAt: opt(r.acked_at), closedAt: opt(r.closed_at), closureCode: opt(r.closure_code), escalationLevel: r.escalation_level as CaseRecord['escalationLevel'],
  slaBreached: r.sla_breached === 1, history: parse(r.history), postIncident: r.post_incident ? parse(r.post_incident) : undefined,
});

const contractOf = (r: Row): Contract => ({
  orgId: r.org_id as string, supportTier: r.support_tier as Contract['supportTier'], termMonths: r.term_months as number, startsAt: r.starts_at as number, renewsAt: r.renews_at as number,
  autoRenew: r.auto_renew === 1, paymentTermsDays: r.payment_terms_days as number, slaUptimePct: r.sla_uptime_pct as number, billingContact: r.billing_contact as string, gstin: r.gstin as string,
  reportFrequency: r.report_frequency as Contract['reportFrequency'], retentionMonths: r.retention_months as number, signedBy: r.signed_by as string, signedAt: r.signed_at as number,
});

const invoiceOf = (r: Row): Invoice => ({
  id: r.id as string, orgId: r.org_id as string, number: r.number as string, period: r.period as string, issuedAt: r.issued_at as number, dueAt: r.due_at as number, lines: parse(r.lines),
  subtotalInr: r.subtotal_inr as number, gstInr: r.gst_inr as number, totalInr: r.total_inr as number, status: r.status as Invoice['status'], payments: parse(r.payments), paidAt: opt(r.paid_at),
});

const reportOf = (r: Row): ReportSnapshot => ({ id: r.id as string, orgId: r.org_id as string, kind: r.kind as ReportSnapshot['kind'], period: r.period as string, generatedAt: r.generated_at as number, generatedBy: r.generated_by as string, payload: parse(r.payload) });

const keyOf = (r: Row): ApiKey => ({
  id: r.id as string, orgId: r.org_id as string, name: r.name as string, prefix: r.prefix as string, hash: r.hash as string, scopes: parse(r.scopes),
  createdBy: r.created_by as string, createdAt: r.created_at as number, lastUsedAt: opt(r.last_used_at), revokedAt: opt(r.revoked_at),
});

const hookOf = (r: Row): Webhook => ({ id: r.id as string, orgId: r.org_id as string, url: r.url as string, secret: r.secret as string, events: parse(r.events), active: r.active === 1, createdAt: r.created_at as number });

const deliveryOf = (r: Row): Delivery => ({
  id: r.id as string, orgId: r.org_id as string, webhookId: r.webhook_id as string, event: r.event as Delivery['event'], payload: r.payload as string,
  status: r.status as Delivery['status'], attempts: r.attempts as number, responseStatus: opt(r.response_status), error: opt(r.error), createdAt: r.created_at as number, deliveredAt: opt(r.delivered_at),
});

export class SqlRepo implements Repo {
  constructor(private readonly db: SqlDb) {}

  private q(sql: string, ...v: unknown[]): SqlStatement {
    return this.db.prepare(sql).bind(...v.map(nul));
  }
  private async rows<T>(sql: string, map: (r: Row) => T, ...v: unknown[]): Promise<T[]> {
    return (await this.q(sql, ...v).all<Row>()).results.map(map);
  }
  private async one<T>(sql: string, map: (r: Row) => T, ...v: unknown[]): Promise<T | undefined> {
    const r = await this.q(sql, ...v).first<Row>();
    return r ? map(r) : undefined;
  }

  orgs = {
    get: (id: string) => this.one('SELECT * FROM organizations WHERE id = ?', orgOf, id),
    list: () => this.rows('SELECT * FROM organizations ORDER BY name', orgOf),
    insert: async (o: Organization) => void (await this.q('INSERT INTO organizations (id, name, kind, plan_id, status, created_at) VALUES (?,?,?,?,?,?)', o.id, o.name, o.kind, o.planId, o.status, o.createdAt).run()),
    update: async (o: Organization) => void (await this.q('UPDATE organizations SET name = ?, kind = ?, plan_id = ?, status = ? WHERE id = ?', o.name, o.kind, o.planId, o.status, o.id).run()),
  };

  registry = {
    list: (orgId: string) => this.rows('SELECT * FROM registry_vessels WHERE org_id = ? ORDER BY name', vesselOf, orgId),
    get: (orgId: string, mmsi: string) => this.one('SELECT * FROM registry_vessels WHERE org_id = ? AND mmsi = ?', vesselOf, orgId, mmsi),
    upsert: async (v: RegistryVessel) =>
      void (await this.q(
        `INSERT INTO registry_vessels (org_id, mmsi, imo, name, vessel_type, flag, gross_tonnage, owner, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (org_id, mmsi) DO UPDATE SET imo = excluded.imo, name = excluded.name, vessel_type = excluded.vessel_type, flag = excluded.flag,
           gross_tonnage = excluded.gross_tonnage, owner = excluded.owner, status = excluded.status`,
        v.orgId, v.mmsi, v.imo, v.name, v.vesselType, v.flag, v.grossTonnage, v.owner, v.status, v.createdAt,
      ).run()),
    remove: async (orgId: string, mmsi: string) => {
      const before = await this.one('SELECT mmsi FROM registry_vessels WHERE org_id = ? AND mmsi = ?', (r) => r.mmsi, orgId, mmsi);
      if (!before) return false;
      await this.q('DELETE FROM registry_vessels WHERE org_id = ? AND mmsi = ?', orgId, mmsi).run();
      return true;
    },
    count: async (orgId: string) => (await this.one("SELECT COUNT(*) AS n FROM registry_vessels WHERE org_id = ? AND status = 'active'", (r) => r.n as number, orgId)) ?? 0,
  };

  voyages = {
    get: (orgId: string, id: string) => this.one('SELECT * FROM voyages WHERE org_id = ? AND id = ?', voyageOf, orgId, id),
    list: (orgId: string, status?: Voyage['status']) =>
      status
        ? this.rows('SELECT * FROM voyages WHERE org_id = ? AND status = ? ORDER BY updated_at DESC', voyageOf, orgId, status)
        : this.rows('SELECT * FROM voyages WHERE org_id = ? ORDER BY updated_at DESC', voyageOf, orgId),
    listActive: () => this.rows("SELECT * FROM voyages WHERE status = 'active'", voyageOf),
    insert: async (v: Voyage) =>
      void (await this.q(
        `INSERT INTO voyages (id, org_id, reference, mmsi, vessel_name, origin_port, destination_port, route_id, waypoints, etd, eta, cargo, status, risk_score, risk_level,
          assessment, approvals_required, approvals, conditions, history, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        v.id, v.orgId, v.reference, v.mmsi, v.vesselName, v.originPort, v.destinationPort, v.routeId, json(v.waypoints), v.etd, v.eta, v.cargo, v.status,
        v.assessment?.score, v.assessment?.level, v.assessment ? json(v.assessment) : null, json(v.approvalsRequired), json(v.approvals), v.conditions, json(v.history),
        v.createdBy, v.createdAt, v.updatedAt,
      ).run()),
    update: async (v: Voyage) =>
      void (await this.q(
        `UPDATE voyages SET reference = ?, mmsi = ?, vessel_name = ?, origin_port = ?, destination_port = ?, route_id = ?, waypoints = ?, etd = ?, eta = ?, cargo = ?, status = ?,
          risk_score = ?, risk_level = ?, assessment = ?, approvals_required = ?, approvals = ?, conditions = ?, history = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
        v.reference, v.mmsi, v.vesselName, v.originPort, v.destinationPort, v.routeId, json(v.waypoints), v.etd, v.eta, v.cargo, v.status,
        v.assessment?.score, v.assessment?.level, v.assessment ? json(v.assessment) : null, json(v.approvalsRequired), json(v.approvals), v.conditions, json(v.history),
        v.updatedAt, v.id, v.orgId,
      ).run()),
    countCreatedBetween: async (orgId: string, from: number, to: number) =>
      (await this.one('SELECT COUNT(*) AS n FROM voyages WHERE org_id = ? AND created_at >= ? AND created_at < ?', (r) => r.n as number, orgId, from, to)) ?? 0,
  };

  shipments = {
    get: (orgId: string, id: string) => this.one('SELECT * FROM shipments WHERE org_id = ? AND id = ?', shipmentOf, orgId, id),
    list: (orgId: string) => this.rows('SELECT * FROM shipments WHERE org_id = ? ORDER BY required_by', shipmentOf, orgId),
    listOpen: () => this.rows("SELECT * FROM shipments WHERE status IN ('booked','in_transit')", shipmentOf),
    insert: async (x: Shipment) =>
      void (await this.q(
        `INSERT INTO shipments (id, org_id, reference, customer, commodity, cargo, quantity, unit, value_inr, incoterm, origin_port, destination_port, required_by, voyage_id, status,
          delivery_risk, created_by, created_at, updated_at, history) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        x.id, x.orgId, x.reference, x.customer, x.commodity, x.cargo, x.quantity, x.unit, x.valueInr, x.incoterm, x.originPort, x.destinationPort, x.requiredBy, x.voyageId, x.status,
        x.deliveryRisk, x.createdBy, x.createdAt, x.updatedAt, json(x.history),
      ).run()),
    update: async (x: Shipment) =>
      void (await this.q(
        `UPDATE shipments SET reference = ?, customer = ?, commodity = ?, cargo = ?, quantity = ?, unit = ?, value_inr = ?, incoterm = ?, origin_port = ?, destination_port = ?, required_by = ?,
          voyage_id = ?, status = ?, delivery_risk = ?, updated_at = ?, history = ? WHERE id = ? AND org_id = ?`,
        x.reference, x.customer, x.commodity, x.cargo, x.quantity, x.unit, x.valueInr, x.incoterm, x.originPort, x.destinationPort, x.requiredBy, x.voyageId, x.status, x.deliveryRisk,
        x.updatedAt, json(x.history), x.id, x.orgId,
      ).run()),
  };

  cases = {
    get: (id: string) => this.one('SELECT * FROM cases WHERE id = ?', caseOf, id),
    list: (f: CaseFilter = {}) => {
      const where: string[] = [];
      const args: unknown[] = [];
      if (f.orgId) {
        where.push('org_id = ?');
        args.push(f.orgId);
      }
      if (f.status) {
        where.push('status = ?');
        args.push(f.status);
      }
      if (f.desk) {
        where.push('desk = ?');
        args.push(f.desk);
      }
      return this.rows(`SELECT * FROM cases ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 500`, caseOf, ...args);
    },
    listOpen: () => this.rows("SELECT * FROM cases WHERE status <> 'closed'", caseOf),
    insert: async (c: CaseRecord) =>
      void (await this.q(
        `INSERT INTO cases (id, org_id, reporter, reporter_role, mmsi, vessel_name, lat, lon, category, note, status, priority, station_id, station_name, station_distance_nm, desk, manual,
          assignee, created_at, ack_due_at, resolve_due_at, acked_at, closed_at, closure_code, escalation_level, sla_breached, history) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        c.id, c.orgId, c.reporter, c.reporterRole, c.mmsi, c.vesselName, c.lat, c.lon, c.category, c.note, c.status, c.priority, c.station.id, c.station.name, c.station.distanceNm,
        c.station.desk, c.manual ? 1 : 0, c.assignee, c.createdAt, c.ackDueAt, c.resolveDueAt, c.ackedAt, c.closedAt, c.closureCode, c.escalationLevel, c.slaBreached ? 1 : 0, json(c.history),
      ).run()),
    update: async (c: CaseRecord) =>
      void (await this.q(
        `UPDATE cases SET status = ?, assignee = ?, acked_at = ?, closed_at = ?, closure_code = ?, escalation_level = ?, sla_breached = ?, history = ?, post_incident = ? WHERE id = ?`,
        c.status, c.assignee, c.ackedAt, c.closedAt, c.closureCode, c.escalationLevel, c.slaBreached ? 1 : 0, json(c.history), c.postIncident ? json(c.postIncident) : null, c.id,
      ).run()),
  };

  apiKeys = {
    insert: async (k: ApiKey) => void (await this.q('INSERT INTO api_keys (id, org_id, name, prefix, hash, scopes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)', k.id, k.orgId, k.name, k.prefix, k.hash, json(k.scopes), k.createdBy, k.createdAt).run()),
    findByHash: (hash: string) => this.one('SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL', keyOf, hash),
    list: (orgId: string) => this.rows('SELECT * FROM api_keys WHERE org_id = ? ORDER BY created_at DESC', keyOf, orgId),
    revoke: async (orgId: string, id: string, ts: number) => {
      const k = await this.one('SELECT id FROM api_keys WHERE org_id = ? AND id = ? AND revoked_at IS NULL', (r) => r.id, orgId, id);
      if (!k) return false;
      await this.q('UPDATE api_keys SET revoked_at = ? WHERE id = ?', ts, id).run();
      return true;
    },
    touch: async (id: string, ts: number) => void (await this.q('UPDATE api_keys SET last_used_at = ? WHERE id = ?', ts, id).run()),
  };

  webhooks = {
    list: (orgId: string) => this.rows('SELECT * FROM webhooks WHERE org_id = ? ORDER BY created_at DESC', hookOf, orgId),
    get: (orgId: string, id: string) => this.one('SELECT * FROM webhooks WHERE org_id = ? AND id = ?', hookOf, orgId, id),
    insert: async (w: Webhook) => void (await this.q('INSERT INTO webhooks (id, org_id, url, secret, events, active, created_at) VALUES (?,?,?,?,?,?,?)', w.id, w.orgId, w.url, w.secret, json(w.events), w.active ? 1 : 0, w.createdAt).run()),
    remove: async (orgId: string, id: string) => {
      const w = await this.one('SELECT id FROM webhooks WHERE org_id = ? AND id = ?', (r) => r.id, orgId, id);
      if (!w) return false;
      await this.q('DELETE FROM webhooks WHERE id = ?', id).run();
      return true;
    },
  };

  deliveries = {
    insert: async (d: Delivery) =>
      void (await this.q('INSERT INTO webhook_deliveries (id, org_id, webhook_id, event, payload, status, attempts, response_status, error, created_at, delivered_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', d.id, d.orgId, d.webhookId, d.event, d.payload, d.status, d.attempts, d.responseStatus, d.error, d.createdAt, d.deliveredAt).run()),
    update: async (d: Delivery) => void (await this.q('UPDATE webhook_deliveries SET status = ?, attempts = ?, response_status = ?, error = ?, delivered_at = ? WHERE id = ?', d.status, d.attempts, d.responseStatus, d.error, d.deliveredAt, d.id).run()),
    list: (orgId: string, limit: number) => this.rows('SELECT * FROM webhook_deliveries WHERE org_id = ? ORDER BY created_at DESC LIMIT ?', deliveryOf, orgId, limit),
    purgeBefore: async (orgId: string, before: number) => {
      const n = (await this.one('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE org_id = ? AND created_at < ?', (r) => r.n as number, orgId, before)) ?? 0;
      if (n > 0) await this.q('DELETE FROM webhook_deliveries WHERE org_id = ? AND created_at < ?', orgId, before).run();
      return n;
    },
  };

  contracts = {
    get: (orgId: string) => this.one('SELECT * FROM contracts WHERE org_id = ?', contractOf, orgId),
    list: () => this.rows('SELECT * FROM contracts', contractOf),
    upsert: async (c: Contract) =>
      void (await this.q(
        `INSERT INTO contracts (org_id, support_tier, term_months, starts_at, renews_at, auto_renew, payment_terms_days, sla_uptime_pct, billing_contact, gstin, report_frequency, retention_months, signed_by, signed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (org_id) DO UPDATE SET support_tier = excluded.support_tier, term_months = excluded.term_months, starts_at = excluded.starts_at, renews_at = excluded.renews_at, auto_renew = excluded.auto_renew,
           payment_terms_days = excluded.payment_terms_days, sla_uptime_pct = excluded.sla_uptime_pct, billing_contact = excluded.billing_contact, gstin = excluded.gstin,
           report_frequency = excluded.report_frequency, retention_months = excluded.retention_months, signed_by = excluded.signed_by, signed_at = excluded.signed_at`,
        c.orgId, c.supportTier, c.termMonths, c.startsAt, c.renewsAt, c.autoRenew ? 1 : 0, c.paymentTermsDays, c.slaUptimePct, c.billingContact, c.gstin, c.reportFrequency, c.retentionMonths, c.signedBy, c.signedAt,
      ).run()),
  };

  invoices = {
    get: (orgId: string, id: string) => this.one('SELECT * FROM invoices WHERE org_id = ? AND id = ?', invoiceOf, orgId, id),
    getByPeriod: (orgId: string, period: string) => this.one('SELECT * FROM invoices WHERE org_id = ? AND period = ?', invoiceOf, orgId, period),
    list: (orgId: string) => this.rows('SELECT * FROM invoices WHERE org_id = ? ORDER BY period DESC', invoiceOf, orgId),
    listAll: () => this.rows('SELECT * FROM invoices ORDER BY period DESC', invoiceOf),
    insert: async (i: Invoice) =>
      void (await this.q('INSERT INTO invoices (id, org_id, number, period, issued_at, due_at, lines, subtotal_inr, gst_inr, total_inr, status, payments, paid_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        i.id, i.orgId, i.number, i.period, i.issuedAt, i.dueAt, json(i.lines), i.subtotalInr, i.gstInr, i.totalInr, i.status, json(i.payments), i.paidAt).run()),
    update: async (i: Invoice) => void (await this.q('UPDATE invoices SET status = ?, payments = ?, paid_at = ? WHERE id = ? AND org_id = ?', i.status, json(i.payments), i.paidAt, i.id, i.orgId).run()),
  };

  reports = {
    get: (orgId: string, id: string) => this.one('SELECT * FROM reports WHERE org_id = ? AND id = ?', reportOf, orgId, id),
    list: (orgId: string) => this.rows('SELECT * FROM reports WHERE org_id = ? ORDER BY generated_at DESC LIMIT 200', reportOf, orgId),
    insert: async (r: ReportSnapshot) => void (await this.q('INSERT INTO reports (id, org_id, kind, period, generated_at, generated_by, payload) VALUES (?,?,?,?,?,?,?)', r.id, r.orgId, r.kind, r.period, r.generatedAt, r.generatedBy, json(r.payload)).run()),
    purgeBefore: async (orgId: string, before: number) => {
      const n = (await this.one('SELECT COUNT(*) AS n FROM reports WHERE org_id = ? AND generated_at < ?', (r) => r.n as number, orgId, before)) ?? 0;
      if (n > 0) await this.q('DELETE FROM reports WHERE org_id = ? AND generated_at < ?', orgId, before).run();
      return n;
    },
  };

  usage = {
    increment: async (orgId: string, period: string, metric: UsageMetric, by = 1) => {
      await this.q('INSERT INTO usage (org_id, period, metric, count) VALUES (?,?,?,?) ON CONFLICT (org_id, period, metric) DO UPDATE SET count = count + excluded.count', orgId, period, metric, by).run();
      return (await this.one('SELECT count FROM usage WHERE org_id = ? AND period = ? AND metric = ?', (r) => r.count as number, orgId, period, metric)) ?? by;
    },
    get: async (orgId: string, period: string, metric: UsageMetric) => (await this.one('SELECT count FROM usage WHERE org_id = ? AND period = ? AND metric = ?', (r) => r.count as number, orgId, period, metric)) ?? 0,
  };
}
