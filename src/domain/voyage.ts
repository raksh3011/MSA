/**
 * Voyage risk management: route risk scoring, approval policy, the voyage state machine and live monitoring.
 * Everything here is a pure function so it can be unit-tested and reused by the API, the Worker and the tests.
 */
import { destination, distanceNm, distanceToLineNm, bearingDeg, pointInPolygon, type LatLon } from '../core/geo';
import type { Role } from '../core/types';
import { FOREIGN_WATERS, HIGH_RISK_ZONES } from '../core/zones';
import type { Approval, ApprovalRole, CargoType, RiskAssessment, RiskFactor, RiskLevel, Voyage, VoyageStatus } from './types';

// ── route geometry ───────────────────────────────────────────────────────────
export function routeLengthNm(route: readonly LatLon[]): number {
  let n = 0;
  for (let i = 0; i < route.length - 1; i++) n += distanceNm(route[i] as LatLon, route[i + 1] as LatLon);
  return n;
}

/** Sample a route every `stepNm` (and at the end). */
export function sampleRoute(route: readonly LatLon[], stepNm = 10): LatLon[] {
  const out: LatLon[] = [];
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i] as LatLon;
    const b = route[i + 1] as LatLon;
    const d = distanceNm(a, b);
    const brg = bearingDeg(a, b);
    const n = Math.max(1, Math.ceil(d / stepNm));
    for (let k = 0; k < n; k++) out.push(destination(a, brg, (d / n) * k));
  }
  if (route.length > 0) out.push(route[route.length - 1] as LatLon);
  return out;
}

export interface Exposure {
  totalNm: number;
  highRiskNm: number;
  elevatedRiskNm: number;
  foreignWatersNm: number;
  zones: string[];
}

/** Nautical miles of the route inside high-risk / elevated-risk areas and neighbouring waters. */
export function routeExposure(route: readonly LatLon[], stepNm = 10): Exposure {
  const pts = sampleRoute(route, stepNm);
  const total = routeLengthNm(route);
  const per = pts.length > 1 ? total / (pts.length - 1) : 0;
  let high = 0;
  let elevated = 0;
  let foreign = 0;
  const zones = new Set<string>();
  for (const p of pts) {
    const z = HIGH_RISK_ZONES.find((r) => pointInPolygon(p[0], p[1], r.polygon));
    if (z) {
      zones.add(z.name);
      if (z.level === 'high') high += per;
      else elevated += per;
    }
    if (FOREIGN_WATERS.some((f) => f.area.contains(p[0], p[1]))) foreign += per;
  }
  return {
    totalNm: Math.round(total),
    highRiskNm: Math.round(high),
    elevatedRiskNm: Math.round(elevated),
    foreignWatersNm: Math.round(foreign),
    zones: [...zones],
  };
}

// ── risk scoring ─────────────────────────────────────────────────────────────
const HAZARDOUS: readonly CargoType[] = ['crude_oil', 'refined_products', 'chemicals', 'lng_lpg'];

export interface ScoreInput {
  waypoints: readonly LatLon[];
  cargo: CargoType;
  etd: number;
  eta: number;
  /** open high/critical alerts near the route right now (live context) */
  nearbyUrgentAlerts?: number;
  now?: number;
}

export function levelOf(score: number): RiskLevel {
  return score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';
}

/** Who must approve a voyage of this risk level before it can sail. Low risk is auto-approved. */
export function approvalsRequired(level: RiskLevel): ApprovalRole[] {
  if (level === 'low') return [];
  if (level === 'critical') return ['risk_officer', 'org_admin'];
  return ['risk_officer'];
}

