/**
 * Hub — the platform-independent heart of ORVMS: vessel state, risk engine,
 * alert lifecycle, watchlists, geofences, audit trail. The Worker's Durable Object
 * and the in-browser demo both wrap exactly this class.
 */
import { hashPassword } from './auth';
import { DEFAULT_POLICY, Deduper, classOf, evaluateGaps, evaluateVessel, type Finding, type RuleContext } from './engine';
import type {
  Alert,
  AlertStatus,
  AuditEntry,
  DataSource,
  FeedInfo,
  Geofence,
  Incident,
  IncidentCategory,
  IncidentStatus,
  Policy,
  PositionReport,
  PublicUser,
  Role,
  Snapshot,
  User,
  Vessel,
} from './types';
import { deskOf, nearestStation } from './stations';
import { categoryFromShipType, normalizeReport, TRAIL_LENGTH } from './vessel';

export const MAX_VESSELS = 6000;
export const MAX_ALERTS = 500;
export const MAX_INCIDENTS = 500;
const MAX_AUDIT = 500;

export interface HubState {
  alerts: Alert[];
  users: User[];
  watchlists: Record<string, string[]>;
  geofences: Geofence[];
  audit: AuditEntry[];
  policy: Policy;
  incidents?: Incident[];
}

export class Hub {
  readonly vessels = new Map<string, Vessel>();
  alerts: Alert[] = [];
  readonly users = new Map<string, User>();
  readonly watchlists = new Map<string, Set<string>>();
  geofences: Geofence[] = [];
  audit: AuditEntry[] = [];
  incidents: Incident[] = [];
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
    this.restoreReportedContacts();
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

  // ── incidents: user reports routed to the nearest Coast Guard controller ───
  /** Re-create map contacts for open manual reports (vessel positions themselves are not persisted). */
  private restoreReportedContacts(): void {
    for (const i of this.incidents) {
      if (i.manual && i.status !== 'closed' && !this.vessels.has(i.mmsi)) this.vessels.set(i.mmsi, this.contactVessel(i, i.ts));
    }
  }

  private contactVessel(i: Pick<Incident, 'mmsi' | 'vesselName' | 'lat' | 'lon'>, now: number): Vessel {
    return {
      mmsi: i.mmsi, origin: 'reported', name: i.vesselName, lat: i.lat, lon: i.lon, sog: 0, cog: 0, heading: 0,
      category: 'other', flag: 'Unknown', lastSeen: now, trail: [],
    };
  }

  /**
   * File a report about a vessel (existing track `mmsi`) or an unidentified boat at a position (`lat`/`lon`).
   * Adds the vessel to the reporter's set, raises a high-priority alert and routes it to the nearest controller.
   */
  reportIncident(input: { reporter: string; role: Role; category: IncidentCategory; note: string; mmsi?: string; lat?: number; lon?: number }, now: number = Date.now()): Incident | { error: string } {
    let vessel: Vessel | undefined;
    let manual = false;
    if (input.mmsi) {
      vessel = this.vessels.get(input.mmsi);
      if (!vessel) return { error: 'Vessel not found' };
    } else if (input.lat !== undefined && input.lon !== undefined) {
      let n = this.incidents.length + 1;
      let mmsi = `999${String(n).padStart(6, '0')}`;
      while (this.vessels.has(mmsi)) mmsi = `999${String(++n).padStart(6, '0')}`;
      vessel = this.contactVessel({ mmsi, vesselName: `Unidentified contact ${String(n).padStart(3, '0')}`, lat: input.lat, lon: input.lon }, now);
      this.vessels.set(mmsi, vessel);
      manual = true;
    } else {
      return { error: 'Provide a vessel (mmsi) or a position (lat, lon)' };
    }
    const near = nearestStation(vessel.lat, vessel.lon);
    const incident: Incident = {
      id: crypto.randomUUID(), ts: now, reporter: input.reporter, reporterRole: input.role, mmsi: vessel.mmsi, vesselName: vessel.name,
      lat: vessel.lat, lon: vessel.lon, category: input.category, note: input.note.slice(0, 500), status: 'open',
      station: { id: near.station.id, name: near.station.name, distanceNm: near.distanceNm, desk: deskOf(near.station.id) }, manual,
      history: [{ ts: now, actor: input.reporter, action: 'reported', note: input.note.slice(0, 500) }],
    };
    this.incidents.unshift(incident);
    if (this.incidents.length > MAX_INCIDENTS) this.incidents.length = MAX_INCIDENTS;
    // add to the reporter's own set and raise a priority alert for controllers
    const set = this.watchlists.get(input.reporter) ?? new Set<string>();
    set.add(vessel.mmsi);
    this.watchlists.set(input.reporter, set);
    this.raise(vessel, {
      ruleId: 'user_report',
      severity: input.category === 'distress' ? 'critical' : 'high',
      message: `Reported by ${input.reporter} (${input.category.replace(/_/g, ' ')}): ${vessel.name} - routed to ${near.station.name} (${near.distanceNm} nm)`,
    }, now, true);
    this.log(input.reporter, 'incident.reported', `${vessel.mmsi} ${input.category} -> ${near.station.id}`);
    return incident;
  }

  /** Controller actions on an incident (acknowledge, investigate, close). */
  updateIncident(id: string, status: Exclude<IncidentStatus, 'open'>, actor: string, note?: string, now: number = Date.now()): Incident | null {
    const i = this.incidents.find((x) => x.id === id);
    if (!i) return null;
    i.status = status;
    i.history.push({ ts: now, actor, action: status, note: note?.slice(0, 500) });
    if (status === 'closed' && i.manual) this.vessels.delete(i.mmsi);
    this.log(actor, `incident.${status}`, `${i.mmsi} @${i.station.id}`);
    return i;
  }

  /** Reporters see their own reports; analysts and admins see everything. */
  incidentsFor(role: Role, username: string): Incident[] {
    return role === 'operator' ? this.incidents.filter((i) => i.reporter === username) : this.incidents;
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
  async addUser(username: string, password: string, role: Role, displayName: string, station?: string, fleetName?: string): Promise<void> {
    this.users.set(username, { username, role, displayName, station, fleetName, passwordHash: await hashPassword(password) });
    this.persist();
  }
  publicUser(u: User): PublicUser {
    return { username: u.username, role: u.role, displayName: u.displayName, station: u.station, fleetName: u.fleetName };
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
      incidents: this.incidents,
    };
  }
  importState(s: Partial<HubState>): void {
    if (s.alerts) this.alerts = s.alerts;
    if (s.users) for (const u of s.users) this.users.set(u.username, u);
    if (s.watchlists) for (const [k, v] of Object.entries(s.watchlists)) this.watchlists.set(k, new Set(v));
    if (s.geofences) this.geofences = s.geofences;
    if (s.audit) this.audit = s.audit;
    if (s.policy) this.policy = { ...DEFAULT_POLICY, ...s.policy };
    if (s.incidents) this.incidents = s.incidents;
    this.restoreReportedContacts();
  }
}
