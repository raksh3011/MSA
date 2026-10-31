import { describe, expect, it } from 'vitest';
import { evaluateSla, priorityFor, slaDeadlines, slaRemainingMinutes } from '../../src/domain/cases';
import { PLANS, checkQuota, estimateInvoice } from '../../src/domain/plans';
import { ROUTE_TEMPLATES, routeTemplateById } from '../../src/domain/ports';
import { buildView, deliveryRiskOf, projectEta, remainingRouteNm, summarize } from '../../src/domain/supplychain';
import type { CaseRecord, RiskAssessment, Shipment, Voyage } from '../../src/domain/types';
import { applyAction, approvalsRequired, levelOf, monitorVoyage, routeExposure, scoreVoyage } from '../../src/domain/voyage';
import { isAllowedWebhookUrl, signPayload } from '../../src/domain/webhooks';

const H = 3_600_000;
const route = (id: string) => routeTemplateById(id)!.waypoints;
const baseVoyage = (over: Partial<Voyage> = {}): Voyage => ({
  id: 'v1', orgId: 'o', reference: 'VY-1', mmsi: '419200101', vesselName: 'BOC X', originPort: 'INBOM', destinationPort: 'YEADE', waypoints: route('mumbai-aden'),
  etd: 0, eta: 100 * H, cargo: 'crude_oil', status: 'draft', approvalsRequired: [], approvals: [], history: [], createdBy: 'ops', createdAt: 0, updatedAt: 0, ...over,
});
const assessment = (level: RiskAssessment['level'], zones: string[] = ['Gulf of Aden']): RiskAssessment => ({ score: 60, level, factors: [], controls: [], exposure: { totalNm: 1500, highRiskNm: 300, elevatedRiskNm: 0, foreignWatersNm: 0, zones }, assessedAt: 0 });

describe('voyage risk scoring', () => {
  it('measures exposure to risk areas along a route', () => {
    const aden = routeExposure(route('mumbai-aden'));
    expect(aden.highRiskNm).toBeGreaterThan(100);
    expect(aden.zones).toContain('Gulf of Aden');
    const coastal = routeExposure(route('mumbai-kochi'));
    expect(coastal.highRiskNm).toBe(0);
    expect(coastal.totalNm).toBeGreaterThan(500);
  });

  it('scores a Gulf of Aden crude-oil transit higher than a coastal container voyage', () => {
    const risky = scoreVoyage({ waypoints: route('mumbai-aden'), cargo: 'crude_oil', etd: 0, eta: 200 * H });
    const safe = scoreVoyage({ waypoints: route('mumbai-kochi'), cargo: 'containers', etd: 0, eta: 100 * H });
    expect(risky.score).toBeGreaterThan(safe.score);
    expect(['high', 'critical', 'medium']).toContain(risky.level);
    expect(safe.level).toBe('low');
    expect(risky.factors.some((f) => f.code === 'hra')).toBe(true);
    expect(risky.controls.join(' ')).toMatch(/UKMTO|MSCHOA/);
  });

  it('adds points for slow transit through a risk area and for live incidents near the route', () => {
    const fast = scoreVoyage({ waypoints: route('mumbai-aden'), cargo: 'general', etd: 0, eta: 100 * H });
    const slow = scoreVoyage({ waypoints: route('mumbai-aden'), cargo: 'general', etd: 0, eta: 400 * H });
    expect(slow.factors.some((f) => f.code === 'speed')).toBe(true);
    expect(slow.score).toBeGreaterThan(fast.score);
    const live = scoreVoyage({ waypoints: route('mumbai-aden'), cargo: 'general', etd: 0, eta: 100 * H, nearbyUrgentAlerts: 2 });
    expect(live.score).toBe(fast.score + 10);
  });

  it('maps score to level and level to required approvals', () => {
    expect([levelOf(0), levelOf(30), levelOf(60), levelOf(90)]).toEqual(['low', 'medium', 'high', 'critical']);
    expect(approvalsRequired('low')).toEqual([]);
    expect(approvalsRequired('high')).toEqual(['risk_officer']);
    expect(approvalsRequired('critical')).toEqual(['risk_officer', 'org_admin']);
  });
});

