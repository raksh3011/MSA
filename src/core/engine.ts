/**
 * Risk engine. Rules are pure functions of (vessel, previous state, context) so
 * they can be unit-tested and reused unchanged in the Worker and the browser.
 *
 * Perspective: Indian maritime security.
 *  - Indian vessels      → alerts when they enter critical (high-risk) areas, stray into neighbouring waters,
 *                          go dark or show impossible movement;
 *  - foreign / unknown   → graded alerts as they APPROACH the EEZ, ENTER the EEZ, the contiguous zone and the
 *                          territorial sea, and while they are PRESENT (loitering) inside Indian waters.
 */
import { distanceNm, pointInPolygon } from './geo';
import type { Alert, Geofence, Policy, RuleId, Severity, Vessel, VesselClass } from './types';
import { CONTIGUOUS_ZONE, FOREIGN_WATERS, HIGH_RISK_ZONES, INDIA_EEZ, TERRITORIAL_SEA, distanceToEezNm, type RiskLevel } from './zones';

export const DEFAULT_POLICY: Policy = {
  flagsOfInterest: [],
  highSpeedKn: 25,
  aisGapMinutes: 30,
  loiterSogKn: 2,
  approachNm: 60,
};

export interface RuleContext {
  policy: Policy;
  geofences: readonly Geofence[];
  now: number;
}

export type Finding = Pick<Alert, 'ruleId' | 'severity' | 'message'>;

export const inEez = (v: Pick<Vessel, 'lat' | 'lon'>): boolean => INDIA_EEZ.contains(v.lat, v.lon);
export const inContiguous = (v: Pick<Vessel, 'lat' | 'lon'>): boolean => CONTIGUOUS_ZONE.contains(v.lat, v.lon);
export const inTerritorialSea = (v: Pick<Vessel, 'lat' | 'lon'>): boolean => TERRITORIAL_SEA.contains(v.lat, v.lon);

export const highRiskZoneOf = (v: Pick<Vessel, 'lat' | 'lon'>): { name: string; level: RiskLevel } | null => {
  const z = HIGH_RISK_ZONES.find((r) => pointInPolygon(v.lat, v.lon, r.polygon));
  return z ? { name: z.name, level: z.level } : null;
};

/** Who is this vessel from India's point of view? "unknown" = no valid flag state (invalid MID) or a reported contact. */
export function classOf(v: Pick<Vessel, 'flag' | 'origin'>): VesselClass {
  if (v.flag === 'India') return 'indian';
  if (v.flag === 'Unknown' || v.origin === 'reported') return 'unknown';
  return 'foreign';
}

const isMilitary = (v: Vessel): boolean => v.category === 'naval' || v.category === 'coast_guard';
const isMerchant = (v: Vessel): boolean => v.category === 'cargo' || v.category === 'tanker' || v.category === 'passenger';
const label = (v: Vessel): string => `${v.name} (${v.flag})`;
const klass = (v: Vessel): string => (classOf(v) === 'unknown' ? 'Unidentified vessel' : isMilitary(v) ? 'Foreign warship' : 'Foreign vessel');

const LEVELS: readonly Severity[] = ['low', 'medium', 'high', 'critical'];
const severityOf = (level: number): Severity => LEVELS[Math.max(0, Math.min(3, level))] as Severity;

type Stage = 'approach' | 'enter_eez' | 'enter_contiguous' | 'enter_territorial' | 'present_eez' | 'present_inner';

/**
 * Graded severity for a non-Indian vessel at a stage of approach. Routine merchant traffic is low priority until it
 * reaches the territorial sea; warships and unidentified vessels are escalated; flags of interest and fast movers add a level.
 * Returns null when the stage is not worth an alert (e.g. a merchant ship merely approaching).
 */
function gradeNonIndian(v: Vessel, stage: Stage, ctx: RuleContext): Severity | null {
  const cls = classOf(v);
  const merchant = isMerchant(v) && cls === 'foreign';
  const sensitive = isMilitary(v) || cls === 'unknown';
  let level: number;
  switch (stage) {
    case 'approach':
      if (merchant) return null;
      level = sensitive ? 1 : 0;
      break;
    case 'enter_eez':
    case 'enter_contiguous':
      level = sensitive ? 2 : merchant ? 0 : 1;
      break;
    case 'enter_territorial':
      level = sensitive ? 3 : merchant ? 1 : 2;
      break;
    case 'present_eez':
      level = sensitive ? 2 : 1;
      break;
    default:
      level = sensitive ? 3 : 2;
  }
  if (ctx.policy.flagsOfInterest.includes(v.flag)) level += 1;
  if (v.sog >= ctx.policy.highSpeedKn) level += 1;
  return severityOf(level);
}

