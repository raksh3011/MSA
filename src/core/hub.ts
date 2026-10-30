/**
 * Hub — the platform-independent heart of NavSight: vessel state, risk engine,
 * alert lifecycle, watchlists, geofences, audit trail. The Worker's Durable Object
 * and the in-browser demo both wrap exactly this class.
 */
import { hashPassword } from './auth';
import { DEFAULT_POLICY, Deduper, evaluateGaps, evaluateVessel, type Finding, type RuleContext } from './engine';
import type {
  Alert,
  AlertStatus,
  AuditEntry,
  Geofence,
  Policy,
  PositionReport,
  PublicUser,
  Role,
  Snapshot,
  User,
  Vessel,
} from './types';
import { categoryFromShipType, normalizeReport, TRAIL_LENGTH } from './vessel';

export const MAX_VESSELS = 6000;
export const MAX_ALERTS = 500;
const MAX_AUDIT = 500;

export interface HubState {
  alerts: Alert[];
  users: User[];
  watchlists: Record<string, string[]>;
  geofences: Geofence[];
  audit: AuditEntry[];
  policy: Policy;
}

export class Hub {
  readonly vessels = new Map<string, Vessel>();
  alerts: Alert[] = [];
  readonly users = new Map<string, User>();
  readonly watchlists = new Map<string, Set<string>>();
  geofences: Geofence[] = [];
  audit: AuditEntry[] = [];
  policy: Policy = { ...DEFAULT_POLICY };
  source: 'live' | 'demo' = 'demo';
  /** Called after any change to persistent state (alerts, users, watchlists, ...). */
  onPersist: (() => void) | undefined;

  private readonly dedupe = new Deduper();

  constructor(private readonly maxVessels = MAX_VESSELS) {}

  private ctx(now: number): RuleContext {
    return { policy: this.policy, geofences: this.geofences, now };
  }

  /** Ingest one raw position report. Returns the stored vessel, or null if rejected. */
  ingest(report: PositionReport, now: number = Date.now()): Vessel | null {
    const v = normalizeReport(report, now);
    if (!v) return null;
    const prev = this.vessels.get(v.mmsi);
    if (prev) {
      if (v.lastSeen <= prev.lastSeen) return null; // duplicate / out-of-order
      v.trail = [...prev.trail, [prev.lat, prev.lon] as [number, number]].slice(-TRAIL_LENGTH);
      if (/^MMSI \d{9}$/.test(v.name) && !/^MMSI \d{9}$/.test(prev.name)) v.name = prev.name;
      if (v.category === 'other' && prev.category !== 'other') v.category = prev.category;
    } else if (this.vessels.size >= this.maxVessels) {
      this.evictStalest();
    }
    this.vessels.set(v.mmsi, v);
    for (const f of evaluateVessel(v, prev, this.ctx(now))) this.raise(v, f, now);
    return v;
  }

  /** Periodic AIS-gap sweep. */
  sweepGaps(now: number = Date.now()): number {
    let n = 0;
    for (const { vessel, finding } of evaluateGaps(this.vessels.values(), this.ctx(now))) {
      if (this.raise(vessel, finding, now)) n++;
    }
    return n;
  }

  private evictStalest(): void {
    let oldest: string | undefined;
    let t = Infinity;
    for (const [mmsi, v] of this.vessels) {
      if (v.lastSeen < t) {
        t = v.lastSeen;
        oldest = mmsi;
      }
    }
    if (oldest) this.vessels.delete(oldest);
  }

  private raise(v: Vessel, f: Finding, now: number): Alert | null {
    if (!this.dedupe.allow(v.mmsi, f.ruleId, now)) return null;
    const alert: Alert = {
      id: crypto.randomUUID(),
      ruleId: f.ruleId,
      severity: f.severity,
      mmsi: v.mmsi,
      vesselName: v.name,
      message: f.message,
      lat: v.lat,
      lon: v.lon,
      ts: now,
      status: 'open',
    };
    this.alerts.unshift(alert);
    if (this.alerts.length > MAX_ALERTS) this.alerts.length = MAX_ALERTS;
    this.persist();
    return alert;
  }

  /** Alerts visible to a user: operators only see alerts for vessels on their own watchlist. */
  alertsFor(role: Role, username: string): Alert[] {
    if (role !== 'operator') return this.alerts;
    const fleet = this.watchlists.get(username);
    return fleet ? this.alerts.filter((a) => fleet.has(a.mmsi)) : [];
  }