export function scoreVoyage(input: ScoreInput): RiskAssessment {
  const exp = routeExposure(input.waypoints);
  const factors: RiskFactor[] = [];
  const add = (code: string, label: string, points: number, detail: string): void => {
    if (points !== 0) factors.push({ code, label, points: Math.round(points), detail });
  };

  add('hra', 'High-risk area exposure', Math.min(45, exp.highRiskNm * 0.15), `${exp.highRiskNm} nm of the route inside high-risk areas`);
  add('elevated', 'Elevated-risk area exposure', Math.min(20, exp.elevatedRiskNm * 0.05), `${exp.elevatedRiskNm} nm inside elevated-risk areas`);

  const exposed = exp.highRiskNm + exp.elevatedRiskNm > 0;
  if (HAZARDOUS.includes(input.cargo)) add('cargo', 'Hazardous / high-value cargo', exposed ? 10 : 3, `${input.cargo.replace(/_/g, ' ')} cargo${exposed ? ' through a risk area' : ''}`);
  else if (input.cargo === 'passengers') add('cargo', 'Passengers on board', exposed ? 10 : 2, 'passenger voyage');

  const hours = Math.max(1, (input.eta - input.etd) / 3_600_000);
  const planned = exp.totalNm / hours;
  if (exposed && planned < 12) add('speed', 'Slow transit through a risk area', 10, `planned average ${planned.toFixed(1)} kn is below the 12 kn that is generally recommended through risk areas`);
  if (planned > 20) add('schedule', 'Schedule pressure', 5, `planned average ${planned.toFixed(1)} kn is unusually high`);

  const urgent = Math.min(3, input.nearbyUrgentAlerts ?? 0);
  add('live', 'Recent incidents near the route', urgent * 5, `${input.nearbyUrgentAlerts ?? 0} open high-priority alert(s) within 150 nm of the route`);

  if (exp.foreignWatersNm > 0) factors.push({ code: 'foreign', label: 'Passes through neighbouring waters', points: 0, detail: `${exp.foreignWatersNm} nm in a neighbouring state's modelled waters (information only)` });

  const score = Math.min(100, factors.reduce((n, f) => n + f.points, 0));
  const level = levelOf(score);
  const controls: string[] = [];
  if (exp.highRiskNm > 0) {
    controls.push('Register the transit with the regional reporting centres (e.g. MSCHOA / UKMTO) and follow current BMP guidance for the area.');
    controls.push('Review the ship security plan; brief the crew and confirm lookout and watch arrangements.');
    controls.push('Notify the charterer and insurer of the transit (war-risk cover and premium).');
  }
  if (exp.elevatedRiskNm > 0) controls.push('Maintain a heightened watch and report anything suspicious to the nearest maritime authority.');
  if (HAZARDOUS.includes(input.cargo) && exposed) controls.push('Confirm emergency response arrangements for hazardous cargo before entering the risk area.');
  if (level === 'low') controls.push('No special controls required; monitor as normal.');
  return {
    score,
    level,
    factors,
    controls,
    exposure: exp,
    assessedAt: input.now ?? Date.now(),
  };
}

// ── state machine ────────────────────────────────────────────────────────────
export type VoyageAction = 'submit' | 'approve' | 'reject' | 'request_changes' | 'start' | 'complete' | 'cancel';

export interface Actor {
  userId: string;
  role: Role;
}

export interface TransitionResult {
  ok: boolean;
  error?: string;
  voyage: Voyage;
}

const COMPANY_ROLES: readonly Role[] = ['operator', 'risk_officer', 'org_admin'];
const APPROVER_ROLES: readonly Role[] = ['risk_officer', 'org_admin'];

function fail(v: Voyage, error: string): TransitionResult {
  return { ok: false, error, voyage: v };
}

/**
 * Apply an action to a voyage. Enforces who may do what (including the four-eyes rule: the person who prepared a
 * voyage cannot approve it), records history, and tracks approvals. Pure: returns a new voyage object.
 */
