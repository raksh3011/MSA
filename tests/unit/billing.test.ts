import { describe, expect, it } from 'vitest';
import { GST_RATE, amountDue, applyPayment, buildInvoice, defaultContract, invoiceCsv, invoiceNumber, mrrOf, periodBounds, previousPeriod, receivables, viewStatus } from '../../src/domain/billing';
import { buildRiskReport, caseAnalytics, reportCsv } from '../../src/domain/reports';
import type { CaseRecord, Organization, Voyage } from '../../src/domain/types';

const DAY = 86_400_000;
const org: Organization = { id: 'org-acme', name: 'Acme Shipping', kind: 'shipping_company', planId: 'professional', status: 'active', createdAt: Date.UTC(2026, 0, 1) };
const contract = { ...defaultContract(org, 'admin', Date.UTC(2026, 0, 1)) };

describe('billing rules', () => {
  it('derives periods correctly across year boundaries', () => {
    expect(previousPeriod('2026-01')).toBe('2025-12');
    expect(previousPeriod('2026-03')).toBe('2026-02');
    expect(periodBounds('2026-02')).toEqual({ from: Date.UTC(2026, 1, 1), to: Date.UTC(2026, 2, 1) });
  });

  it('builds an invoice: subscription + support add-on, then GST at 18%', () => {
    const inv = buildInvoice({ org, contract, period: '2026-09', voyages: 10, issuedAt: Date.UTC(2026, 9, 1), id: 'i1' });
    expect(inv?.lines.map((l) => l.amountInr)).toEqual([49_000, 15_000]);
    expect(inv?.subtotalInr).toBe(64_000);
    expect(inv?.gstInr).toBeCloseTo(64_000 * GST_RATE, 2);
    expect(inv?.totalInr).toBeCloseTo(64_000 * (1 + GST_RATE), 2);
    expect(inv?.number).toBe(invoiceNumber('org-acme', '2026-09'));
  });

  it('adds a usage-based overage line only above the plan allowance', () => {
    const under = buildInvoice({ org, contract, period: '2026-09', voyages: 50, issuedAt: 0, id: 'a' });
    const over = buildInvoice({ org, contract, period: '2026-09', voyages: 53, issuedAt: 0, id: 'b' });
    expect(under?.lines).toHaveLength(2);
    expect(over?.lines).toHaveLength(3);
    expect(over?.lines[2]).toMatchObject({ quantity: 3, unitInr: 1500, amountInr: 4500 });
  });

  it('does not invoice a free plan with no overage', () => {
    const free: Organization = { ...org, planId: 'starter' };
    expect(buildInvoice({ org: free, contract: defaultContract(free, 'a', 0), period: '2026-09', voyages: 3, issuedAt: 0, id: 'x' })).toBeUndefined();
    expect(buildInvoice({ org: free, contract: defaultContract(free, 'a', 0), period: '2026-09', voyages: 8, issuedAt: 0, id: 'x' })?.lines[0]?.amountInr).toBe(3 * 2500);
  });

  it('computes monthly recurring revenue including support', () => {
    expect(mrrOf('professional', { supportTier: 'priority' })).toBe(64_000);
    expect(mrrOf('starter', { supportTier: 'standard' })).toBe(0);
  });

  it('derives overdue from the due date and settles on payment', () => {
    const inv = buildInvoice({ org, contract, period: '2026-09', voyages: 1, issuedAt: 1_000_000, id: 'i' })!;
    expect(viewStatus(inv, inv.dueAt - 1)).toBe('issued');
    expect(viewStatus(inv, inv.dueAt + 1)).toBe('overdue');
    expect(amountDue(inv)).toBe(inv.totalInr);
    const paid = applyPayment(inv, 'upi', 'admin', inv.dueAt + DAY, 'p1', 'SBX-1');
    expect(paid.status).toBe('paid');
    expect(amountDue(paid)).toBe(0);
    expect(viewStatus(paid, inv.dueAt + 100 * DAY)).toBe('paid');
  });

  it('summarises receivables', () => {
    const a = buildInvoice({ org, contract, period: '2026-08', voyages: 1, issuedAt: 0, id: 'a' })!;
    const b = buildInvoice({ org, contract, period: '2026-09', voyages: 1, issuedAt: 50 * DAY, id: 'b' })!;
    const paidA = applyPayment(a, 'card', 'u', 1, 'p', 'r');
    const r = receivables([paidA, b], 60 * DAY);
    expect(r.collectedInr).toBeCloseTo(a.totalInr, 2);
    expect(r.outstandingInr).toBeCloseTo(b.totalInr, 2);
    expect(r.overdueInr).toBe(0);
    expect(receivables([b], 80 * DAY).overdueInvoices).toBe(1);
  });

  it('neutralises spreadsheet formulas in the CSV export', () => {
    const inv = buildInvoice({ org: { ...org, name: '=HYPERLINK("x")' }, contract, period: '2026-09', voyages: 1, issuedAt: 0, id: 'i' })!;
    const csv = invoiceCsv(inv, '=HYPERLINK("x")');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv.split('\n').every((l) => !l.startsWith('='))).toBe(true);
  });
});

