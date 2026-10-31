/** Business routes: overview, billing, contracts, reports, case analytics, post-incident reports, operations. */
import type { Context, Hono } from 'hono';
import { isCompanyRole } from '../../core/types';
import { isPeriod } from '../../domain/billing';
import { periodOf } from '../../domain/plans';
import { caseAnalytics } from '../../domain/reports';
import type { Organization } from '../../domain/types';
import { runBilling, billingSummary, invoiceFile, issueInvoice, payInvoice, revenueOverview, updateContract, withView } from '../../services/billing';
import { filePostIncident, visibleCases } from '../../services/cases';
import { orgIdOf } from '../../services/org';
import { backupAll, exportOrganization, opsSnapshot } from '../../services/ops';
import { organizationOverview } from '../../services/overview';
import { generateReport } from '../../services/reports';
import { reportCsv } from '../../domain/reports';
import type { Kit } from './enterprise';

type Env = { Variables: { claims: import('../../core/auth').TokenClaims } };
type ErrStatus = 400 | 402 | 403 | 404 | 409;

const COMPANY = ['operator', 'risk_officer', 'org_admin'] as const;

export function registerBusinessRoutes(app: Hono<Env>, kit: Kit): void {
  const { s, requireAuth, readJson } = kit;
  const myOrg = async (c: Context<Env>): Promise<Organization | undefined> => {
    const id = orgIdOf(s, c.get('claims').sub);
    return id ? s.repo.orgs.get(id) : undefined;
  };
  const noOrg = (c: Context<Env>) => c.json({ error: 'Your account is not linked to an organisation' }, 403);
  const fail = (c: Context<Env>, status: ErrStatus, error: string) => c.json({ error }, status);
  const csv = (c: Context<Env>, name: string, body: string) => c.body(body, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });

  // ── executive overview ─────────────────────────────────────────────────────
  app.get('/api/overview', requireAuth(...COMPANY), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const claims = c.get('claims');
    return c.json(await organizationOverview(s, org, { username: claims.sub, role: claims.role }));
  });

  // ── billing and contract (organisation admin) ──────────────────────────────
  app.get('/api/billing', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    return org ? c.json(await billingSummary(s, org)) : noOrg(c);
  });

  app.get('/api/billing/invoices/:id', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const inv = await s.repo.invoices.get(org.id, c.req.param('id'));
    return inv ? c.json({ invoice: withView(inv, s.now()), customer: { name: org.name } }) : fail(c, 404, 'Invoice not found');
  });

  app.get('/api/billing/invoices/:id/csv', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const f = await invoiceFile(s, org, c.req.param('id'));
    return f ? csv(c, `${f.number}.csv`, f.csv) : fail(c, 404, 'Invoice not found');
  });

  app.post('/api/billing/invoices/:id/pay', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const r = await payInvoice(s, org, c.get('claims').sub, c.req.param('id'), (await readJson(c))?.method);
    return r.ok ? c.json({ invoice: withView(r.value, s.now()), sandbox: true }) : fail(c, r.status, r.error);
  });

  app.put('/api/billing/contract', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const r = await updateContract(s, org, { username: c.get('claims').sub, admin: false }, (await readJson(c)) ?? {});
    return r.ok ? c.json(r.value) : fail(c, r.status, r.error);
  });

  // ── compliance reports ─────────────────────────────────────────────────────
  app.get('/api/reports', requireAuth('org_admin', 'risk_officer'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const list = await s.repo.reports.list(org.id);
    return c.json({ reports: list.map((r) => ({ id: r.id, period: r.period, generatedAt: r.generatedAt, generatedBy: r.generatedBy, postureScore: r.payload.postureScore, headline: r.payload.headline })) });
  });

  app.post('/api/reports', requireAuth('org_admin', 'risk_officer'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const period = (await readJson(c))?.period ?? periodOf(s.now());
    if (!isPeriod(period)) return fail(c, 400, 'period must be YYYY-MM');
    const r = await generateReport(s, org, period, c.get('claims').sub);
    return r.ok ? c.json(r.value, 201) : fail(c, r.status, r.error);
  });

  app.get('/api/reports/:id', requireAuth('org_admin', 'risk_officer'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const r = await s.repo.reports.get(org.id, c.req.param('id'));
    return r ? c.json(r) : fail(c, 404, 'Report not found');
  });

  app.get('/api/reports/:id/csv', requireAuth('org_admin', 'risk_officer'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const r = await s.repo.reports.get(org.id, c.req.param('id'));
    return r ? csv(c, `orvms-report-${r.period}.csv`, reportCsv(r.payload)) : fail(c, 404, 'Report not found');
  });

  app.get('/api/org/export', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    s.hub.log(c.get('claims').sub, 'org.export', org.id);
    return c.json(await exportOrganization(s, org), 200, { 'Content-Disposition': `attachment; filename="orvms-export-${org.id}.json"` });
  });

  // ── case analytics and post-incident reports ───────────────────────────────
  app.get('/api/cases/analytics', requireAuth(), async (c) => {
    const claims = c.get('claims');
    const list = await visibleCases(s, { role: claims.role, orgId: orgIdOf(s, claims.sub) });
    return c.json({ scope: isCompanyRole(claims.role) ? 'organisation' : 'all', analytics: caseAnalytics(list) });
  });

  app.post('/api/cases/:id/post-incident', requireAuth('analyst', 'admin'), async (c) => {
    const r = await filePostIncident(s, c.get('claims').sub, c.req.param('id'), (await readJson(c)) ?? {});
    return r.ok ? c.json(r.value) : fail(c, r.status, r.error);
  });

  // ── platform administration: revenue, contracts, operations ────────────────
  app.get('/api/admin/revenue', requireAuth('admin'), async (c) => c.json(await revenueOverview(s)));

  app.post('/api/admin/billing/run', requireAuth('admin'), async (c) => {
    const period = (await readJson(c))?.period;
    if (period !== undefined && !isPeriod(period)) return fail(c, 400, 'period must be YYYY-MM');
    const issued = await runBilling(s, period as string | undefined);
    s.hub.log(c.get('claims').sub, 'billing.run', `${period ?? 'previous month'} issued=${issued}`);
    return c.json({ issued });
  });

  app.post('/api/admin/orgs/:id/invoice', requireAuth('admin'), async (c) => {
    const org = await s.repo.orgs.get(c.req.param('id'));
    if (!org) return fail(c, 404, 'Organisation not found');
    const period = (await readJson(c))?.period;
    if (!isPeriod(period)) return fail(c, 400, 'period must be YYYY-MM');
    const r = await issueInvoice(s, org, period);
    return r.ok ? c.json({ invoice: r.value ?? null }) : fail(c, r.status, r.error);
  });

  app.put('/api/admin/orgs/:id/contract', requireAuth('admin'), async (c) => {
    const org = await s.repo.orgs.get(c.req.param('id'));
    if (!org) return fail(c, 404, 'Organisation not found');
    const r = await updateContract(s, org, { username: c.get('claims').sub, admin: true }, (await readJson(c)) ?? {});
    return r.ok ? c.json(r.value) : fail(c, r.status, r.error);
  });

  app.get('/api/admin/ops', requireAuth('admin'), async (c) => c.json(await opsSnapshot(s)));

  app.get('/api/admin/backup', requireAuth('admin'), async (c) => {
    s.hub.log(c.get('claims').sub, 'platform.backup', 'full export');
    return c.json(await backupAll(s), 200, { 'Content-Disposition': 'attachment; filename="orvms-backup.json"' });
  });
}