describe('voyage state machine', () => {
  const ops = { userId: 'ops', role: 'operator' as const };
  const risk = { userId: 'risk', role: 'risk_officer' as const };
  const admin = { userId: 'adm', role: 'org_admin' as const };

  it('auto-approves low-risk voyages on submit', () => {
    const r = applyAction(baseVoyage(), 'submit', ops, '', 1, assessment('low', []));
    expect(r.ok && r.voyage.status).toBe('approved');
    expect(r.voyage.history.map((h) => h.action)).toEqual(['submitted', 'auto_approved']);
  });

  it('holds higher-risk voyages for approval and enforces the four-eyes rule and notes', () => {
    const sub = applyAction(baseVoyage(), 'submit', ops, '', 1, assessment('high')).voyage;
    expect(sub.status).toBe('submitted');
    expect(applyAction(sub, 'approve', ops, 'x', 2).ok).toBe(false); // an operator cannot approve
    const self = applyAction({ ...sub, createdBy: 'risk' }, 'approve', risk, 'ok', 2);
    expect(self.ok).toBe(false);
    expect(self.error).toMatch(/Four-eyes/);
    expect(applyAction(sub, 'approve', risk, '', 2).error).toMatch(/justification|conditions/);
    expect(applyAction(sub, 'reject', risk, '', 2).error).toMatch(/note is required/);
    const ok = applyAction(sub, 'approve', risk, 'BMP5 measures in place', 2);
    expect(ok.voyage.status).toBe('approved');
    expect(ok.voyage.conditions).toBe('BMP5 measures in place');
  });

  it('requires two distinct approvers for a critical voyage', () => {
    const sub = applyAction(baseVoyage(), 'submit', ops, '', 1, assessment('critical')).voyage;
    const first = applyAction(sub, 'approve', risk, 'risk officer conditions', 2).voyage;
    expect(first.status).toBe('submitted');
    expect(applyAction(first, 'approve', risk, 'again', 3).ok).toBe(false); // same person twice
    const second = applyAction(first, 'approve', admin, 'admin sign-off', 3).voyage;
    expect(second.status).toBe('approved');
    expect(second.approvals.length).toBe(2);
  });

  it('supports request-changes then resubmission, start, complete and guards invalid transitions', () => {
    const sub = applyAction(baseVoyage(), 'submit', ops, '', 1, assessment('medium')).voyage;
    const changes = applyAction(sub, 'request_changes', risk, 'Route via the northern lane', 2).voyage;
    expect(changes.status).toBe('changes_requested');
    const re = applyAction(changes, 'submit', ops, '', 3, assessment('low', [])).voyage;
    expect(re.status).toBe('approved');
    expect(applyAction(baseVoyage(), 'start', ops, '', 1).ok).toBe(false);
    const started = applyAction(re, 'start', ops, 'sailed', 4).voyage;
    expect(started.status).toBe('active');
    expect(applyAction(started, 'cancel', ops, '', 5).ok).toBe(false);
    expect(applyAction(started, 'complete', ops, 'arrived', 6).voyage.status).toBe('completed');
    expect(applyAction(baseVoyage(), 'submit', { userId: 'x', role: 'analyst' }, '', 1, assessment('low')).ok).toBe(false);
  });

  it('only the creator or an org admin can cancel', () => {
    const v = baseVoyage();
    expect(applyAction(v, 'cancel', { userId: 'other', role: 'operator' }, '', 1).ok).toBe(false);
    expect(applyAction(v, 'cancel', ops, '', 1).voyage.status).toBe('cancelled');
    expect(applyAction(v, 'cancel', admin, '', 1).voyage.status).toBe('cancelled');
  });
});

describe('voyage monitoring', () => {
  const active = baseVoyage({ status: 'active', assessment: assessment('high', ['Gulf of Aden']) });
  it('flags a vessel far from its approved route', () => {
    expect(monitorVoyage(active, { lat: 15.5, lon: 60.0 }).some((f) => f.type === 'deviation')).toBe(false); // on the approved route
    expect(monitorVoyage(active, { lat: 6, lon: 90 }).some((f) => f.type === 'deviation')).toBe(true);
  });
  it('flags an unplanned entry into a risk area and ignores inactive voyages', () => {
    const noExposure = baseVoyage({ status: 'active', assessment: assessment('low', []) });
    expect(monitorVoyage(noExposure, { lat: 13, lon: 48 }).some((f) => f.type === 'unplanned_exposure')).toBe(true);
    expect(monitorVoyage({ ...noExposure, status: 'approved' }, { lat: 13, lon: 48 })).toEqual([]);
    expect(monitorVoyage(active, undefined)).toEqual([]);
  });
});

