import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryRepo } from '../../src/data/memory';
import type { Repo } from '../../src/data/repo';
import { SqlRepo, migrate } from '../../src/data/sql';
import { runBackground } from '../../src/services/background';
import { runRetention } from '../../src/services/reports';
import { makeHarness, type Harness } from '../helpers/harness';
import { createSqliteDb } from '../helpers/sqlite';

const DAY = 86_400_000;
const impls: Array<[string, () => Promise<Repo>]> = [
  ['MemoryRepo', async () => new MemoryRepo()],
  ['SqlRepo (SQLite)', async () => {
    const db = createSqliteDb();
    await migrate(db);
    return new SqlRepo(db);
  }],
];

describe.each(impls)('Business layer on %s', (_name, makeRepo) => {
  let h: Harness;
  let tok: Record<string, string>;
  const j = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T;

  beforeAll(async () => {
    h = await makeHarness({ repo: await makeRepo() });
    tok = {};
    for (const u of ['admin', 'analyst', 'cg.kochi', 'operator', 'riskofficer', 'orgadmin', 'kt.operator', 'kt.admin']) tok[u] = await h.as(u);
  });

  describe('seed data', () => {
    it('seeds three consecutive past billing periods even on the 31st of a month', async () => {
      const late = await makeHarness({ seed: false, repo: await makeRepo() });
      late.setClock(Date.UTC(2026, 9, 31, 8, 0, 0)); // 31 October: "one month back" must still be September
      const { seedDemo } = await import('../../src/services/seed');
      await seedDemo(late.services, 'SeedPass#12345');
      const periods = (await late.services.repo.invoices.list('org-boc')).map((i) => i.period).sort();
      expect(periods).toEqual(['2026-07', '2026-08', '2026-09']);
      const reports = (await late.services.repo.reports.list('org-boc')).map((r) => r.period).sort();
      expect(reports).toEqual(['2026-09', '2026-10']);
    });
  });

  describe('executive overview', () => {
    it('joins voyages, supply chain, incidents and commercial data for a company user', async () => {
      const o = await j<{ voyages: { total: number; funnel: unknown[] }; supplyChain: { late: number }; commercial: { outstandingInr: number; supportTier: string }; quotas: Array<{ metric: string; pct: number }>; attention: Array<{ text: string }> }>(await h.call('/api/overview', { token: tok.orgadmin }));
      expect(o.voyages.total).toBeGreaterThan(0);
      expect(o.voyages.funnel).toHaveLength(5);
      expect(o.commercial.supportTier).toBe('priority');
      expect(o.commercial.outstandingInr).toBeGreaterThan(0);
      expect(o.quotas.map((q) => q.metric)).toContain('vessels');
      expect(o.attention.some((a) => /overdue/i.test(a.text))).toBe(true);
    });

    it('is not available to Coast Guard staff', async () => {
      expect((await h.call('/api/overview', { token: tok.analyst })).status).toBe(403);
    });
  });

  describe('billing', () => {
    it('shows the contract, invoice history with derived status and an upcoming-invoice preview', async () => {
      const b = await j<{ contract: { supportTier: string; gstin: string }; invoices: Array<{ view: string; number: string }>; upcoming: { lines: unknown[] } | null; receivables: { overdueInr: number } }>(await h.call('/api/billing', { token: tok.orgadmin }));
      expect(b.contract.gstin).toBe('27AABCB1234C1Z5');
      expect(b.invoices.map((i) => i.view).sort()).toEqual(['issued', 'overdue', 'paid']);
      expect(b.receivables.overdueInr).toBeGreaterThan(0);
      expect(b.upcoming?.lines.length).toBeGreaterThanOrEqual(2);
    });

    it('is restricted to the organisation admin and scoped to the tenant', async () => {
      expect((await h.call('/api/billing', { token: tok.operator })).status).toBe(403);
      const kt = await j<{ invoices: unknown[] }>(await h.call('/api/billing', { token: tok['kt.admin'] }));
      expect(kt.invoices).toHaveLength(0);
      const boc = await j<{ invoices: Array<{ id: string }> }>(await h.call('/api/billing', { token: tok.orgadmin }));
      expect((await h.call(`/api/billing/invoices/${boc.invoices[0]?.id}`, { token: tok['kt.admin'] })).status).toBe(404);
    });

    it('settles an overdue invoice through the sandbox gateway and records the payment', async () => {
      const before = await j<{ invoices: Array<{ id: string; view: string; totalInr: number }> }>(await h.call('/api/billing', { token: tok.orgadmin }));
      const overdue = before.invoices.find((i) => i.view === 'overdue');
      expect(overdue).toBeTruthy();
      expect((await h.post(`/api/billing/invoices/${overdue?.id}/pay`, { method: 'bitcoin' }, tok.orgadmin)).status).toBe(400);
      const paid = await h.post(`/api/billing/invoices/${overdue?.id}/pay`, { method: 'upi' }, tok.orgadmin);
      expect(paid.status).toBe(200);
      const body = await j<{ invoice: { view: string; payments: Array<{ reference: string; amountInr: number }> }; sandbox: boolean }>(paid);
      expect(body.sandbox).toBe(true);
      expect(body.invoice.view).toBe('paid');
      expect(body.invoice.payments[0]?.reference).toMatch(/^SBX-/);
      expect(body.invoice.payments[0]?.amountInr).toBeCloseTo(overdue?.totalInr ?? 0, 2);
      expect((await h.post(`/api/billing/invoices/${overdue?.id}/pay`, { method: 'upi' }, tok.orgadmin)).status).toBe(409);
    });

    it('exports an invoice as CSV', async () => {
      const b = await j<{ invoices: Array<{ id: string; number: string }> }>(await h.call('/api/billing', { token: tok.orgadmin }));
      const r = await h.call(`/api/billing/invoices/${b.invoices[0]?.id}/csv`, { token: tok.orgadmin });
      expect(r.headers.get('content-type')).toContain('text/csv');
      expect(await r.text()).toContain('gst_18pct_inr');
    });

    it('lets the customer edit its billing contact and GSTIN, but not commercial terms', async () => {
      expect((await h.put('/api/billing/contract', { billingContact: 'not-an-email' }, tok.orgadmin)).status).toBe(400);
      expect((await h.put('/api/billing/contract', { gstin: 'bad' }, tok.orgadmin)).status).toBe(400);
      const ok = await h.put('/api/billing/contract', { billingContact: 'finance@bharatocean.example', retentionMonths: 36 }, tok.orgadmin);
      expect(ok.status).toBe(200);
      expect((await j<{ retentionMonths: number }>(ok)).retentionMonths).toBe(36);
      expect((await h.put('/api/billing/contract', { supportTier: 'premium' }, tok.orgadmin)).status).toBe(403);
    });

    it('lets the platform admin change commercial terms and run billing idempotently', async () => {
      const upd = await h.put('/api/admin/orgs/org-boc/contract', { supportTier: 'premium', paymentTermsDays: 30 }, tok.admin);
      expect(upd.status).toBe(200);
      expect((await j<{ supportTier: string }>(upd)).supportTier).toBe('premium');
      expect((await h.put('/api/admin/orgs/org-boc/contract', { paymentTermsDays: 5 }, tok.admin)).status).toBe(400);
      const first = await j<{ invoice: { id: string } }>(await h.post('/api/admin/orgs/org-boc/invoice', { period: '2026-06' }, tok.admin));
      const second = await j<{ invoice: { id: string } }>(await h.post('/api/admin/orgs/org-boc/invoice', { period: '2026-06' }, tok.admin));
      expect(second.invoice.id).toBe(first.invoice.id);
      expect((await j<{ issued: number }>(await h.post('/api/admin/billing/run', { period: '2026-09' }, tok.admin))).issued).toBe(0);
      const inv = (await j<{ invoices: Array<{ period: string; lines: Array<{ description: string }> }> }>(await h.call('/api/billing', { token: tok.orgadmin }))).invoices.find((i) => i.period === '2026-06');
      expect(inv?.lines.some((l) => /Premium support/.test(l.description))).toBe(true);
    });

    it('shows revenue and receivables to the platform admin only', async () => {
      const r = await j<{ mrrInr: number; arrInr: number; customers: Array<{ orgId: string; mrrInr: number }>; trend: unknown[] }>(await h.call('/api/admin/revenue', { token: tok.admin }));
      expect(r.mrrInr).toBeGreaterThan(0);
      expect(r.arrInr).toBe(r.mrrInr * 12);
      expect(r.customers.map((c) => c.orgId).sort()).toEqual(['org-boc', 'org-kt']);
      expect(r.trend.length).toBeGreaterThan(0);
      expect((await h.call('/api/admin/revenue', { token: tok.orgadmin })).status).toBe(403);
    });

    it('issues the previous month\'s invoice automatically from the background runner', async () => {
      h.setClock(Date.UTC(2026, 10, 2, 9, 0, 0)); // 2 November
      try {
        h.services.state.lastBilling = 0;
        await runBackground(h.services);
        const list = await h.services.repo.invoices.list('org-boc');
        expect(list.some((i) => i.period === '2026-10')).toBe(true);
        expect(await h.services.repo.invoices.getByPeriod('org-kt', '2026-10')).toBeUndefined(); // free plan: nothing to bill
      } finally {
        h.setClock(Date.UTC(2026, 9, 30, 8, 0, 0));
      }
    });
  });

  describe('compliance reports', () => {
    let reportId = '';

    it('lists the seeded report packs', async () => {
      const r = await j<{ reports: Array<{ id: string; period: string; generatedBy: string }> }>(await h.call('/api/reports', { token: tok.riskofficer }));
      expect(r.reports.map((x) => x.generatedBy)).toEqual(expect.arrayContaining(['scheduler', 'orgadmin']));
    });

    it('generates an immutable snapshot with approval-control evidence', async () => {
      const res = await h.post('/api/reports', { period: '2026-10' }, tok.riskofficer);
      expect(res.status).toBe(201);
      const snap = await j<{ id: string; payload: { voyages: { total: number }; compliance: { passRatePct: number | null; checks: unknown[] }; headline: string[] } }>(res);
      reportId = snap.id;
      expect(snap.payload.voyages.total).toBeGreaterThan(0);
      expect(snap.payload.compliance.checks).toHaveLength(5);
      expect(snap.payload.compliance.passRatePct).toBe(100);
      expect(snap.payload.headline.length).toBeGreaterThan(1);
      const again = await j<{ payload: { generatedAt: number } }>(await h.call(`/api/reports/${reportId}`, { token: tok.orgadmin }));
      expect(again.payload.generatedAt).toBe(h.now());
    });

    it('validates the period, exports CSV, and is tenant-scoped', async () => {
      expect((await h.post('/api/reports', { period: '2026-13' }, tok.orgadmin)).status).toBe(400);
      expect(await (await h.call(`/api/reports/${reportId}/csv`, { token: tok.orgadmin })).text()).toContain('risk_posture_score');
      expect((await h.call(`/api/reports/${reportId}`, { token: tok['kt.admin'] })).status).toBe(404);
      expect((await h.call('/api/reports', { token: tok.operator })).status).toBe(403);
    });

    it('exports the full tenant data without secrets', async () => {
      const x = await j<{ schema: string; voyages: unknown[]; invoices: unknown[]; apiKeys: Array<Record<string, unknown>> }>(await h.call('/api/org/export', { token: tok.orgadmin }));
      expect(x.schema).toBe('orvms.tenant-export/1');
      expect(x.voyages.length).toBeGreaterThan(0);
      expect(x.invoices.length).toBeGreaterThan(0);
      expect(JSON.stringify(x)).not.toMatch(/"hash"|whsec_|"secret"/);
    });

    it('applies the retention setting to stored reports', async () => {
      const before = (await h.services.repo.reports.list('org-boc')).length;
      expect(before).toBeGreaterThan(0);
      h.setClock(h.now() + 70 * 30 * DAY); // far beyond any retention window
      try {
        const purged = await runRetention(h.services);
        expect(purged.reports).toBeGreaterThanOrEqual(before);
        expect(await h.services.repo.reports.list('org-boc')).toHaveLength(0);
      } finally {
        h.setClock(Date.UTC(2026, 9, 30, 8, 0, 0));
      }
    });
  });

  describe('case analytics and post-incident reports', () => {
    it('gives Coast Guard staff the cross-organisation service-level picture', async () => {
      const r = await j<{ scope: string; analytics: { total: number; slaMetPct: number | null; byClosure: Record<string, number>; byDesk: unknown[]; postIncidentFiled: number } }>(await h.call('/api/cases/analytics', { token: tok.analyst }));
      expect(r.scope).toBe('all');
      expect(r.analytics.total).toBeGreaterThanOrEqual(12);
      expect(r.analytics.slaMetPct).not.toBeNull();
      expect(Object.keys(r.analytics.byClosure).length).toBeGreaterThan(2);
      expect(r.analytics.byDesk.length).toBeGreaterThan(2);
      expect(r.analytics.postIncidentFiled).toBeGreaterThanOrEqual(3);
    });

    it('scopes analytics to the organisation for company users', async () => {
      const r = await j<{ scope: string; analytics: { total: number } }>(await h.call('/api/cases/analytics', { token: tok.operator }));
      expect(r.scope).toBe('organisation');
      const all = await j<{ analytics: { total: number } }>(await h.call('/api/cases/analytics', { token: tok.analyst }));
      expect(r.analytics.total).toBeLessThan(all.analytics.total);
    });

    it('requires a closed case before a post-incident report, and validates it', async () => {
      const open = await h.post('/api/cases', { category: 'unidentified_vessel', note: 'dark contact', lat: 9.9, lon: 75.5 }, tok.operator);
      const c = await j<{ id: string }>(open);
      const body = { summary: 'The contact was identified as a small coastal trader.', findings: 'No irregularities found.', actionsTaken: 'Radio challenge and AIS cross-check.', lessonsLearned: '' };
      expect((await h.post(`/api/cases/${c.id}/post-incident`, body, tok['cg.kochi'])).status).toBe(409);
      await h.post(`/api/cases/${c.id}/status`, { status: 'closed', closureCode: 'resolved', note: 'done' }, tok['cg.kochi']);
      expect((await h.post(`/api/cases/${c.id}/post-incident`, { ...body, summary: 'short' }, tok['cg.kochi'])).status).toBe(400);
      const ok = await h.post(`/api/cases/${c.id}/post-incident`, body, tok['cg.kochi']);
      expect(ok.status).toBe(200);
      const saved = await j<{ postIncident: { filedBy: string }; history: Array<{ action: string }> }>(ok);
      expect(saved.postIncident.filedBy).toBe('cg.kochi');
      expect(saved.history.at(-1)?.action).toBe('post_incident_report_filed');
      expect((await h.post(`/api/cases/${c.id}/post-incident`, body, tok.operator)).status).toBe(403);
    });
  });

  describe('operations', () => {
    it('reports platform health, records and structured logs to the platform admin', async () => {
      await runBackground(h.services);
      const o = await j<{ version: string; storage: { schemaVersion: number }; records: { organisations: number; invoices: number }; background: { runs: number; lastResult: Record<string, number> | null }; logs: Array<{ event: string }> }>(await h.call('/api/admin/ops', { token: tok.admin }));
      expect(o.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(o.storage.schemaVersion).toBe(3);
      expect(o.records.organisations).toBe(4);
      expect(o.records.invoices).toBeGreaterThan(2);
      expect(o.background.runs).toBeGreaterThan(0);
      expect(o.background.lastResult).toBeTruthy();
      expect(o.logs.length).toBeGreaterThan(0);
      expect((await h.call('/api/admin/ops', { token: tok.orgadmin })).status).toBe(403);
    });

    it('produces a full platform backup for the administrator only', async () => {
      const b = await j<{ schema: string; tenants: Array<{ organisation: { id: string } }> }>(await h.call('/api/admin/backup', { token: tok.admin }));
      expect(b.schema).toBe('orvms.platform-backup/1');
      expect(b.tenants).toHaveLength(4);
      expect(JSON.stringify(b)).not.toMatch(/whsec_|"hash"/);
      expect((await h.call('/api/admin/backup', { token: tok.analyst })).status).toBe(403);
    });

    it('creates a default contract for a newly onboarded customer', async () => {
      const r = await h.post('/api/admin/orgs', { name: 'Newco Marine', kind: 'shipping_company', planId: 'enterprise', adminUsername: 'newco.admin', adminPassword: 'LongEnough#2026' }, tok.admin);
      expect(r.status).toBe(201);
      const org = await j<{ id: string }>(r);
      const c = await h.services.repo.contracts.get(org.id);
      expect(c?.supportTier).toBe('premium');
      expect(c?.paymentTermsDays).toBe(45);
    });
  });
});
