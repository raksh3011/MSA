/** Compliance reporting: monthly risk and compliance packs, scheduled generation and retention. */
import { addMonths, isPeriod, previousPeriod } from '../domain/billing';
import { periodOf } from '../domain/plans';
import { buildRiskReport } from '../domain/reports';
import type { Organization, ReportSnapshot } from '../domain/types';
import { emit, type Services } from './context';
import { ensureContract } from './billing';
import { fleetMmsis, usageSummary, type Result } from './org';
import { controlTower } from './shipments';

/** Produce an immutable report snapshot for an organisation and period. */
export async function generateReport(s: Services, org: Organization, period: string, by: string): Promise<Result<ReportSnapshot>> {
  if (!isPeriod(period)) return { ok: false, status: 400, error: 'period must be YYYY-MM' };
  const [voyages, shipments, cases, fleet, usage, tower] = await Promise.all([
    s.repo.voyages.list(org.id), s.repo.shipments.list(org.id), s.repo.cases.list({ orgId: org.id }), fleetMmsis(s, org.id), usageSummary(s, org), controlTower(s, org.id),
  ]);
  const [pv, pa] = await Promise.all([s.repo.usage.get(org.id, period, 'voyages'), s.repo.usage.get(org.id, period, 'api_calls')]);
  const payload = buildRiskReport({
    org: { id: org.id, name: org.name, planId: org.planId },
    period,
    now: s.now(),
    voyages,
    shipments,
    cases,
    alerts: s.hub.alerts.filter((a) => fleet.has(a.mmsi)).map((a) => ({ ruleId: a.ruleId, severity: a.severity, ts: a.ts })),
    usage: { voyages: pv, apiCalls: pa, vessels: usage.usage.vessels, users: usage.usage.users },
    valueAtRiskInr: tower.summary.valueAtRiskInr,
  });
  const snap: ReportSnapshot = { id: crypto.randomUUID(), orgId: org.id, kind: 'risk_compliance', period, generatedAt: s.now(), generatedBy: by, payload };
  await s.repo.reports.insert(snap);
  s.log('info', 'report.generated', { org: org.id, period, by });
  s.hub.log(by, 'report.generated', `${org.id} ${period}`);
  emit(s, org.id, 'report.generated', { reportId: snap.id, period, postureScore: payload.postureScore });
  return { ok: true, value: snap };
}

/** Scheduler: customers on a monthly schedule get last month's pack automatically. Returns how many were produced. */
export async function runScheduledReports(s: Services): Promise<number> {
  const period = previousPeriod(periodOf(s.now()));
  let n = 0;
  for (const org of await s.repo.orgs.list()) {
    if (org.kind !== 'shipping_company' || org.status !== 'active') continue;
    if ((await ensureContract(s, org)).reportFrequency !== 'monthly') continue;
    if ((await s.repo.reports.list(org.id)).some((r) => r.period === period && r.generatedBy === 'scheduler')) continue;
    const r = await generateReport(s, org, period, 'scheduler');
    if (r.ok) n++;
  }
  return n;
}

/** Data retention: remove stored reports and webhook delivery logs older than each customer's retention setting. */
export async function runRetention(s: Services): Promise<{ reports: number; deliveries: number }> {
  const out = { reports: 0, deliveries: 0 };
  for (const org of await s.repo.orgs.list()) {
    if (org.kind === 'platform') continue;
    const cutoff = addMonths(s.now(), -(await ensureContract(s, org)).retentionMonths);
    out.reports += await s.repo.reports.purgeBefore(org.id, cutoff);
    out.deliveries += await s.repo.deliveries.purgeBefore(org.id, cutoff);
  }
  if (out.reports + out.deliveries > 0) s.log('info', 'retention.purged', out);
  return out;
}
