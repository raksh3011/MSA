/** Voyage risk management service: create, assess, approve (four-eyes), monitor. */
import { distanceToLineNm, isValidCoord, type LatLon } from '../core/geo';
import type { Alert, Role } from '../core/types';
import { periodOf } from '../domain/plans';
import { portById, routeTemplateById } from '../domain/ports';
import type { CargoType, Organization, RiskAssessment, Voyage } from '../domain/types';
import { applyAction, monitorVoyage, scoreVoyage, type Actor, type VoyageAction } from '../domain/voyage';
import { emit, type Services } from './context';
import type { Result } from './org';

const bad = (error: string, status: 400 | 402 | 403 | 404 | 409 = 400): { ok: false; status: 400 | 402 | 403 | 404 | 409; error: string } => ({ ok: false, status, error });

export const CARGO_TYPES: CargoType[] = ['general', 'containers', 'bulk', 'crude_oil', 'refined_products', 'chemicals', 'lng_lpg', 'passengers'];

export interface VoyageInput {
  mmsi?: unknown;
  originPort?: unknown;
  destinationPort?: unknown;
  routeId?: unknown;
  waypoints?: unknown;
  etd?: unknown;
  eta?: unknown;
  cargo?: unknown;
}

interface Parsed {
  mmsi: string;
  originPort: string;
  destinationPort: string;
  routeId?: string;
  waypoints: LatLon[];
  etd: number;
  eta: number;
  cargo: CargoType;
}

function parseWaypoints(raw: unknown): LatLon[] | string {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 40) return 'waypoints must be 2-40 [lat, lon] pairs';
  const out: LatLon[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number' || !isValidCoord(p[0], p[1])) return 'every waypoint must be a valid [lat, lon]';
    out.push([p[0], p[1]]);
  }
  return out;
}

function parseInput(i: VoyageInput): Parsed | string {
  if (typeof i.mmsi !== 'string' || !/^\d{9}$/.test(i.mmsi)) return 'mmsi must be a 9-digit string';
  if (typeof i.originPort !== 'string' || !portById(i.originPort)) return 'originPort must be a known port id';
  if (typeof i.destinationPort !== 'string' || !portById(i.destinationPort)) return 'destinationPort must be a known port id';
  if (i.originPort === i.destinationPort) return 'origin and destination must differ';
  if (typeof i.cargo !== 'string' || !CARGO_TYPES.includes(i.cargo as CargoType)) return `cargo must be one of: ${CARGO_TYPES.join(', ')}`;
  if (typeof i.etd !== 'number' || typeof i.eta !== 'number' || !Number.isFinite(i.etd) || !Number.isFinite(i.eta)) return 'etd and eta (epoch ms) are required';
  if (i.eta <= i.etd) return 'eta must be after etd';
  if (i.eta - i.etd > 90 * 86_400_000) return 'a voyage cannot be longer than 90 days';
  let waypoints: LatLon[];
  let routeId: string | undefined;
  if (typeof i.routeId === 'string' && i.routeId) {
    const t = routeTemplateById(i.routeId);
    if (!t) return 'Unknown routeId';
    waypoints = t.waypoints;
    routeId = t.id;
  } else {
    const w = parseWaypoints(i.waypoints);
    if (typeof w === 'string') return w;
    waypoints = w;
  }
  return { mmsi: i.mmsi, originPort: i.originPort, destinationPort: i.destinationPort, routeId, waypoints, etd: i.etd, eta: i.eta, cargo: i.cargo as CargoType };
}

/** Count open high/critical alerts within 150 nm of the route: live context for the risk score. */
function nearbyUrgentAlerts(s: Services, waypoints: LatLon[]): number {
  return s.hub.alerts.filter((a) => a.status === 'open' && (a.severity === 'high' || a.severity === 'critical') && distanceToLineNm(a.lat, a.lon, waypoints) <= 150).length;
}

export function assess(s: Services, p: Pick<Parsed, 'waypoints' | 'cargo' | 'etd' | 'eta'>): RiskAssessment {
  return scoreVoyage({ ...p, nearbyUrgentAlerts: nearbyUrgentAlerts(s, p.waypoints), now: s.now() });
}

/** Preview a risk assessment without saving anything (used by the voyage wizard). */
export function previewAssessment(s: Services, input: VoyageInput): Result<RiskAssessment> {
  const p = parseInput({ originPort: 'INBOM', destinationPort: 'YEADE', mmsi: '000000000', ...input });
  if (typeof p === 'string') return bad(p);
  return { ok: true, value: assess(s, p) };
}