  // ── alert lifecycle ────────────────────────────────────────────────────────
  updateAlert(id: string, status: Exclude<AlertStatus, 'open'>, actor: string, note?: string): Alert | null {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return null;
    a.status = status;
    a.handledBy = actor;
    a.handledAt = Date.now();
    if (note) a.note = note.slice(0, 500);
    this.log(actor, `alert.${status}`, `${a.ruleId} ${a.mmsi}`);
    return a;
  }

  // ── watchlist (per user) ───────────────────────────────────────────────────
  watchlistOf(username: string): string[] {
    return [...(this.watchlists.get(username) ?? [])];
  }
  watch(username: string, mmsi: string): void {
    const set = this.watchlists.get(username) ?? new Set<string>();
    set.add(mmsi);
    this.watchlists.set(username, set);
    this.log(username, 'watchlist.add', mmsi);
  }
  unwatch(username: string, mmsi: string): boolean {
    const ok = this.watchlists.get(username)?.delete(mmsi) ?? false;
    if (ok) this.log(username, 'watchlist.remove', mmsi);
    return ok;
  }

  // ── geofences ──────────────────────────────────────────────────────────────
  addGeofence(g: Omit<Geofence, 'id'>): Geofence {
    const geofence = { ...g, id: crypto.randomUUID() };
    this.geofences.push(geofence);
    this.log(g.createdBy, 'geofence.add', g.name);
    return geofence;
  }
  removeGeofence(id: string, actor: string): boolean {
    const before = this.geofences.length;
    this.geofences = this.geofences.filter((g) => g.id !== id);
    const ok = this.geofences.length < before;
    if (ok) this.log(actor, 'geofence.remove', id);
    return ok;
  }

  setPolicy(p: Partial<Policy>, actor: string): Policy {
    this.policy = { ...this.policy, ...p };
    this.log(actor, 'policy.update', JSON.stringify(p));
    return this.policy;
  }

  // ── users ──────────────────────────────────────────────────────────────────
  async addUser(username: string, password: string, role: Role, displayName: string): Promise<void> {
    this.users.set(username, { username, role, displayName, passwordHash: await hashPassword(password) });
    this.persist();
  }
  publicUser(u: User): PublicUser {
    return { username: u.username, role: u.role, displayName: u.displayName };
  }

  // ── audit ──────────────────────────────────────────────────────────────────
  log(actor: string, action: string, detail: string): void {
    this.audit.unshift({ ts: Date.now(), actor, action, detail: detail.slice(0, 300) });
    if (this.audit.length > MAX_AUDIT) this.audit.length = MAX_AUDIT;
    this.persist();
  }

  snapshot(now: number = Date.now()): Snapshot {
    // Trails are omitted from bulk snapshots (bandwidth); clients build their own or fetch /api/vessels/:mmsi.
    const vessels = [...this.vessels.values()].map((v) => ({ ...v, trail: [] }));
    return { vessels, alerts: this.alerts.slice(0, 100), ts: now, source: this.source };
  }

  /** Apply AIS static data (name / ship type) to an already-tracked vessel. */
  updateStatic(mmsi: string, name: string | undefined, shipType: number | undefined): void {
    const v = this.vessels.get(mmsi);
    if (!v) return;
    if (shipType !== undefined) v.category = categoryFromShipType(shipType);
    const clean = (name ?? '').replace(/[^ -~]/g, '').trim();
    if (clean) v.name = clean;
  }

  // ── persistence ────────────────────────────────────────────────────────────
  private persist(): void {
    this.onPersist?.();
  }
  exportState(): HubState {
    return {
      alerts: this.alerts,
      users: [...this.users.values()],
      watchlists: Object.fromEntries([...this.watchlists].map(([k, v]) => [k, [...v]])),
      geofences: this.geofences,
      audit: this.audit,
      policy: this.policy,
    };
  }
  importState(s: Partial<HubState>): void {
    if (s.alerts) this.alerts = s.alerts;
    if (s.users) for (const u of s.users) this.users.set(u.username, u);
    if (s.watchlists) for (const [k, v] of Object.entries(s.watchlists)) this.watchlists.set(k, new Set(v));
    if (s.geofences) this.geofences = s.geofences;
    if (s.audit) this.audit = s.audit;
    if (s.policy) this.policy = { ...DEFAULT_POLICY, ...s.policy };
  }
}
