/** Compliance and performance reporting: pure aggregation over business records. */
import { periodBounds } from './billing';
import type { CaseAnalytics, CaseRecord, PlanId, RiskReport, Shipment, Voyage } from './types';

const count = <T>(items: T[], key: (x: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
};
const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const r1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

/** Service-level performance of case handling (used by the analyst dashboard and by the monthly report). */
export function caseAnalytics(cases: CaseRecord[]): CaseAnalytics {
  const closed = cases.filter((c) => c.status === 'closed');
  const acked = cases.filter((c) => c.ackedAt !== undefined);
  const byDesk = Object.entries(count(cases, (c) => c.station.desk)).map(([desk, total]) => {
    const mine = cases.filter((c) => c.station.desk === desk);
    const done = mine.filter((c) => c.status === 'closed');
    return { desk, total, open: mine.length - done.length, slaMetPct: pct(done.filter((c) => !c.slaBreached).length, done.length) };
  });
  return {
    total: cases.length,
    open: cases.length - closed.length,
    closed: closed.length,
    escalated: cases.filter((c) => c.escalationLevel > 0).length,
    slaMetPct: pct(closed.filter((c) => !c.slaBreached).length, closed.length),
    avgAckMinutes: r1(avg(acked.map((c) => ((c.ackedAt as number) - c.createdAt) / 60_000))),
    avgResolveHours: r1(avg(closed.map((c) => ((c.closedAt ?? c.createdAt) - c.createdAt) / 3_600_000))),
    byPriority: count(cases, (c) => c.priority),
    byCategory: count(cases, (c) => c.category),
    byClosure: count(closed, (c) => c.closureCode ?? 'unspecified'),
    byDesk: byDesk.sort((a, b) => b.total - a.total),
    postIncidentFiled: closed.filter((c) => c.postIncident).length,
    closedWithoutReport: closed.filter((c) => !c.postIncident).length,
  };
}

export interface ReportInput {
  org: { id: string; name: string; planId: PlanId };
  period: string;
  now: number;
  voyages: Voyage[];
  shipments: Shipment[];
  cases: CaseRecord[];
  alerts: Array<{ ruleId: string; severity: string; ts: number }>;
  usage: { voyages: number; apiCalls: number; vessels: number; users: number };
  valueAtRiskInr: number;
}

const within = (ts: number, from: number, to: number): boolean => ts >= from && ts < to;

/** Four-eyes and approval-control checks over the period's voyages: evidence an insurer or auditor can inspect. */
function complianceChecks(voyages: Voyage[]) {
  const decided = voyages.filter((v) => ['approved', 'active', 'completed'].includes(v.status) && v.approvalsRequired.length > 0);
  const covered = (v: Voyage) => v.approvalsRequired.every((r) => v.approvals.some((a) => a.decision === 'approved' && (a.role === r || (a.role === 'org_admin' && r === 'risk_officer'))));
  const critical = voyages.filter((v) => v.assessment?.level === 'critical' && ['approved', 'active', 'completed'].includes(v.status));
  const withNotes = decided.filter((v) => v.assessment && (v.assessment.level === 'high' || v.assessment.level === 'critical'));
  const sailed = voyages.filter((v) => ['active', 'completed'].includes(v.status));
  return [
    { id: 'approvals_complete', label: 'Voyages that sailed with every required approval recorded', passed: decided.filter(covered).length, total: decided.length },
    { id: 'four_eyes', label: 'Voyages approved by someone other than the preparer', passed: decided.filter((v) => v.approvals.every((a) => a.userId !== v.createdBy)).length, total: decided.length },
    { id: 'critical_two_people', label: 'Critical voyages approved by two distinct people', passed: critical.filter((v) => new Set(v.approvals.filter((a) => a.decision === 'approved').map((a) => a.userId)).size >= 2).length, total: critical.length },
    { id: 'conditions_recorded', label: 'High / critical approvals with documented conditions', passed: withNotes.filter((v) => v.approvals.some((a) => a.decision === 'approved' && a.note.trim().length > 0)).length, total: withNotes.length },
    { id: 'risk_assessed', label: 'Voyages that sailed with a stored risk assessment', passed: sailed.filter((v) => v.assessment).length, total: sailed.length },
  ];
}

export function buildRiskReport(input: ReportInput): RiskReport {
  const { from, to } = periodBounds(input.period);
  const voyages = input.voyages.filter((v) => within(v.createdAt, from, to) || within(v.updatedAt, from, to));
  const shipments = input.shipments.filter((x) => within(x.createdAt, from, to) || within(x.updatedAt, from, to));
  const cases = input.cases.filter((c) => within(c.createdAt, from, to));
  const alerts = input.alerts.filter((a) => within(a.ts, from, to));

  const approvalHours = voyages.flatMap((v) => {
    const submitted = v.history.find((e) => e.action === 'submitted');
    const lastApproval = [...v.approvals].reverse().find((a) => a.decision === 'approved');
    return submitted && lastApproval && v.approvalsRequired.length > 0 ? [(lastApproval.ts - submitted.ts) / 3_600_000] : [];
  });
  const delivered = shipments.filter((x) => x.status === 'delivered');
  const checks = complianceChecks(voyages);
  const checked = checks.reduce((a, c) => a + c.total, 0);
  const passed = checks.reduce((a, c) => a + c.passed, 0);
  const incidents = caseAnalytics(cases);

  const deviations = alerts.filter((a) => a.ruleId === 'voyage_deviation' || a.ruleId === 'voyage_exposure').length;
  const lateShipments = shipments.filter((x) => x.deliveryRisk === 'late').length;
  const ruleCounts = Object.entries(count(alerts, (a) => a.ruleId)).map(([rule, n]) => ({ rule, count: n })).sort((a, b) => b.count - a.count).slice(0, 5);

  // Posture score (0-100): starts at 100 and loses points for control failures and service misses; documented in the report.
  const penalties =
    Math.min(30, deviations * 5) + Math.min(25, lateShipments * 10) + Math.min(20, incidents.escalated * 5) +
    (checked > 0 ? Math.round((1 - passed / checked) * 25) : 0);
  const postureScore = Math.max(0, 100 - penalties);

  const headline: string[] = [];
  headline.push(`${voyages.length} voyages in scope; ${voyages.filter((v) => ['approved', 'active', 'completed'].includes(v.status)).length} approved or sailed, ${voyages.filter((v) => v.status === 'submitted').length} awaiting a decision.`);
  if (deviations > 0) headline.push(`${deviations} route deviation / unplanned risk-area exposure alert${deviations === 1 ? '' : 's'} raised against active voyages.`);
  if (shipments.length > 0) headline.push(`${shipments.length} shipments tracked; ${delivered.length} delivered${lateShipments ? `, ${lateShipments} projected late` : ''}; INR ${(input.valueAtRiskInr / 1e7).toFixed(1)} crore of cargo currently exposed.`);
  if (incidents.total > 0) headline.push(`${incidents.total} suspicious-vessel report${incidents.total === 1 ? '' : 's'}: ${incidents.escalated} escalated, SLA met on ${incidents.slaMetPct ?? 'n/a'}% of closed cases.`);
  if (checked > 0) headline.push(`Approval controls: ${passed} of ${checked} checks passed (${pct(passed, checked)}%).`);

  return {
    period: input.period,
    org: input.org,
    generatedAt: input.now,
    headline,
    postureScore,
    voyages: {
      total: voyages.length,
      byStatus: count(voyages, (v) => v.status),
      byRiskLevel: count(voyages.filter((v) => v.assessment), (v) => v.assessment?.level ?? 'unassessed'),
      awaitingApproval: voyages.filter((v) => v.status === 'submitted').length,
      avgApprovalHours: r1(avg(approvalHours)),
      deviations,
    },
    shipments: {
      total: shipments.length,
      delivered: delivered.length,
      onTimePct: pct(delivered.filter((x) => x.updatedAt <= x.requiredBy).length, delivered.length),
      valueMovedInr: delivered.reduce((a, x) => a + x.valueInr, 0),
      valueAtRiskInr: input.valueAtRiskInr,
      byRisk: count(shipments, (x) => x.deliveryRisk),
    },
    incidents,
    alerts: { total: alerts.length, bySeverity: count(alerts, (a) => a.severity), topRules: ruleCounts },
    usage: input.usage,
    compliance: { checks, passRatePct: pct(passed, checked) },
  };
}

const cell = (v: string | number | null): string => {
  const t = v === null ? '' : String(v);
  return /^[=+\-@\t\r]/.test(t) ? `'${t}` : /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** Flat CSV of the headline numbers (section, metric, value) for spreadsheets and insurers. */
export function reportCsv(r: RiskReport): string {
  const rows: Array<[string, string, string | number | null]> = [
    ['summary', 'organisation', r.org.name], ['summary', 'period', r.period], ['summary', 'risk_posture_score', r.postureScore],
    ['voyages', 'total', r.voyages.total], ['voyages', 'awaiting_approval', r.voyages.awaitingApproval], ['voyages', 'avg_approval_hours', r.voyages.avgApprovalHours], ['voyages', 'deviation_alerts', r.voyages.deviations],
    ...Object.entries(r.voyages.byStatus).map(([k, v]): [string, string, number] => ['voyages_by_status', k, v]),
    ...Object.entries(r.voyages.byRiskLevel).map(([k, v]): [string, string, number] => ['voyages_by_risk', k, v]),
    ['shipments', 'total', r.shipments.total], ['shipments', 'delivered', r.shipments.delivered], ['shipments', 'on_time_pct', r.shipments.onTimePct], ['shipments', 'value_moved_inr', r.shipments.valueMovedInr], ['shipments', 'value_at_risk_inr', r.shipments.valueAtRiskInr],
    ['incidents', 'total', r.incidents.total], ['incidents', 'escalated', r.incidents.escalated], ['incidents', 'sla_met_pct', r.incidents.slaMetPct], ['incidents', 'avg_ack_minutes', r.incidents.avgAckMinutes], ['incidents', 'avg_resolve_hours', r.incidents.avgResolveHours],
    ['alerts', 'total', r.alerts.total], ...Object.entries(r.alerts.bySeverity).map(([k, v]): [string, string, number] => ['alerts_by_severity', k, v]),
    ...r.compliance.checks.map((c): [string, string, string] => ['compliance', c.label, `${c.passed}/${c.total}`]),
    ['usage', 'voyages', r.usage.voyages], ['usage', 'api_calls', r.usage.apiCalls],
  ];
  return ['section,metric,value', ...rows.map((x) => x.map(cell).join(','))].join('\n');
}