export async function createVoyage(s: Services, org: Organization, actor: { username: string; role: Role }, input: VoyageInput): Promise<Result<Voyage>> {
  const p = parseInput(input);
  if (typeof p === 'string') return bad(p);
  const vessel = await s.repo.registry.get(org.id, p.mmsi);
  if (!vessel || vessel.status !== 'active') return bad('Vessel is not in your active fleet registry', 404);
  const now = s.now();
  const period = periodOf(now);
  const start = Date.parse(`${period}-01T00:00:00Z`);
  const seq = (await s.repo.voyages.countCreatedBetween(org.id, start, start + 32 * 86_400_000)) + 1;
  const v: Voyage = {
    id: crypto.randomUUID(), orgId: org.id, reference: `VY-${period.replace('-', '')}-${String(seq).padStart(3, '0')}`, mmsi: p.mmsi, vesselName: vessel.name,
    originPort: p.originPort, destinationPort: p.destinationPort, routeId: p.routeId, waypoints: p.waypoints, etd: p.etd, eta: p.eta, cargo: p.cargo,
    status: 'draft', approvalsRequired: [], approvals: [], history: [{ ts: now, actor: actor.username, action: 'created' }], createdBy: actor.username, createdAt: now, updatedAt: now,
  };
  await s.repo.voyages.insert(v);
  return { ok: true, value: v };
}

export async function updateVoyage(s: Services, orgId: string, actor: string, id: string, input: VoyageInput): Promise<Result<Voyage>> {
  const v = await s.repo.voyages.get(orgId, id);
  if (!v) return bad('Voyage not found', 404);
  if (v.status !== 'draft' && v.status !== 'changes_requested') return bad(`A ${v.status} voyage cannot be edited`, 409);
  if (v.createdBy !== actor) return bad('Only the creator can edit this voyage', 403);
  const p = parseInput({ mmsi: v.mmsi, originPort: v.originPort, destinationPort: v.destinationPort, routeId: v.routeId, waypoints: v.waypoints, etd: v.etd, eta: v.eta, cargo: v.cargo, ...input });
  if (typeof p === 'string') return bad(p);
  const next: Voyage = { ...v, ...p, history: [...v.history, { ts: s.now(), actor, action: 'edited' }], updatedAt: s.now() };
  await s.repo.voyages.update(next);
  return { ok: true, value: next };
}

export async function actOnVoyage(s: Services, org: Organization, actor: { username: string; role: Role }, id: string, action: VoyageAction, note: string): Promise<Result<Voyage>> {
  const v = await s.repo.voyages.get(org.id, id);
  if (!v) return bad('Voyage not found', 404);
  const now = s.now();
  const a: Actor = { userId: actor.username, role: actor.role };
  const assessment = action === 'submit' ? assess(s, v) : undefined;
  const r = applyAction(v, action, a, note, now, assessment);
  if (!r.ok) return bad(r.error ?? 'Not allowed', 409);
  await s.repo.voyages.update(r.voyage);
  // billing: a voyage counts once, when it is first submitted
  if (action === 'submit' && !v.history.some((h) => h.action === 'submitted')) await s.repo.usage.increment(org.id, periodOf(now), 'voyages');
  s.hub.log(actor.username, `voyage.${action}`, `${org.id} ${v.reference} -> ${r.voyage.status}`);
  emit(s, org.id, 'voyage.status_changed', { voyageId: v.id, reference: v.reference, vessel: v.vesselName, mmsi: v.mmsi, from: v.status, to: r.voyage.status, riskLevel: r.voyage.assessment?.level, actor: actor.username });
  return { ok: true, value: r.voyage };
}

/** Monitor every active voyage against the live vessel position; raises alerts and webhook events. Returns findings raised. */
export async function monitorVoyages(s: Services): Promise<number> {
  let raised = 0;
  const now = s.now();
  for (const v of await s.repo.voyages.listActive()) {
    const live = s.hub.vessels.get(v.mmsi);
    for (const f of monitorVoyage(v, live)) {
      const rule = f.type === 'deviation' ? 'voyage_deviation' : 'voyage_exposure';
      if (!live || !s.hub.allowAlert(`${v.id}`, rule, now)) continue;
      const alert: Alert = {
        id: crypto.randomUUID(), ruleId: rule, severity: f.type === 'deviation' ? 'high' : 'medium', mmsi: v.mmsi, vesselName: v.vesselName, vesselClass: 'indian',
        message: f.message, lat: live.lat, lon: live.lon, ts: now, status: 'open',
      };
      s.hub.pushAlert(alert);
      emit(s, v.orgId, 'voyage.deviation', { voyageId: v.id, reference: v.reference, mmsi: v.mmsi, type: f.type, deviationNm: f.deviationNm, message: f.message });
      emit(s, v.orgId, 'alert.created', { alertId: alert.id, rule, severity: alert.severity, mmsi: alert.mmsi, message: alert.message });
      raised++;
    }
  }
  return raised;
}