describe('case SLA', () => {
  const kase = (over: Partial<CaseRecord> = {}): CaseRecord => {
    const p = priorityFor('distress');
    return {
      id: 'c', orgId: 'o', reporter: 'u', reporterRole: 'operator', mmsi: '419000001', vesselName: 'V', lat: 1, lon: 1, category: 'distress', note: '', status: 'open', priority: p,
      station: { id: 'kochi', name: 'K', distanceNm: 1, desk: 'kochi' }, manual: false, createdAt: 0, ...slaDeadlines(p, 0), escalationLevel: 0, slaBreached: false, history: [], ...over,
    };
  };
  it('derives priority and deadlines from the category', () => {
    expect(['distress', 'illegal_activity', 'suspicious_behaviour', 'other'].map((c) => priorityFor(c as never))).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(slaDeadlines('P2', 1000)).toEqual({ ackDueAt: 1000 + 15 * 60_000, resolveDueAt: 1000 + 240 * 60_000 });
  });
  it('escalates to the desk lead when unacknowledged, then to the regional controller at twice the SLA or on resolution breach', () => {
    const c = kase();
    expect(evaluateSla(c, 4 * 60_000)).toBeNull();
    expect(evaluateSla(c, 6 * 60_000)).toMatchObject({ level: 1, reason: 'ack_overdue' });
    expect(evaluateSla({ ...c, escalationLevel: 1 }, 6 * 60_000)).toBeNull();
    expect(evaluateSla({ ...c, escalationLevel: 1 }, 11 * 60_000)).toMatchObject({ level: 2 });
    expect(evaluateSla({ ...c, status: 'investigating', escalationLevel: 1 }, 61 * 60_000)).toMatchObject({ level: 2, reason: 'resolve_overdue' });
    expect(evaluateSla({ ...c, status: 'closed' }, 99 * 60_000)).toBeNull();
    expect(slaRemainingMinutes(c, 60_000)).toBe(4);
    expect(slaRemainingMinutes({ ...c, status: 'closed' }, 0)).toBeNull();
  });
});

describe('plans, quotas and invoice estimate', () => {
  it('enforces hard quotas and prices usage above the voyage allowance', () => {
    expect(checkQuota(PLANS.starter, 'vessels', 4).ok).toBe(true);
    expect(checkQuota(PLANS.starter, 'vessels', 5).ok).toBe(false);
    expect(checkQuota(PLANS.professional, 'users', 9).ok).toBe(true);
    expect(estimateInvoice(PLANS.professional, { voyages: 50, api_calls: 0 }).totalInr).toBe(49_000);
    expect(estimateInvoice(PLANS.professional, { voyages: 53, api_calls: 0 })).toMatchObject({ overageVoyages: 3, overageInr: 4500, totalInr: 53_500 });
  });
});

describe('webhook safety and signing', () => {
  it('only allows public https targets', () => {
    expect(isAllowedWebhookUrl('https://erp.example.com/hook').ok).toBe(true);
    for (const bad of ['http://erp.example.com/h', 'https://localhost/h', 'https://127.0.0.1/h', 'https://10.0.0.5/h', 'https://192.168.1.1/h', 'https://172.20.0.1/h', 'https://169.254.169.254/latest', 'https://svc.internal/h', 'https://user:pw@example.com/h', 'ftp://x.com', 'not a url']) {
      expect(isAllowedWebhookUrl(bad).ok, bad).toBe(false);
    }
    expect(isAllowedWebhookUrl('http://localhost:9/h', true).ok).toBe(true);
  });
  it('produces a stable HMAC signature that changes with secret, time and body', async () => {
    const a = await signPayload('s', 1, 'body');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await signPayload('s', 1, 'body')).toBe(a);
    expect(await signPayload('t', 1, 'body')).not.toBe(a);
    expect(await signPayload('s', 2, 'body')).not.toBe(a);
    expect(await signPayload('s', 1, 'bodY')).not.toBe(a);
  });
});

