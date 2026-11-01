/** Executive overview for a customer organisation: one call that joins every business module. */
import { PLANS } from '../domain/plans';
import { amountDue, viewStatus } from '../domain/billing';
import type { Organization } from '../domain/types';
import type { Services } from './context';
import { ensureContract } from './billing';
import { fleetMmsis, usageSummary } from './org';
import { controlTower } from './shipments';

const pct = (used: number, limit: number): number => (limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100)));

export async function organizationOverview(s: Services, org: Organization, user: { username: string; role: string }) {
  const now = s.now();
  const [voyages, tower, cases, invoices, contract, usage, fleet] = await Promise.all([
    s.repo.voyages.list(org.id), controlTower(s, org.id), s.repo.cases.list({ orgId: org.id }), s.repo.invoices.list(org.id), ensureContract(s, org), usageSummary(s, org), fleetMmsis(s, org.id),
  ]);
  const plan = PLANS[org.planId];
  const live = [...fleet].filter((m) => s.hub.vessels.has(m));
  const awaiting = voyages.filter((v) => v.status === 'submitted');
  const waitingOnMe = awaiting.filter((v) => v.createdBy !== user.username && (user.role === 'org_admin' || user.role === 'risk_officer')).length;
  const openCases = cases.filter((c) => c.status !== 'closed');
  const open = invoices.filter((i) => i.status === 'issued');
  const fleetAlerts = s.hub.alerts.filter((a) => fleet.has(a.mmsi) && a.status === 'open');
  const funnel = (['draft', 'submitted', 'approved', 'active', 'completed'] as const).map((status) => ({ status, count: voyages.filter((v) => v.status === status).length }));
  const attention: Array<{ level: 'crit' | 'warn' | 'info'; text: string; tab: string }> = [];
  if (tower.summary.late > 0) attention.push({ level: 'crit', text: `${tower.summary.late} shipment${tower.summary.late === 1 ? ' is' : 's are'} projected to miss the delivery commitment`, tab: 'supply' });
  if (waitingOnMe > 0) attention.push({ level: 'warn', text: `${waitingOnMe} voyage${waitingOnMe === 1 ? '' : 's'} waiting for your approval`, tab: 'voyages' });
  const overdue = open.filter((i) => viewStatus(i, now) === 'overdue');
  if (overdue.length > 0) attention.push({ level: 'crit', text: `${overdue.length} invoice${overdue.length === 1 ? ' is' : 's are'} overdue (INR ${Math.round(overdue.reduce((a, i) => a + amountDue(i), 0)).toLocaleString('en-IN')})`, tab: 'billing' });
  else if (open.length > 0) attention.push({ level: 'info', text: `${open.length} invoice${open.length === 1 ? '' : 's'} awaiting payment`, tab: 'billing' });
  if (tower.summary.atRisk > 0) attention.push({ level: 'warn', text: `${tower.summary.atRisk} shipment${tower.summary.atRisk === 1 ? '' : 's'} at risk of delay`, tab: 'supply' });
  if (openCases.some((c) => c.escalationLevel > 0)) attention.push({ level: 'warn', text: 'A report you filed has been escalated by the Coast Guard SLA engine', tab: 'incidents' });
  const fl = Object.entries(plan.limits).filter(([k]) => ['vessels', 'users', 'voyagesPerMonth', 'apiCallsPerMonth'].includes(k));
  return {
    org: { id: org.id, name: org.name, planId: org.planId, planName: plan.name },
    fleet: { registered: usage.usage.vessels, tracked: live.length },
    voyages: { total: voyages.length, funnel, awaitingApproval: awaiting.length, waitingOnMe, active: voyages.filter((v) => v.status === 'active').length },
    supplyChain: tower.summary,
    incidents: { open: openCases.length, escalated: openCases.filter((c) => c.escalationLevel > 0).length },
    alerts: { openFleetAlerts: fleetAlerts.length, critical: fleetAlerts.filter((a) => a.severity === 'critical').length },
    commercial: {
      mrrInr: plan.monthlyFeeInr,
      supportTier: contract.supportTier,
      estimateInr: usage.invoiceEstimate.totalInr,
      outstandingInr: Math.round(open.reduce((a, i) => a + amountDue(i), 0)),
      renewsAt: contract.renewsAt,
    },
    quotas: fl.map(([metric, limit]) => {
      const used = metric === 'vessels' ? usage.usage.vessels : metric === 'users' ? usage.usage.users : metric === 'voyagesPerMonth' ? usage.usage.voyages : usage.usage.apiCalls;
      return { metric, used, limit: limit as number, pct: pct(used, limit as number) };
    }),
    attention,
  };
}