/** A foreign/unknown vessel closing on the EEZ limit (alert once, when it crosses into the approach window). */
function eezApproach(v: Vessel, prev: Vessel | undefined, ctx: RuleContext): Finding | null {
  if (!prev || classOf(v) === 'indian' || v.sog < 2) return null;
  if (inEez(v) || inEez(prev)) return null;
  const d = distanceToEezNm(v.lat, v.lon);
  if (d > ctx.policy.approachNm || d <= 0) return null;
  const before = distanceToEezNm(prev.lat, prev.lon);
  if (before <= ctx.policy.approachNm || d >= before - 0.3) return null; // not newly inside the window, or not closing
  const severity = gradeNonIndian(v, 'approach', ctx);
  if (!severity) return null;
  return {
    ruleId: 'eez_approach',
    severity,
    message: `${klass(v)} ${label(v)} approaching the Indian EEZ: ${d.toFixed(0)} nm from the limit, closing at ${v.sog.toFixed(1)} kn`,
  };
}

function eezEntry(v: Vessel, prev: Vessel | undefined, ctx: RuleContext): Finding | null {
  if (!inEez(v) || (prev && inEez(prev)) || classOf(v) === 'indian') return null;
  const severity = gradeNonIndian(v, 'enter_eez', ctx);
  if (!severity) return null;
  // First sighting of an ordinary merchant already inside the EEZ is not an "entry" (e.g. after a restart).
  if (!prev && isMerchant(v) && classOf(v) === 'foreign' && severity === 'low') return null;
  return { ruleId: 'eez_entry', severity, message: `${klass(v)} ${label(v)} entered the Indian EEZ at ${v.sog.toFixed(1)} kn` };
}

function contiguousEntry(v: Vessel, prev: Vessel | undefined, ctx: RuleContext): Finding | null {
  if (!inContiguous(v) || (prev && (inContiguous(prev) || inTerritorialSea(prev))) || classOf(v) === 'indian') return null;
  const severity = gradeNonIndian(v, 'enter_contiguous', ctx);
  if (!severity) return null;
  if (!prev && isMerchant(v) && classOf(v) === 'foreign' && severity === 'low') return null;
  return { ruleId: 'contiguous_entry', severity, message: `${klass(v)} ${label(v)} entered the Indian contiguous zone (12-24 nm) at ${v.sog.toFixed(1)} kn` };
}

function territorialSea(v: Vessel, prev: Vessel | undefined, ctx: RuleContext): Finding | null {
  if (!inTerritorialSea(v) || (prev && inTerritorialSea(prev)) || classOf(v) === 'indian') return null;
  const severity = gradeNonIndian(v, 'enter_territorial', ctx);
  if (!severity) return null;
  return {
    ruleId: 'territorial_sea',
    severity,
    message: `${klass(v)} ${label(v)} entered Indian territorial waters (12 nm) at ${v.sog.toFixed(1)} kn${v.category === 'fishing' ? ' - foreign fishing vessel' : ''}`,
  };
}

function highSpeed(v: Vessel, prev: Vessel | undefined, ctx: RuleContext): Finding | null {
  if (!inEez(v) || isMilitary(v) || v.category === 'highspeed' || classOf(v) === 'indian') return null;
  if (v.sog < ctx.policy.highSpeedKn) return null;
  if (prev && prev.sog >= ctx.policy.highSpeedKn && inEez(prev)) return null; // already reported
  return { ruleId: 'high_speed_in_eez', severity: 'medium', message: `${klass(v)} ${label(v)} at ${v.sog.toFixed(1)} kn inside the EEZ` };
}

