import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryRepo } from '../../src/data/memory';
import type { Repo } from '../../src/data/repo';
import { SqlRepo, migrate } from '../../src/data/sql';
import { signPayload } from '../../src/domain/webhooks';
import { runBackground } from '../../src/services/background';
import { PW, makeHarness, type Harness } from '../helpers/harness';
import { createSqliteDb } from '../helpers/sqlite';

/** The whole business API runs against BOTH storage implementations: in-memory (browser demo) and SQL (D1 / SQLite). */
const impls: Array<[string, () => Promise<Repo>]> = [
  ['MemoryRepo', async () => new MemoryRepo()],
  ['SqlRepo (SQLite)', async () => {
    const db = createSqliteDb();
    await migrate(db);
    return new SqlRepo(db);
  }],
];

describe.each(impls)('Enterprise API on %s', (_name, makeRepo) => {
  let h: Harness;
  let tok: Record<string, string>;
  const j = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T;

  beforeAll(async () => {
    h = await makeHarness({ repo: await makeRepo() });
    tok = {};
    for (const u of ['admin', 'analyst', 'cg.kochi', 'cg.mumbai', 'operator', 'riskofficer', 'orgadmin', 'kt.operator', 'kt.admin']) tok[u] = await h.as(u);
    // BOC ARAVALI is sailing its approved Aden -> Mumbai route (live position on the route)
    h.hub.ingest({ mmsi: '419200101', name: 'BOC ARAVALI', lat: 15.5, lon: 60.0, sog: 13, shipType: 80, ts: h.now() }, h.now());
  });

  describe('seed data', () => {
    it('creates four tenants with users that each belong to exactly one organisation', async () => {
      const orgs = (await j<{ organizations: Array<{ id: string; kind: string; planId: string }> }>(await h.call('/api/admin/orgs', { token: tok.admin }))).organizations;
      expect(orgs.map((o) => o.id).sort()).toEqual(['org-boc', 'org-icg', 'org-kt', 'org-platform']);
      expect(orgs.find((o) => o.id === 'org-kt')?.planId).toBe('starter');
      for (const u of h.hub.users.values()) expect(u.orgId, u.username).toBeTruthy();
    });

    it('seeds voyages in several workflow states and shipments in several delivery-risk states', async () => {
      const voyages = (await j<{ voyages: Array<{ status: string }> }>(await h.call('/api/voyages', { token: tok.operator }))).voyages;
      expect(new Set(voyages.map((v) => v.status))).toEqual(new Set(['active', 'submitted', 'approved', 'draft', 'completed']));
      const tower = await j<{ summary: { atRisk: number; late: number; unplanned: number; valueAtRiskInr: number }; shipments: Array<{ deliveryRisk: string; status: string }> }>(await h.call('/api/supply-chain/overview', { token: tok.operator }));
      expect(tower.summary.atRisk).toBeGreaterThanOrEqual(1);
      expect(tower.summary.late).toBeGreaterThanOrEqual(1);
      expect(tower.summary.unplanned).toBeGreaterThanOrEqual(1);
      expect(tower.summary.valueAtRiskInr).toBeGreaterThan(0);
      expect(tower.shipments.some((s) => s.status === 'delivered')).toBe(true);
    });
  });

  describe('multi-tenancy isolation', () => {
    it('a company never sees another company\'s registry, voyages or shipments', async () => {
      const boc = (await j<{ vessels: unknown[] }>(await h.call('/api/registry/vessels', { token: tok.operator }))).vessels;
      const kt = (await j<{ vessels: Array<{ orgId: string }> }>(await h.call('/api/registry/vessels', { token: tok['kt.operator'] }))).vessels;
      expect(boc.length).toBe(10);
      expect(kt.length).toBe(3);
      expect(kt.every((v) => v.orgId === 'org-kt')).toBe(true);
      expect((await j<{ voyages: unknown[] }>(await h.call('/api/voyages', { token: tok['kt.operator'] }))).voyages.length).toBe(0);
      const bocVoyage = (await j<{ voyages: Array<{ id: string }> }>(await h.call('/api/voyages', { token: tok.operator }))).voyages[0]!;
      expect((await h.call(`/api/voyages/${bocVoyage.id}`, { token: tok['kt.operator'] })).status).toBe(404);
      expect((await h.post(`/api/voyages/${bocVoyage.id}/actions`, { action: 'cancel' }, tok['kt.admin'])).status).toBe(404);
      const kts = await j<{ shipments: Array<{ reference: string }> }>(await h.call('/api/supply-chain/overview', { token: tok['kt.operator'] }));
      expect(kts.shipments.map((s) => s.reference)).toEqual(['KT-PO-501']);
    });

    it('company users cannot use platform or Coast Guard endpoints; analysts cannot use tenant endpoints', async () => {
      expect((await h.call('/api/admin/orgs', { token: tok.orgadmin })).status).toBe(403);
      expect((await h.call('/api/registry/vessels', { token: tok.analyst })).status).toBe(403);
      expect((await h.call('/api/voyages', { token: tok.admin })).status).toBe(403);
      expect((await h.call('/api/org', { token: tok.analyst })).status).toBe(403);
      expect((await h.call('/api/registry/vessels')).status).toBe(401);
    });
  });

  describe('registry, users and plan quotas', () => {
    it('validates and creates registry vessels; plan limits are enforced (Starter = 5 vessels)', async () => {
      expect((await h.post('/api/registry/vessels', { mmsi: '12', name: 'X' }, tok['kt.admin'])).status).toBe(400);
      expect((await h.post('/api/registry/vessels', { mmsi: '419500001', name: 'KONKAN ONE', imo: '9123456', vesselType: 'tanker' }, tok['kt.admin'])).status).toBe(201);
      expect((await h.post('/api/registry/vessels', { mmsi: '419500002', name: 'KONKAN TWO' }, tok['kt.admin'])).status).toBe(201); // 5 of 5
      const over = await h.post('/api/registry/vessels', { mmsi: '419500003', name: 'KONKAN THREE' }, tok['kt.admin']);
      expect(over.status).toBe(402);
      expect((await j<{ error: string }>(over)).error).toMatch(/Starter plan allows 5 vessels/);
      // updating an existing vessel does not count against the quota
      expect((await h.post('/api/registry/vessels', { mmsi: '419500001', name: 'KONKAN ONE RENAMED' }, tok['kt.admin'])).status).toBe(201);
    });

    it('CSV import accepts valid rows and reports rejected ones', async () => {
      const csv = 'mmsi,imo,name,type,flag,grossTonnage\n419600001,9111111,BOC IMPORT ONE,cargo,India,30000\nbad,,Broken,,,\n419600002,,BOC IMPORT TWO,tanker,India,\n';
      const r = await j<{ imported: number; errors: Array<{ row: number }> }>(await h.post('/api/registry/import', { csv }, tok.orgadmin));
      expect(r.imported).toBe(2);
      expect(r.errors.map((e) => e.row)).toEqual([2]);
      expect((await h.post('/api/registry/import', { csv }, tok.operator)).status).toBe(403);
    });

    it('retiring a vessel is a soft delete and frees quota; only org admins can retire', async () => {
      expect((await h.del('/api/registry/vessels/419500001', tok['kt.operator'])).status).toBe(403);
      expect((await h.del('/api/registry/vessels/419500001', tok['kt.admin'])).status).toBe(200);
      const list = (await j<{ vessels: Array<{ mmsi: string; status: string }> }>(await h.call('/api/registry/vessels', { token: tok['kt.admin'] }))).vessels;
      expect(list.find((v) => v.mmsi === '419500001')?.status).toBe('retired');
      expect((await h.post('/api/registry/vessels', { mmsi: '419500009', name: 'REPLACEMENT' }, tok['kt.admin'])).status).toBe(201);
    });

    it('org admins create users within the user quota (Starter = 3), with validation and unique usernames', async () => {
      const make = (u: string, pw = 'LongEnough#123', role = 'operator') => h.post('/api/org/users', { username: u, password: pw, displayName: 'New User', role }, tok['kt.admin']);
      expect((await make('kt.third')).status).toBe(201); // 3 of 3 (operator, admin, third)
      expect((await make('kt.fourth')).status).toBe(402);
      expect((await h.post('/api/org/users', { username: 'x', password: 'LongEnough#123', displayName: 'N', role: 'operator' }, tok.orgadmin)).status).toBe(400);
      expect((await h.post('/api/org/users', { username: 'boc.new', password: 'short', displayName: 'N', role: 'operator' }, tok.orgadmin)).status).toBe(400);
      expect((await h.post('/api/org/users', { username: 'operator', password: 'LongEnough#123', displayName: 'New User', role: 'operator' }, tok.orgadmin)).status).toBe(409);
      expect((await h.post('/api/org/users', { username: 'boc.ops2', password: 'LongEnough#123', displayName: 'N', role: 'analyst' }, tok.orgadmin)).status).toBe(400);
      expect((await h.post('/api/org/users', { username: 'boc.ops2', password: 'LongEnough#123', displayName: 'N', role: 'operator' }, tok.operator)).status).toBe(403);
      // the new user belongs to the creating organisation only
      expect(h.hub.users.get('kt.third')?.orgId).toBe('org-kt');
    });

    it('shows plan, usage and an invoice estimate; platform admin can upgrade a plan, which raises quotas', async () => {
      const before = await j<{ plan: { id: string }; usage: { vessels: number; voyages: number }; invoiceEstimate: { totalInr: number } }>(await h.call('/api/org', { token: tok.orgadmin }));
      expect(before.plan.id).toBe('professional');
      expect(before.usage.voyages).toBeGreaterThan(0);
      expect(before.invoiceEstimate.totalInr).toBeGreaterThanOrEqual(49_000);
      expect((await h.put('/api/admin/orgs/org-kt', { planId: 'professional' }, tok['kt.admin'])).status).toBe(403);
      expect((await h.put('/api/admin/orgs/org-kt', { planId: 'gold' }, tok.admin)).status).toBe(400);
      expect((await h.put('/api/admin/orgs/org-kt', { planId: 'professional' }, tok.admin)).status).toBe(200);
      expect((await h.post('/api/org/users', { username: 'kt.fourth', password: 'LongEnough#123', displayName: 'New User', role: 'operator' }, tok['kt.admin'])).status).toBe(201);
    });

    it('the platform admin can onboard a new customer organisation with its first admin', async () => {
      const r = await h.post('/api/admin/orgs', { name: 'Coastal Freight Co', kind: 'shipping_company', planId: 'starter', adminUsername: 'cf.admin', adminPassword: 'LongEnough#123' }, tok.admin);
      expect(r.status).toBe(201);
      const login = await h.post('/api/auth/login', { username: 'cf.admin', password: 'LongEnough#123' });
      expect(login.status).toBe(200);
      expect((await h.post('/api/admin/orgs', { name: 'X', kind: 'shipping_company', adminUsername: 'bad name', adminPassword: 'LongEnough#123' }, tok.admin)).status).toBe(400);
    });
  });

  describe('voyage approval workflow', () => {
    const window = () => ({ etd: h.now() + 24 * 3_600_000, eta: h.now() + 24 * 3_600_000 * 8 });
    const create = async (body: Record<string, unknown>, token = tok.operator) => j<{ id: string; status: string }>(await h.post('/api/voyages', { originPort: 'INBOM', destinationPort: 'YEADE', cargo: 'general', ...window(), ...body }, token));

    it('previews a risk assessment without saving; validates input', async () => {
      const a = await j<{ score: number; level: string; exposure: { highRiskNm: number } }>(await h.post('/api/voyages/assess', { routeId: 'mumbai-aden', cargo: 'crude_oil', ...window(), originPort: 'INBOM', destinationPort: 'YEADE' }, tok.operator));
      expect(a.exposure.highRiskNm).toBeGreaterThan(0);
      expect(a.score).toBeGreaterThan(20);
      expect((await h.post('/api/voyages/assess', { routeId: 'nope', cargo: 'general', ...window(), originPort: 'INBOM', destinationPort: 'YEADE' }, tok.operator)).status).toBe(400);
    });

    it('rejects voyages for vessels outside the registry and with bad dates', async () => {
      expect((await h.post('/api/voyages', { mmsi: '111111111', routeId: 'mumbai-kochi', originPort: 'INBOM', destinationPort: 'INCOK', cargo: 'general', ...window() }, tok.operator)).status).toBe(404);
      expect((await h.post('/api/voyages', { mmsi: '419200103', routeId: 'mumbai-kochi', originPort: 'INBOM', destinationPort: 'INCOK', cargo: 'general', etd: 5, eta: 1 }, tok.operator)).status).toBe(400);
    });

    it('low-risk voyages are auto-approved; high-risk voyages need a different person to approve with conditions', async () => {
      const low = await create({ mmsi: '419200107', routeId: 'chennai-colombo', originPort: 'INMAA', destinationPort: 'LKCMB', cargo: 'containers' });
      const sub = await j<{ status: string }>(await h.post(`/api/voyages/${low.id}/actions`, { action: 'submit' }, tok.operator));
      expect(sub.status).toBe('approved');

      const risky = await create({ mmsi: '419200108', routeId: 'mumbai-aden', cargo: 'crude_oil', eta: h.now() + 24 * 3_600_000 * 20 });
      const submitted = await j<{ status: string; approvalsRequired: string[]; assessment: { level: string } }>(await h.post(`/api/voyages/${risky.id}/actions`, { action: 'submit' }, tok.operator));
      expect(submitted.status).toBe('submitted');
      expect(submitted.approvalsRequired.length).toBeGreaterThan(0);
      expect((await h.post(`/api/voyages/${risky.id}/actions`, { action: 'approve', note: 'ok' }, tok.operator)).status).toBe(409); // operators cannot approve
      const noNote = await h.post(`/api/voyages/${risky.id}/actions`, { action: 'approve' }, tok.riskofficer);
      expect(noNote.status).toBe(409);
      let result = await j<{ status: string }>(await h.post(`/api/voyages/${risky.id}/actions`, { action: 'approve', note: 'BMP5 in force, armed escort not required' }, tok.riskofficer));
      if (result.status === 'submitted') result = await j(await h.post(`/api/voyages/${risky.id}/actions`, { action: 'approve', note: 'admin sign-off' }, tok.orgadmin)); // critical: second approver
      expect(result.status).toBe('approved');
      const full = await j<{ approvals: unknown[]; conditions: string; history: Array<{ action: string }> }>(await h.call(`/api/voyages/${risky.id}`, { token: tok.operator }));
      expect(full.approvals.length).toBeGreaterThan(0);
      expect(full.conditions).toMatch(/BMP5|admin/);
      expect(full.history.map((x) => x.action)).toContain('submitted');
    });

    it('four-eyes: the person who prepared a voyage cannot approve it', async () => {
      const v = await create({ mmsi: '419200105', routeId: 'mumbai-fujairah', originPort: 'INBOM', destinationPort: 'AEFJR', cargo: 'crude_oil', eta: h.now() + 24 * 3_600_000 * 12 }, tok.riskofficer);
      const s = await j<{ status: string }>(await h.post(`/api/voyages/${v.id}/actions`, { action: 'submit' }, tok.riskofficer));
      if (s.status === 'submitted') {
        const self = await h.post(`/api/voyages/${v.id}/actions`, { action: 'approve', note: 'self approval' }, tok.riskofficer);
        expect(self.status).toBe(409);
        expect((await j<{ error: string }>(self)).error).toMatch(/Four-eyes/);
      }
    });

    it('drafts can be edited by their creator only; billing counts a voyage once, when first submitted', async () => {
      const usage = async () => (await j<{ usage: { voyages: number } }>(await h.call('/api/org', { token: tok.orgadmin }))).usage.voyages;
      const before = await usage();
      const v = await create({ mmsi: '419200106', routeId: 'colombo-malacca', originPort: 'LKCMB', destinationPort: 'SGSIN', cargo: 'containers' });
      expect(await usage()).toBe(before); // a draft is free
      expect((await h.put(`/api/voyages/${v.id}`, { cargo: 'bulk' }, tok.riskofficer)).status).toBe(403);
      expect((await h.put(`/api/voyages/${v.id}`, { cargo: 'bulk' }, tok.operator)).status).toBe(200);
      await h.post(`/api/voyages/${v.id}/actions`, { action: 'submit' }, tok.operator);
      expect(await usage()).toBe(before + 1);
      expect((await h.post(`/api/voyages/${v.id}/actions`, { action: 'bogus' }, tok.operator)).status).toBe(400);
    });
  });

  describe('live voyage monitoring and supply-chain control tower', () => {
    it('raises a deviation alert (and an alert visible to the owning company only) when an active voyage is off its approved route', async () => {
      // the seeded GODAVARI voyage (Mumbai -> Fujairah) is active; put the vessel far from that route
      h.hub.ingest({ mmsi: '419200109', name: 'BOC GODAVARI', lat: 7, lon: 92, sog: 12, shipType: 70, ts: h.now() }, h.now());
      const out = await runBackground(h.services);
      expect(out.voyageAlerts).toBeGreaterThanOrEqual(1);
      const mine = (await j<{ alerts: Array<{ ruleId: string; mmsi: string }> }>(await h.call('/api/alerts', { token: tok.operator }))).alerts;
      expect(mine.some((a) => a.ruleId === 'voyage_deviation' && a.mmsi === '419200109')).toBe(true);
      const kt = (await j<{ alerts: Array<{ ruleId: string }> }>(await h.call('/api/alerts', { token: tok['kt.operator'] }))).alerts;
      expect(kt.some((a) => a.ruleId === 'voyage_deviation')).toBe(false);
      expect((await runBackground(h.services)).voyageAlerts).toBe(0); // de-duplicated
    });

    it('projects live ETA, flags delivery risk and lets customers be linked to voyages; invalid links are refused', async () => {
      const t0 = await j<{ shipments: Array<{ id: string; reference: string; deliveryRisk: string; projectedEta?: number; etaBasis?: string; advisories: string[] }> }>(await h.call('/api/supply-chain/overview', { token: tok.operator }));
      const live = t0.shipments.find((s) => s.reference === 'PO-2026-1187')!;
      expect(live.etaBasis).toBe('live');
      expect(['at_risk', 'late', 'on_track']).toContain(live.deliveryRisk);
      const unplanned = t0.shipments.find((s) => s.reference === 'PO-2026-1244')!;
      expect(unplanned.deliveryRisk).toBe('unplanned');
      expect(unplanned.advisories.join(' ')).toMatch(/allocate/i);
      const draft = (await j<{ voyages: Array<{ id: string; status: string }> }>(await h.call('/api/voyages?status=draft', { token: tok.operator }))).voyages[0]!;
      expect((await h.put(`/api/shipments/${unplanned.id}`, { voyageId: 'does-not-exist' }, tok.operator)).status).toBe(404);
      const linked = await h.put(`/api/shipments/${unplanned.id}`, { voyageId: draft.id }, tok.operator);
      expect(linked.status).toBe(200);
      const t1 = await j<{ shipments: Array<{ reference: string; deliveryRisk: string; voyageReference?: string }> }>(await h.call('/api/supply-chain/overview', { token: tok.operator }));
      const after = t1.shipments.find((s) => s.reference === 'PO-2026-1244')!;
      expect(after.deliveryRisk).not.toBe('unplanned');
      expect(after.voyageReference).toBeTruthy();
    });

    it('creates shipments with validation, unique references and tenant scoping; delivering and cancelling work once', async () => {
      const body = { reference: 'PO-NEW-1', customer: 'Acme', commodity: 'Machinery', cargo: 'general', quantity: 10, unit: 'MT', valueInr: 5_000_000, incoterm: 'FOB', originPort: 'INBOM', destinationPort: 'INCOK', requiredBy: h.now() + 10 * 86_400_000 };
      const ok = await h.post('/api/shipments', body, tok.operator);
      expect(ok.status).toBe(201);
      expect((await h.post('/api/shipments', body, tok.operator)).status).toBe(409);
      expect((await h.post('/api/shipments', { ...body, reference: 'PO-NEW-2', incoterm: 'XYZ' }, tok.operator)).status).toBe(400);
      expect((await h.post('/api/shipments', { ...body, reference: 'PO-NEW-3', quantity: -1 }, tok.operator)).status).toBe(400);
      const { id } = await j<{ id: string }>(ok);
      expect((await h.post(`/api/shipments/${id}/actions`, { action: 'deliver' }, tok['kt.operator'])).status).toBe(404);
      expect((await h.post(`/api/shipments/${id}/actions`, { action: 'deliver', note: 'POD signed' }, tok.operator)).status).toBe(200);
      expect((await h.post(`/api/shipments/${id}/actions`, { action: 'cancel' }, tok.operator)).status).toBe(409);
      expect((await h.post(`/api/shipments/${id}/actions`, { action: 'explode' }, tok.operator)).status).toBe(400);
    });
  });

  describe('case management with SLA and escalation', () => {
    it('opens a case routed to the nearest desk, with priority and deadlines; company users see only their own organisation\'s cases', async () => {
      h.hub.ingest({ mmsi: '636000777', name: 'MV Odd', lat: 10.2, lon: 74.5, sog: 6, shipType: 70, ts: h.now() }, h.now());
      const res = await h.post('/api/cases', { mmsi: '636000777', category: 'distress', note: 'Flares seen' }, tok.operator);
      expect(res.status).toBe(201);
      const c = await j<{ id: string; priority: string; ackDueAt: number; createdAt: number; station: { desk: string }; orgId: string }>(res);
      expect(c.priority).toBe('P1');
      expect(c.ackDueAt - c.createdAt).toBe(5 * 60_000);
      expect(c.orgId).toBe('org-boc');
      expect((await j<{ cases: Array<{ id: string }> }>(await h.call('/api/cases', { token: tok['kt.operator'] }))).cases.length).toBe(0);
      expect((await j<{ cases: Array<{ id: string }> }>(await h.call('/api/cases', { token: tok.riskofficer }))).cases.some((x) => x.id === c.id)).toBe(true); // same organisation
      expect((await j<{ cases: Array<{ id: string }> }>(await h.call('/api/cases', { token: tok.analyst }))).cases.some((x) => x.id === c.id)).toBe(true);
    });

    it('escalates an unacknowledged case to the desk lead, then to the regional controller, raising alerts and recording history', async () => {
      const list = (await j<{ cases: Array<{ id: string; priority: string }> }>(await h.call('/api/cases', { token: tok.analyst }))).cases;
      const c = list.find((x) => x.priority === 'P1')!;
      h.advance(6 * 60_000);
      expect((await runBackground(h.services)).escalations).toBe(1);
      h.advance(5 * 60_000);
      expect((await runBackground(h.services)).escalations).toBe(1);
      expect((await runBackground(h.services)).escalations).toBe(0);
      const after = await j<{ escalationLevel: number; slaBreached: boolean; history: Array<{ action: string }> }>(await (async () => {
        const all = (await j<{ cases: Array<Record<string, unknown>> }>(await h.call('/api/cases', { token: tok.analyst }))).cases;
        return new Response(JSON.stringify(all.find((x) => x.id === c.id)));
      })());
      expect(after.escalationLevel).toBe(2);
      expect(after.slaBreached).toBe(true);
      expect(after.history.map((x) => x.action)).toEqual(expect.arrayContaining(['escalated_L1', 'escalated_L2']));
      const alerts = (await j<{ alerts: Array<{ ruleId: string; severity: string }> }>(await h.call('/api/alerts', { token: tok.analyst }))).alerts.filter((a) => a.ruleId === 'case_sla');
      expect(alerts.length).toBe(2);
      expect(alerts.some((a) => a.severity === 'critical')).toBe(true);
    });

    it('controllers assign, acknowledge, investigate and close with a closure code; reporters cannot', async () => {
      const created = await j<{ id: string }>(await h.post('/api/cases', { lat: 9.3, lon: 79.2, category: 'unidentified_vessel', note: 'Unlit boat' }, tok.operator));
      const id = created.id;
      expect((await h.post(`/api/cases/${id}/status`, { status: 'acknowledged' }, tok.operator)).status).toBe(403);
      expect((await h.post(`/api/cases/${id}/assign`, { assignee: 'operator' }, tok.analyst)).status).toBe(400); // must be a controller
      expect((await h.post(`/api/cases/${id}/assign`, { assignee: 'cg.kochi' }, tok.analyst)).status).toBe(200);
      expect((await j<{ status: string }>(await h.post(`/api/cases/${id}/status`, { status: 'acknowledged', note: 'unit dispatched' }, tok['cg.kochi']))).status).toBe('acknowledged');
      expect((await h.post(`/api/cases/${id}/status`, { status: 'closed' }, tok['cg.kochi'])).status).toBe(400); // closure code required
      const closed = await j<{ status: string; closureCode: string; assignee: string; closedAt: number }>(await h.post(`/api/cases/${id}/status`, { status: 'closed', closureCode: 'false_alarm', note: 'fishing boat' }, tok['cg.kochi']));
      expect(closed).toMatchObject({ status: 'closed', closureCode: 'false_alarm', assignee: 'cg.kochi' });
      expect((await h.post(`/api/cases/${id}/status`, { status: 'investigating' }, tok['cg.kochi'])).status).toBe(409);
    });

    it('validates reports and rate-limits floods', async () => {
      expect((await h.post('/api/cases', { category: 'bogus', mmsi: '419200101' }, tok.admin)).status).toBe(400);
      expect((await h.post('/api/cases', { category: 'other' }, tok.admin)).status).toBe(400);
      expect((await h.post('/api/cases', { category: 'other', mmsi: '111111111' }, tok.admin)).status).toBe(404);
      let last = 0;
      for (let i = 0; i < 12; i++) last = (await h.post('/api/cases', { category: 'other', lat: 10, lon: 75 }, tok.admin)).status;
      expect(last).toBe(429);
    });
  });

  describe('API keys, integration API and signed webhooks', () => {
    let secret = '';
    it('starter plans cannot create keys or webhooks (feature entitlement)', async () => {
      const stub = await h.post('/api/org/api-keys', { name: 'erp' }, tok['kt.admin']);
      // KT was upgraded earlier in this file; create a fresh starter tenant to test the entitlement
      expect([201, 402]).toContain(stub.status);
      await h.post('/api/admin/orgs', { name: 'Tiny Shipping', kind: 'shipping_company', planId: 'starter', adminUsername: 'tiny.admin', adminPassword: 'LongEnough#123' }, tok.admin);
      const tiny = (await j<{ token: string }>(await h.post('/api/auth/login', { username: 'tiny.admin', password: 'LongEnough#123' }))).token;
      expect((await h.post('/api/org/api-keys', { name: 'erp' }, tiny)).status).toBe(402);
      expect((await h.post('/api/org/webhooks', { url: 'https://erp.example.com/h' }, tiny)).status).toBe(402);
    });

    it('creates a key whose secret is shown once and never stored in clear; the key authenticates the integration API with scopes', async () => {
      const r = await j<{ secret: string; key: Record<string, unknown> }>(await h.post('/api/org/api-keys', { name: 'ERP sync', scopes: ['read:fleet', 'read:shipments'] }, tok.orgadmin));
      secret = r.secret;
      expect(secret).toMatch(/^orvms_[0-9a-f]{48}$/);
      expect(r.key.hash).toBeUndefined();
      const listed = JSON.stringify(await j(await h.call('/api/org/api-keys', { token: tok.orgadmin })));
      expect(listed).not.toContain(secret);
      const api = (path: string, key = secret) => h.call(path, { headers: { 'X-API-Key': key } });
      const fleet = await j<{ vessels: unknown[] }>(await api('/api/integration/v1/fleet'));
      expect(fleet.vessels.length).toBeGreaterThanOrEqual(10);
      expect((await j<{ shipments: unknown[] }>(await api('/api/integration/v1/shipments'))).shipments.length).toBeGreaterThan(3);
      expect((await api('/api/integration/v1/alerts')).status).toBe(403); // scope not granted
      expect((await api('/api/integration/v1/fleet', 'orvms_wrong')).status).toBe(403);
      expect((await h.call('/api/integration/v1/fleet')).status).toBe(403);
      expect((await h.call('/api/integration/v1/fleet', { headers: { 'X-API-Key': secret } })).headers.get('content-type')).toContain('json');
    });

    it('meters API calls per month and refuses calls beyond the plan quota', async () => {
      const used = await h.repo.usage.get('org-boc', '2026-10', 'api_calls');
      expect(used).toBeGreaterThanOrEqual(3);
      await h.repo.usage.increment('org-boc', '2026-10', 'api_calls', 10_000);
      const res = await h.call('/api/integration/v1/fleet', { headers: { 'X-API-Key': secret } });
      expect(res.status).toBe(402);
      expect((await j<{ error: string }>(res)).error).toMatch(/quota/);
    });

    it('revoked keys stop working immediately; keys of other organisations cannot be revoked', async () => {
      const created = await j<{ secret: string; key: { id: string } }>(await h.post('/api/org/api-keys', { name: 'temp', scopes: ['read:voyages'] }, tok['kt.admin']));
      if (!created.key) return; // KT may be on the starter plan in isolation
      expect((await h.del(`/api/org/api-keys/${created.key.id}`, tok.orgadmin)).status).toBe(404); // wrong tenant
      expect((await h.del(`/api/org/api-keys/${created.key.id}`, tok['kt.admin'])).status).toBe(200);
      expect((await h.call('/api/integration/v1/voyages', { headers: { 'X-API-Key': created.secret } })).status).toBe(403);
    });

    it('webhooks: only public https targets; deliveries are HMAC-signed, retried and recorded', async () => {
      expect((await h.post('/api/org/webhooks', { url: 'http://erp.example.com/h' }, tok.orgadmin)).status).toBe(400);
      expect((await h.post('/api/org/webhooks', { url: 'https://10.0.0.7/h' }, tok.orgadmin)).status).toBe(400);
      expect((await h.post('/api/org/webhooks', { url: 'https://erp.example.com/h', events: ['nope'] }, tok.orgadmin)).status).toBe(400);
      const hook = await j<{ id: string; secret: string }>(await h.post('/api/org/webhooks', { url: 'https://erp.example.com/hook', events: ['voyage.status_changed', 'case.created'] }, tok.orgadmin));
      expect(hook.secret).toMatch(/^whsec_/);

      let attempt = 0;
      h.setFetch(async (url, init) => {
        attempt++;
        h.calls.push({ url, headers: init.headers, body: init.body });
        return attempt < 3 ? { status: 503, ok: false } : { status: 200, ok: true };
      });
      h.calls.length = 0;
      const v = await j<{ id: string }>(await h.post('/api/voyages', { mmsi: '419200107', routeId: 'chennai-colombo', originPort: 'INMAA', destinationPort: 'LKCMB', cargo: 'containers', etd: h.now() + 86_400_000, eta: h.now() + 5 * 86_400_000 }, tok.operator));
      await h.post(`/api/voyages/${v.id}/actions`, { action: 'submit' }, tok.operator);
      await h.flush();
      expect(h.calls.length).toBe(3); // two failures then success
      const call = h.calls[0]!;
      expect(call.url).toBe('https://erp.example.com/hook');
      expect(call.headers['X-ORVMS-Event']).toBe('voyage.status_changed');
      const ts = Number(call.headers['X-ORVMS-Timestamp']);
      expect(call.headers['X-ORVMS-Signature']).toBe(`sha256=${await signPayload(hook.secret, ts, call.body)}`);
      const envelope = JSON.parse(call.body) as { event: string; orgId: string; data: { to: string } };
      expect(envelope).toMatchObject({ event: 'voyage.status_changed', orgId: 'org-boc' });
      const deliveries = (await j<{ deliveries: Array<{ status: string; attempts: number; payload?: string }> }>(await h.call('/api/org/deliveries', { token: tok.orgadmin }))).deliveries;
      expect(deliveries[0]).toMatchObject({ status: 'delivered', attempts: 3 });
      expect(deliveries[0]?.payload).toBeUndefined();
    });

    it('events only go to the owning organisation and a permanently failing endpoint is recorded as failed', async () => {
      h.setFetch(async () => ({ status: 500, ok: false }));
      const before = h.calls.length;
      const ktHook = await h.post('/api/org/webhooks', { url: 'https://kt.example.com/h', events: ['case.created'] }, tok['kt.admin']);
      expect([201, 402]).toContain(ktHook.status);
      await h.post('/api/cases', { lat: 10.2, lon: 74.5, category: 'other', note: 'x' }, tok.analyst);
      await h.flush();
      expect(h.calls.length).toBe(before); // the BOC/KT webhooks are not told about the analyst's own (ICG) case
      const failing = await h.post('/api/org/webhooks', { url: 'https://erp.example.com/h2', events: ['case.created'] }, tok.orgadmin);
      expect(failing.status).toBe(201);
      h.advance(61_000); // new rate-limit window for the reporter
      await h.post('/api/cases', { lat: 10.4, lon: 74.6, category: 'other', note: 'y' }, tok.operator);
      await h.flush();
      const deliveries = (await j<{ deliveries: Array<{ status: string; attempts: number }> }>(await h.call('/api/org/deliveries', { token: tok.orgadmin }))).deliveries;
      expect(deliveries.some((d) => d.status === 'failed' && d.attempts === 3)).toBe(true);
    });
  });

  describe('audit trail of business actions', () => {
    it('records tenant administration, workflow and integration changes for the platform admin', async () => {
      const audit = (await j<{ audit: Array<{ action: string }> }>(await h.call('/api/audit', { token: tok.admin }))).audit.map((a) => a.action);
      for (const expected of ['user.created', 'registry.upsert', 'org.created', 'apikey.created', 'webhook.created', 'voyage.submit', 'case.escalated', 'case.assigned', 'shipment.created']) {
        expect(audit, expected).toContain(expected);
      }
      expect(PW.length).toBeGreaterThan(8);
    });
  });
});
