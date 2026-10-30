/**
 * Risk engine. Rules are pure functions of (vessel, previous state, context) so
 * they can be unit-tested and reused unchanged in the Worker and the browser.
 */
import { checkBoundary } from './boundary';
import { distanceNm, pointInPolygon } from './geo';
import type { Alert, Geofence, Policy, RuleId, Severity, Vessel } from './types';
import { EEZ_ZONES, HIGH_RISK_ZONES } from './zones';

export const DEFAULT_POLICY: Policy = {
  flagsOfInterest: [],
  highSpeedKn: 25,
  aisGapMinutes: 30,
  loiterSogKn: 2,
  boundaryWarnNm: 10,
};

export interface RuleContext {
  policy: Policy;
  geofences: readonly Geofence[];
  now: number;
}

export type Finding = Pick<Alert, 'ruleId' | 'severity' | 'message'>;

export const inEez = (v: Pick<Vessel, 'lat' | 'lon'>): boolean =>
  EEZ_ZONES.some((z) => pointInPolygon(v.lat, v.lon, z.polygon));

export const highRiskZoneOf = (v: Pick<Vessel, 'lat' | 'lon'>): string | null =>
  HIGH_RISK_ZONES.find((z) => pointInPolygon(v.lat, v.lon, z.polygon))?.name ?? null;

const isMilitary = (v: Vessel): boolean => v.category === 'naval' || v.category === 'coast_guard';
const label = (v: Vessel): string => `${v.name} (${v.flag})`;

function eezEntry(v: Vessel, prev: Vessel | undefined, ctx: RuleContext): Finding | null {
  if (!inEez(v) || (prev && inEez(prev))) return null;
  if (v.flag === 'India' || isMilitary(v)) return null;
  const ofInterest = ctx.policy.flagsOfInterest.includes(v.flag);
  const fast = v.sog >= ctx.policy.highSpeedKn;
  let severity: Severity = 'medium';
  if (ofInterest) severity = fast ? 'critical' : 'high';
  else if (fast) severity = 'high';
  return {
    ruleId: 'eez_entry',
    severity,
    message: `${label(v)} entered the Indian EEZ at ${v.sog.toFixed(1)} kn${ofInterest ? ' (flag of interest)' : ''}`,
  };
}

function highSpeed(v: Vessel, prev: Vessel | undefined, ctx: RuleContext): Finding | null {
  if (!inEez(v) || isMilitary(v) || v.category === 'highspeed') return null;
  if (v.sog < ctx.policy.highSpeedKn) return null;
  if (prev && prev.sog >= ctx.policy.highSpeedKn && inEez(prev)) return null; // already reported
  return { ruleId: 'high_speed_in_eez', severity: 'medium', message: `${label(v)} at ${v.sog.toFixed(1)} kn inside the EEZ` };
}

function highRiskZone(v: Vessel, prev: Vessel | undefined): Finding | null {
  const zone = highRiskZoneOf(v);
  if (!zone || (prev && highRiskZoneOf(prev))) return null;
  if (isMilitary(v)) return null;
  return { ruleId: 'high_risk_zone', severity: 'high', message: `${label(v)} entered ${zone}` };
}

function loitering(v: Vessel, _prev: Vessel | undefined, ctx: RuleContext): Finding | null {
  if (!inEez(v) || isMilitary(v) || v.category === 'fishing') return null;
  if (v.sog > ctx.policy.loiterSogKn || v.trail.length < 8) return null;
  const recent = v.trail.slice(-8);
  const centre = recent[0] as [number, number];
  const drift = Math.max(...recent.map((p) => distanceNm(centre, p)));
  if (drift > 1) return null;
  return { ruleId: 'loitering', severity: 'medium', message: `${label(v)} loitering in the EEZ (drift < 1 nm over ${recent.length} reports)` };
}

/** Implausible jump between consecutive reports — possible AIS spoofing or bad data. */
function positionJump(v: Vessel, prev: Vessel | undefined): Finding | null {
  if (!prev) return null;
  const hours = (v.lastSeen - prev.lastSeen) / 3_600_000;
  if (hours <= 0) return null;
  const dist = distanceNm([prev.lat, prev.lon], [v.lat, v.lon]);
  if (dist < 5) return null;
  const impliedKn = dist / hours;
  if (impliedKn < 60) return null;
  return {
    ruleId: 'position_jump',
    severity: 'high',
    message: `${label(v)} jumped ${dist.toFixed(0)} nm in ${(hours * 60).toFixed(0)} min (implied ${impliedKn.toFixed(0)} kn) - possible spoofing`,
  };
}