/** Foreign/unknown vessel staying put inside Indian waters (stricter closer to the coast). */
function presence(v: Vessel, _prev: Vessel | undefined, ctx: RuleContext): Finding | null {
  if (classOf(v) === 'indian' || !inEez(v)) return null;
  const inner = inTerritorialSea(v) || inContiguous(v);
  const need = inner ? 4 : 8;
  if (v.sog > ctx.policy.loiterSogKn || v.trail.length < need) return null;
  const recent = v.trail.slice(-need);
  const centre = recent[0] as [number, number];
  if (Math.max(...recent.map((p) => distanceNm(centre, p))) > 1) return null;
  const severity = gradeNonIndian(v, inner ? 'present_inner' : 'present_eez', ctx);
  if (!severity) return null;
  const where = inTerritorialSea(v) ? 'territorial sea' : inContiguous(v) ? 'contiguous zone' : 'EEZ';
  return { ruleId: 'loitering', severity, message: `${klass(v)} ${label(v)} present in the Indian ${where}, stationary (drift < 1 nm over ${recent.length} reports)` };
}

/** Indian vessel entering a critical (high-risk) area: advisory to the operator / MRCC. Others: low-priority traffic note. */
function highRiskZone(v: Vessel, prev: Vessel | undefined): Finding | null {
  const zone = highRiskZoneOf(v);
  if (!zone || (prev && highRiskZoneOf(prev)?.name === zone.name) || isMilitary(v)) return null;
  const risky = zone.level === 'high' ? 'high-risk' : 'elevated-risk';
  if (classOf(v) === 'indian') {
    return {
      ruleId: 'indian_critical_zone',
      severity: zone.level === 'high' ? 'high' : 'medium',
      message: `Indian vessel ${v.name} entered ${zone.name} (${risky} area) - advise the operator and monitor`,
    };
  }
  return { ruleId: 'high_risk_zone', severity: 'low', message: `${label(v)} entered ${zone.name} (${risky} area)` };
}

/**
 * Indian vessel crossing into a neighbouring state's (modelled) waters. Merchant ships trading with a neighbour are routine
 * (low); small / non-merchant Indian craft straying across the line risk detention (high).
 */
function indianInForeignWaters(v: Vessel, prev: Vessel | undefined): Finding | null {
  if (classOf(v) !== 'indian' || isMilitary(v)) return null;
  const now = FOREIGN_WATERS.find((f) => f.area.contains(v.lat, v.lon));
  if (!now) return null;
  const before = prev ? FOREIGN_WATERS.find((f) => f.area.contains(prev.lat, prev.lon)) : undefined;
  if (before?.code === now.code) return null;
  const merchant = isMerchant(v);
  if (!prev && merchant) return null;
  return {
    ruleId: 'indian_foreign_waters',
    severity: merchant ? 'low' : 'high',
    message: `Indian vessel ${v.name} crossed into ${now.name} waters (modelled boundary) - risk of detention, contact the operator`,
  };
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
export const RULES: readonly Rule[] = [
  eezApproach, eezEntry, contiguousEntry, territorialSea, highSpeed, presence,
  highRiskZone, indianInForeignWaters, positionJump, geofence,
];

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
    if (v.sog < 3 || isMilitary(v)) continue; // moored / drifting vessels going quiet is normal, not "dark"
    const indian = classOf(v) === 'indian';
    const dark = inEez(v);
    out.push({
      vessel: v,
      finding: {
        ruleId: 'ais_gap',
        severity: indian || dark ? 'high' : 'low',
        message: `${indian ? 'Indian vessel' : 'Vessel'} ${label(v)} silent for ${Math.round(silent / 60_000)} min${dark ? ' inside the EEZ (possible dark vessel)' : ''}`,
      },
    });
  }
  return out;
}

/** Per-rule cooldowns: persistent conditions re-alert rarely, events more often. */
const COOLDOWN_MIN: Record<RuleId, number> = {
  eez_approach: 240,
  eez_entry: 360,
  contiguous_entry: 240,
  territorial_sea: 180,
  high_speed_in_eez: 120,
  ais_gap: 90,
  high_risk_zone: 360,
  indian_critical_zone: 360,
  indian_foreign_waters: 120,
  loitering: 120,
  position_jump: 60,
  geofence: 60,
  user_report: 0,
  voyage_deviation: 360,
  voyage_exposure: 360,
  case_sla: 0,
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
