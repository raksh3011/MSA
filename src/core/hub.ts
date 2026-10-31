/**
 * Hub — the platform-independent heart of ORVMS: vessel state, risk engine,
 * alert lifecycle, watchlists, geofences, audit trail. The Worker's Durable Object
 * and the in-browser demo both wrap exactly this class.
 */
import { hashPassword } from './auth';
import { DEFAULT_POLICY, Deduper, classOf, evaluateGaps, evaluateVessel, type Finding, type RuleContext } from './engine';
import { isCompanyRole } from './types';
import type {
  Alert,
  AlertStatus,
  AuditEntry,
  DataSource,
  FeedInfo,
  Geofence,
  IncidentCategory,
  Policy,
  PositionReport,
  PublicUser,
  Role,
  Snapshot,
  User,
  Vessel,
} from './types';
import { nearestStation, type NearestStation } from './stations';
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
  source: DataSource = 'simulated';
  private feedInfo: FeedInfo = { connected: true };
  get feed(): FeedInfo {
    return this.feedInfo;
  }
  /** Replacing the feed health keeps the synthetic-traffic switch unless the new value sets it explicitly. */
  set feed(v: FeedInfo) {
    this.feedInfo = { ...v, synthetic: v.synthetic ?? this.feedInfo.synthetic };
  }
  /** Called after any change to persistent state (alerts, users, watchlists, ...). */
  onPersist: (() => void) | undefined;
  /** Vessels matching this predicate are evicted last when the store is full (e.g. the area of interest). */
  focus: ((v: Vessel) => boolean) | undefined;

  private dedupe = new Deduper();
  private manualContacts = 0;

  constructor(private readonly maxVessels = MAX_VESSELS) {}

  private ctx(now: number): RuleContext {
    return { policy: this.policy, geofences: this.geofences, now };
  }

  /** Switch data source: drops tracked vessels, alerts and de-duplication state (users/watchlists stay). */
  resetFeed(source: DataSource): void {
    this.source = source;
    this.feed = { connected: true };
    this.vessels.clear();
    this.alerts = [];
    this.dedupe = new Deduper();
    this.persist();
  }

  /** Turn the synthetic India traffic generator on/off (the runner — Durable Object or browser — reads this flag). */
  setSynthetic(on: boolean, actor: string): void {
    this.feed = { ...this.feed, synthetic: on };
    if (!on) this.removeSynthetic();
    this.log(actor, 'feed.synthetic', on ? 'on' : 'off');
  }

  /** Drop every synthetic vessel (and its alerts) — used when the generator is switched off. */
  removeSynthetic(): void {
    const gone = new Set<string>();
    for (const [mmsi, v] of this.vessels) {
      if (v.origin === 'synthetic') {
        gone.add(mmsi);
        this.vessels.delete(mmsi);
      }
    }
    if (gone.size > 0) {
      this.alerts = this.alerts.filter((a) => !gone.has(a.mmsi));
      this.persist();
    }
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
    // Terrestrial AIS (aisstream) has patchy coverage: silence usually means "out of receiver range", not "dark".
    if (this.source === 'aisstream') return 0;
    let n = 0;
    for (const { vessel, finding } of evaluateGaps(this.vessels.values(), this.ctx(now))) {
      if (this.raise(vessel, finding, now)) n++;
    }
    return n;
  }

  private evictStalest(): void {
    // Prefer evicting the stalest vessel OUTSIDE the focus area, so sparse reports near the area of interest survive.
    let oldest: string | undefined;
    let t = Infinity;
    let oldestAny: string | undefined;
    let tAny = Infinity;
    for (const [mmsi, v] of this.vessels) {
      if (v.lastSeen < tAny) {
        tAny = v.lastSeen;
        oldestAny = mmsi;
      }
      if (!this.focus?.(v) && v.lastSeen < t) {
        t = v.lastSeen;
        oldest = mmsi;
      }
    }
    const victim = oldest ?? oldestAny;
    if (victim && this.vessels.get(victim)?.origin === 'reported') return; // never evict user-reported contacts
    if (victim) this.vessels.delete(victim);
  }

  private raise(v: Vessel, f: Finding, now: number, force = false): Alert | null {
    if (!force && !this.dedupe.allow(v.mmsi, f.ruleId, now)) return null;
    const alert: Alert = {
      id: crypto.randomUUID(),
      ruleId: f.ruleId,
      severity: f.severity,
      mmsi: v.mmsi,
      vesselName: v.name,
      vesselClass: classOf(v),
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

  /**
   * Alerts visible to a user. Coast Guard / platform users see everything; company users only see alerts about
   * vessels in their own organisation's fleet (registry) or their personal set.
   */
  alertsFor(role: Role, username: string, fleet?: ReadonlySet<string>): Alert[] {
    if (!isCompanyRole(role)) return this.alerts;
    const mine = this.watchlists.get(username);
    return this.alerts.filter((a) => (mine?.has(a.mmsi) ?? false) || (fleet?.has(a.mmsi) ?? false));
  }

  /** Insert a ready-made alert (used by the voyage monitor and the case SLA sweeper). */
  pushAlert(alert: Alert): void {
    this.alerts.unshift(alert);
    if (this.alerts.length > MAX_ALERTS) this.alerts.length = MAX_ALERTS;
    this.persist();
  }

  /** Alert de-duplication for services that raise their own alerts. */
  allowAlert(mmsi: string, rule: Alert['ruleId'], now: number): boolean {
    return this.dedupe.allow(mmsi, rule, now);
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

  // ── flagging suspicious vessels (the business record is a Case, owned by the case service) ──
  /** Re-create map contacts for open manual cases (vessel positions themselves are not persisted). */
  restoreContacts(list: Array<{ mmsi: string; vesselName: string; lat: number; lon: number; ts: number }>): void {
    for (const c of list) if (!this.vessels.has(c.mmsi)) this.vessels.set(c.mmsi, this.contactVessel(c.mmsi, c.vesselName, c.lat, c.lon, c.ts));
  }

  removeContact(mmsi: string): void {
    if (this.vessels.get(mmsi)?.origin === 'reported') this.vessels.delete(mmsi);
  }

  private contactVessel(mmsi: string, name: string, lat: number, lon: number, now: number): Vessel {
    return { mmsi, origin: 'reported', name, lat, lon, sog: 0, cog: 0, heading: 0, category: 'other', flag: 'Unknown', lastSeen: now, trail: [] };
  }

  /**
   * Flag a vessel (existing track `mmsi`) or an unidentified boat at a position: adds it to the reporter's own set and
   * raises a high-priority alert. Returns what the case service needs to open a case.
   */
  flagVessel(
    input: { reporter: string; category: IncidentCategory; mmsi?: string; lat?: number; lon?: number },
    now: number = Date.now(),
  ): { vessel: Vessel; manual: boolean; nearest: NearestStation } | { error: string } {
    let vessel: Vessel | undefined;
    let manual = false;
    if (input.mmsi) {
      vessel = this.vessels.get(input.mmsi);
      if (!vessel) return { error: 'Vessel not found' };
    } else if (input.lat !== undefined && input.lat !== null && input.lon !== undefined) {
      let n = this.manualContacts + 1;
      let mmsi = `999${String(n).padStart(6, '0')}`;
      while (this.vessels.has(mmsi)) mmsi = `999${String(++n).padStart(6, '0')}`;
      this.manualContacts = n;
      vessel = this.contactVessel(mmsi, `Unidentified contact ${String(n).padStart(3, '0')}`, input.lat, input.lon, now);
      this.vessels.set(mmsi, vessel);
      manual = true;
    } else {
      return { error: 'Provide a vessel (mmsi) or a position (lat, lon)' };
    }
    const nearest = nearestStation(vessel.lat, vessel.lon);
    const set = this.watchlists.get(input.reporter) ?? new Set<string>();
    set.add(vessel.mmsi);
    this.watchlists.set(input.reporter, set);
    this.raise(vessel, {
      ruleId: 'user_report',
      severity: input.category === 'distress' ? 'critical' : 'high',
      message: `Reported by ${input.reporter} (${input.category.replace(/_/g, ' ')}): ${vessel.name} - routed to ${nearest.station.name} (${nearest.distanceNm} nm)`,
    }, now, true);
    this.log(input.reporter, 'vessel.flagged', `${vessel.mmsi} ${input.category} -> ${nearest.station.id}`);
    return { vessel, manual, nearest };
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
  async addUser(username: string, password: string, role: Role, displayName: string, station?: string, fleetName?: string, orgId?: string): Promise<void> {
    this.users.set(username, { username, role, displayName, station, fleetName, orgId, passwordHash: await hashPassword(password) });
    this.persist();
  }
  publicUser(u: User): PublicUser {
    return { username: u.username, role: u.role, displayName: u.displayName, station: u.station, fleetName: u.fleetName, orgId: u.orgId };
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
    return { vessels, alerts: this.alerts.slice(0, 100), ts: now, source: this.source, feed: this.feed };
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