function fishingBoundary(v: Vessel, prev: Vessel | undefined, ctx: RuleContext): Finding | null {
  if (v.category !== 'fishing') return null;
  const now = checkBoundary(v.lat, v.lon, ctx.policy.boundaryWarnNm);
  if (!now || now.level === 'safe') return null;
  const before = prev ? checkBoundary(prev.lat, prev.lon, ctx.policy.boundaryWarnNm) : null;
  if (before && before.level === now.level) return null;
  if (now.level === 'crossed') {
    return { ruleId: 'fishing_boundary', severity: 'high', message: `${label(v)} crossed the maritime boundary` };
  }
  return {
    ruleId: 'fishing_boundary',
    severity: now.level === 'danger' ? 'high' : 'medium',
    message: `${label(v)} is ${now.distanceNm} nm from the maritime boundary`,
  };
}

function geofence(v: Vessel, prev: Vessel | undefined, ctx: RuleContext): Finding | null {
  for (const g of ctx.geofences) {
    const inside = distanceNm([g.lat, g.lon], [v.lat, v.lon]) <= g.radiusNm;
    const wasInside = prev ? distanceNm([g.lat, g.lon], [prev.lat, prev.lon]) <= g.radiusNm : false;
    if (inside && !wasInside) {
      return { ruleId: 'geofence', severity: 'medium', message: `${label(v)} entered geofence "${g.name}"` };
    }
  }
  return null;
}

type Rule = (v: Vessel, prev: Vessel | undefined, ctx: RuleContext) => Finding | null;
export const RULES: readonly Rule[] = [eezEntry, highSpeed, highRiskZone, loitering, positionJump, fishingBoundary, geofence];

export function evaluateVessel(v: Vessel, prev: Vessel | undefined, ctx: RuleContext): Finding[] {
  const out: Finding[] = [];
  for (const rule of RULES) {
    const f = rule(v, prev, ctx);
    if (f) out.push(f);
  }
  return out;
}

/** AIS-gap rule: evaluated on a timer, not per report (silence produces no reports). */
export function evaluateGaps(vessels: Iterable<Vessel>, ctx: RuleContext): Array<{ vessel: Vessel; finding: Finding }> {
  const out: Array<{ vessel: Vessel; finding: Finding }> = [];
  const limit = ctx.policy.aisGapMinutes * 60_000;
  for (const v of vessels) {
    const silent = ctx.now - v.lastSeen;
    if (silent < limit || silent > limit * 8) continue; // ignore very stale ghosts
    const dark = inEez(v);
    out.push({
      vessel: v,
      finding: {
        ruleId: 'ais_gap',
        severity: dark ? 'high' : 'low',
        message: `${label(v)} silent for ${Math.round(silent / 60_000)} min${dark ? ' inside the EEZ (possible dark vessel)' : ''}`,
      },
    });
  }
  return out;
}

/** Per-rule cooldowns: persistent conditions (loitering, AIS gap) re-alert rarely, events more often. */
const COOLDOWN_MIN: Record<RuleId, number> = {
  eez_entry: 30,
  high_speed_in_eez: 30,
  ais_gap: 90,
  high_risk_zone: 60,
  loitering: 120,
  position_jump: 30,
  fishing_boundary: 15,
  geofence: 30,
};

/** Suppresses repeat alerts for the same (vessel, rule) inside a cooldown window. */
export class Deduper {
  private last = new Map<string, number>();
  /** `defaultMs` overrides every rule's cooldown (used by tests). */
  constructor(private readonly defaultMs?: number) {}

  private cooldown(rule: RuleId): number {
    return this.defaultMs ?? COOLDOWN_MIN[rule] * 60_000;
  }

  allow(mmsi: string, rule: RuleId, now: number): boolean {
    const key = `${mmsi}:${rule}`;
    const t = this.last.get(key);
    if (t !== undefined && now - t < this.cooldown(rule)) return false;
    this.last.set(key, now);
    if (this.last.size > 20_000) this.prune(now);
    return true;
  }

  private prune(now: number): void {
    for (const [k, t] of this.last) {
      const rule = k.slice(k.indexOf(':') + 1) as RuleId;
      if (now - t >= this.cooldown(rule)) this.last.delete(k);
    }
  }
}