describe('supply chain: ETA projection and delivery risk', () => {
  const lane = route('mumbai-kochi');
  const ship = (over: Partial<Shipment> = {}): Shipment => ({
    id: 's', orgId: 'o', reference: 'PO-1', customer: 'C', commodity: 'x', cargo: 'general', quantity: 1, unit: 'MT', valueInr: 1_000_000, incoterm: 'FOB', originPort: 'INBOM', destinationPort: 'INCOK',
    requiredBy: 100 * H, status: 'booked', deliveryRisk: 'unplanned', createdBy: 'u', createdAt: 0, updatedAt: 0, history: [], ...over,
  });

  it('computes remaining distance along the route from the nearest point', () => {
    const total = remainingRouteNm(lane, { lat: lane[0]![0], lon: lane[0]![1] });
    const mid = remainingRouteNm(lane, { lat: lane[2]![0], lon: lane[2]![1] });
    expect(total).toBeGreaterThan(mid);
    expect(remainingRouteNm(lane, { lat: lane[lane.length - 1]![0], lon: lane[lane.length - 1]![1] })).toBeLessThan(2);
  });

  it('projects ETA from live position for active voyages, from the plan otherwise', () => {
    const v = baseVoyage({ status: 'active', waypoints: lane, eta: 500 * H });
    const live = { lat: lane[1]![0], lon: lane[1]![1], sog: 12 };
    const p = projectEta(v, live, 10 * H);
    expect(p.basis).toBe('live');
    expect(p.eta).toBeGreaterThan(10 * H);
    expect(p.eta).toBeLessThan(500 * H);
    expect(projectEta({ ...v, status: 'approved' }, live, 10 * H)).toEqual({ eta: 500 * H, basis: 'planned' });
  });

  it('grades delivery risk by buffer, voyage risk and approval state', () => {
    const v = baseVoyage({ status: 'active', assessment: assessment('low', []) });
    expect(deliveryRiskOf(ship(), undefined, undefined, 0)).toBe('unplanned');
    expect(deliveryRiskOf(ship({ requiredBy: 50 * H }), v, 60 * H, 0)).toBe('late');
    expect(deliveryRiskOf(ship({ requiredBy: 70 * H }), v, 60 * H, 0)).toBe('at_risk');
    expect(deliveryRiskOf(ship({ requiredBy: 200 * H }), v, 60 * H, 0)).toBe('on_track');
    expect(deliveryRiskOf(ship({ requiredBy: 100 * H }), { ...v, assessment: assessment('high') }, 60 * H, 0)).toBe('at_risk'); // 40h buffer on a high-risk voyage
    expect(deliveryRiskOf(ship(), { ...v, status: 'rejected' }, 10 * H, 0)).toBe('at_risk');
    expect(deliveryRiskOf(ship({ requiredBy: 300 * H }), { ...v, status: 'submitted', etd: 10 * H }, 10 * H, 0)).toBe('at_risk'); // still unapproved a day before departure
  });

  it('exposes cargo value on risky routes and summarises the portfolio', () => {
    const risky = baseVoyage({ status: 'active', assessment: assessment('high') });
    const views = [
      buildView(ship({ id: 'a', status: 'in_transit', valueInr: 5_000_000, requiredBy: 1000 * H }), risky, { lat: 15, lon: 70, sog: 12 }, 0),
      buildView(ship({ id: 'b', valueInr: 1_000_000 }), undefined, undefined, 0),
      buildView(ship({ id: 'c', status: 'delivered', valueInr: 9_000_000 }), risky, undefined, 0),
    ];
    expect(views[0]?.valueAtRiskInr).toBe(5_000_000);
    expect(views[0]?.advisories.join(' ')).toMatch(/insurance|insurer/);
    expect(views[2]?.valueAtRiskInr).toBe(0);
    const sum = summarize(views);
    expect(sum).toMatchObject({ shipments: 3, inTransit: 1, valueInTransitInr: 5_000_000, valueAtRiskInr: 5_000_000, unplanned: 1 });
  });
});

describe('catalogue', () => {
  it('route templates are well-formed', () => {
    expect(ROUTE_TEMPLATES.length).toBeGreaterThan(8);
    for (const t of ROUTE_TEMPLATES) expect(t.waypoints.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ROUTE_TEMPLATES.map((t) => t.id)).size).toBe(ROUTE_TEMPLATES.length);
  });
});