export function applyAction(
  voyage: Voyage,
  action: VoyageAction,
  actor: Actor,
  note: string,
  now: number,
  assessment?: RiskAssessment,
): TransitionResult {
  const v: Voyage = { ...voyage, history: [...voyage.history], approvals: [...voyage.approvals] };
  const log = (act: string, n?: string): void => {
    v.history.push({ ts: now, actor: actor.userId, action: act, note: n || undefined });
    v.updatedAt = now;
  };
  if (!COMPANY_ROLES.includes(actor.role)) return fail(voyage, 'Only company users can act on voyages');
  const status: VoyageStatus = v.status;

  switch (action) {
    case 'submit': {
      if (status !== 'draft' && status !== 'changes_requested') return fail(voyage, `Cannot submit a voyage that is ${status}`);
      if (!assessment) return fail(voyage, 'A risk assessment is required to submit');
      v.assessment = assessment;
      v.approvalsRequired = approvalsRequired(assessment.level);
      v.approvals = [];
      log('submitted', `risk ${assessment.level} (${assessment.score})`);
      if (v.approvalsRequired.length === 0) {
        v.status = 'approved';
        log('auto_approved', 'low risk: no approval required');
      } else {
        v.status = 'submitted';
      }
      return { ok: true, voyage: v };
    }
    case 'approve':
    case 'reject':
    case 'request_changes': {
      if (status !== 'submitted') return fail(voyage, `Voyage is ${status}, not awaiting approval`);
      if (!APPROVER_ROLES.includes(actor.role)) return fail(voyage, 'Only a risk officer or organisation admin can decide on a voyage');
      if (actor.userId === v.createdBy) return fail(voyage, 'Four-eyes rule: you cannot decide on a voyage you prepared');
      const role = actor.role as ApprovalRole;
      if (action !== 'approve' && !note.trim()) return fail(voyage, 'A note is required when rejecting or requesting changes');
      if (action === 'approve' && v.assessment && (v.assessment.level === 'high' || v.assessment.level === 'critical') && !note.trim()) {
        return fail(voyage, 'Approving a high-risk voyage requires conditions / justification in the note');
      }
      if (action === 'approve' && !v.approvalsRequired.includes(role) && !(role === 'org_admin' && v.approvalsRequired.includes('risk_officer'))) {
        return fail(voyage, 'Your role is not required to approve this voyage');
      }
      const decision: Approval['decision'] = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'changes_requested';
      if (v.approvals.some((a) => a.userId === actor.userId && a.decision === 'approved')) return fail(voyage, 'You have already approved this voyage');
      v.approvals.push({ role, userId: actor.userId, decision, note, ts: now });
      log(decision, note);
      if (action === 'reject') v.status = 'rejected';
      else if (action === 'request_changes') v.status = 'changes_requested';
      else {
        const done = v.approvalsRequired.every((r) => v.approvals.some((a) => a.decision === 'approved' && (a.role === r || (a.role === 'org_admin' && r === 'risk_officer'))));
        // an org_admin approval covers the risk_officer step, but a critical voyage still needs two distinct people
        const people = new Set(v.approvals.filter((a) => a.decision === 'approved').map((a) => a.userId));
        if (done && people.size >= v.approvalsRequired.length) {
          v.status = 'approved';
          if (note.trim()) v.conditions = note.trim();
          log('approved_final', 'all required approvals received');
        }
      }
      return { ok: true, voyage: v };
    }
    case 'start': {
      if (status !== 'approved') return fail(voyage, 'Only an approved voyage can start');
      v.status = 'active';
      log('started', note);
      return { ok: true, voyage: v };
    }
    case 'complete': {
      if (status !== 'active') return fail(voyage, 'Only an active voyage can be completed');
      v.status = 'completed';
      log('completed', note);
      return { ok: true, voyage: v };
    }
    case 'cancel': {
      if (status === 'active' || status === 'completed' || status === 'cancelled' || status === 'rejected') return fail(voyage, `A ${status} voyage cannot be cancelled`);
      if (actor.userId !== v.createdBy && actor.role !== 'org_admin') return fail(voyage, 'Only the creator or an organisation admin can cancel');
      v.status = 'cancelled';
      log('cancelled', note);
      return { ok: true, voyage: v };
    }
  }
}

// ── live monitoring ──────────────────────────────────────────────────────────
export const DEVIATION_NM = 30;

export interface MonitorFinding {
  type: 'deviation' | 'unplanned_exposure';
  message: string;
  deviationNm?: number;
}

/** Compare an active voyage with the vessel's live position. */
export function monitorVoyage(voyage: Voyage, live: { lat: number; lon: number } | undefined): MonitorFinding[] {
  if (voyage.status !== 'active' || !live) return [];
  const out: MonitorFinding[] = [];
  const off = distanceToLineNm(live.lat, live.lon, voyage.waypoints);
  if (off > DEVIATION_NM) {
    out.push({ type: 'deviation', deviationNm: Math.round(off), message: `${voyage.vesselName} (${voyage.reference}) is ${Math.round(off)} nm off its approved route` });
  }
  const zone = HIGH_RISK_ZONES.find((r) => pointInPolygon(live.lat, live.lon, r.polygon));
  const planned = voyage.assessment?.exposure.zones ?? [];
  if (zone && !planned.includes(zone.name)) {
    out.push({ type: 'unplanned_exposure', message: `${voyage.vesselName} (${voyage.reference}) is inside ${zone.name}, which was not part of the approved voyage risk assessment` });
  }
  return out;
}