const caseOf = (over: Partial<CaseRecord>): CaseRecord => ({
  id: 'c', orgId: 'o', reporter: 'u', reporterRole: 'operator', mmsi: '1', vesselName: 'V', lat: 0, lon: 0, category: 'other', note: '', status: 'closed', priority: 'P3',
  station: { id: 'kochi', name: 'Kochi', distanceNm: 10, desk: 'kochi' }, manual: false, createdAt: 0, ackDueAt: 1, resolveDueAt: 2, escalationLevel: 0, slaBreached: false, history: [], ...over,
});

describe('case analytics', () => {
  it('measures SLA compliance, response times and closure mix', () => {
    const a = caseAnalytics([
      caseOf({ id: '1', ackedAt: 10 * 60_000, closedAt: 2 * 3_600_000, closureCode: 'resolved' }),
      caseOf({ id: '2', ackedAt: 30 * 60_000, closedAt: 4 * 3_600_000, closureCode: 'false_alarm', slaBreached: true, escalationLevel: 1 }),
      caseOf({ id: '3', status: 'open' }),
    ]);
    expect(a.total).toBe(3);
    expect(a.open).toBe(1);
    expect(a.closed).toBe(2);
    expect(a.escalated).toBe(1);
    expect(a.slaMetPct).toBe(50);
    expect(a.avgAckMinutes).toBe(20);
    expect(a.avgResolveHours).toBe(3);
    expect(a.byClosure).toEqual({ resolved: 1, false_alarm: 1 });
    expect(a.closedWithoutReport).toBe(2);
  });

  it('returns null rates rather than dividing by zero', () => {
    const a = caseAnalytics([]);
    expect(a.slaMetPct).toBeNull();
    expect(a.avgAckMinutes).toBeNull();
  });
});

describe('risk report', () => {
  const voyage = (over: Partial<Voyage>): Voyage => ({
    id: 'v', orgId: 'org-acme', reference: 'VY-1', mmsi: '419000001', vesselName: 'X', originPort: 'A', destinationPort: 'B', waypoints: [], etd: 0, eta: 0, cargo: 'general', status: 'completed',
    assessment: { score: 70, level: 'high', factors: [], controls: [], exposure: { totalNm: 1, highRiskNm: 0, elevatedRiskNm: 0, foreignWatersNm: 0, zones: [] }, assessedAt: 0 },
    approvalsRequired: ['risk_officer'], approvals: [{ role: 'risk_officer', userId: 'ro', decision: 'approved', note: 'BMP5', ts: 3_600_000 * 5 }],
    history: [{ ts: 3_600_000, actor: 'op', action: 'submitted' }], createdBy: 'op', createdAt: Date.UTC(2026, 8, 5), updatedAt: Date.UTC(2026, 8, 20), ...over,
  });
  const base = { org: { id: 'org-acme', name: 'Acme', planId: 'professional' as const }, period: '2026-09', now: 0, shipments: [], cases: [], alerts: [], usage: { voyages: 1, apiCalls: 0, vessels: 1, users: 1 }, valueAtRiskInr: 0 };

  it('passes the approval controls for a well-governed voyage and scores 100', () => {
    const r = buildRiskReport({ ...base, voyages: [voyage({})] });
    expect(r.compliance.passRatePct).toBe(100);
    expect(r.postureScore).toBe(100);
    expect(r.voyages.avgApprovalHours).toBe(4);
  });

  it('flags a voyage approved by its own preparer and lowers the score', () => {
    const r = buildRiskReport({ ...base, voyages: [voyage({ approvals: [{ role: 'risk_officer', userId: 'op', decision: 'approved', note: 'ok', ts: 1 }] })] });
    expect(r.compliance.checks.find((c) => c.id === 'four_eyes')?.passed).toBe(0);
    expect(r.postureScore).toBeLessThan(100);
  });

  it('only counts activity inside the period', () => {
    const r = buildRiskReport({ ...base, period: '2026-05', voyages: [voyage({})] });
    expect(r.voyages.total).toBe(0);
    expect(reportCsv(r)).toContain('section,metric,value');
  });
});
