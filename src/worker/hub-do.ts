/**
 * Durable Object: the single global "hub" instance in production.
 *  - owns the Hub (state + risk engine) and the REST app
 *  - holds ONE upstream AIS WebSocket (aisstream.io), only while viewers are connected
 *  - fans snapshots out to browsers over hibernation-API WebSockets
 *  - persists alerts/users/watchlists/geofences/audit to DO storage
 */
import { DurableObject } from 'cloudflare:workers';
import { createApp } from '../api/app';
import { hashPassword, verifyPassword, verifyToken } from '../core/auth';
import { DigitrafficClient } from '../core/digitraffic';
import { Hub } from '../core/hub';
import { Simulator } from '../core/simulator';
import { MemoryRepo } from '../data/memory';
import type { Repo } from '../data/repo';
import { SqlRepo, migrate, type SqlDb } from '../data/sql';
import { runBackground } from '../services/background';
import { createServices, type Services } from '../services/context';
import { SEED_USERNAMES, seedDemo } from '../services/seed';
import type { DataSource, PositionReport, Role } from '../core/types';
import { parseAisMessage } from './ais';
import { boxesFor, inBox, INDIA_BOX, minGapMs, parseRegion } from './regions';

export interface Env {
  HUB: DurableObjectNamespace;
  /** Cloudflare D1 database for business records (organisations, registry, voyages, cases, integrations). Falls back to memory when absent. */
  DB?: D1Database;
  JWT_SECRET: string;
  AISSTREAM_API_KEY?: string;
  /** 'aisstream' | 'digitraffic' | 'simulated'. Default: aisstream when a key is set, otherwise simulated. */
  DATA_SOURCE?: string;
  /** aisstream coverage: 'india' (India + chokepoints, default) | 'indian-ocean' | 'world' */
  AIS_REGION?: string;
  /** 'true' blends the synthetic India traffic generator into the live feed (analysts can also toggle it in the UI) */
  SYNTHETIC?: string;
  /** override the upstream endpoint (testing only) */
  AISSTREAM_URL?: string;
  SEED_PASSWORD?: string;
  ALLOWED_ORIGINS?: string;
}

const BROADCAST_MS = 5000;
const IDLE_STOP_MS = 3 * 60_000;
const MAX_STATIC = 20_000;

export class OrvmsHub extends DurableObject<Env> {
  private readonly hub = new Hub();
  private readonly app;
  private readonly repo: Repo;
  private readonly services: Services;
  private backgroundRunning = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private upstream: WebSocket | undefined;
  private sim: Simulator | undefined;
  /** real-time synthetic traffic blended into a live feed */
  private synth: Simulator | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly digitraffic = new DigitrafficClient((u, i) => fetch(u, i), { 'Digitraffic-User': 'ORVMS-student-project', 'Accept-Encoding': 'gzip' });
  private lastActivity = Date.now();
  private readonly lastAccepted = new Map<string, number>();
  private readonly statics = new Map<string, { name?: string; type?: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.repo = env.DB ? new SqlRepo(env.DB as unknown as SqlDb) : new MemoryRepo();
    if (!env.DB) console.warn('No D1 binding "DB": business records are kept in memory and lost on restart.');
    this.services = createServices({ hub: this.hub, repo: this.repo, defer: (p) => ctx.waitUntil(p.catch(() => undefined)) });
    this.app = createApp({
      hub: this.hub,
      repo: this.repo,
      services: this.services,
      jwtSecret: env.JWT_SECRET,
      allowedOrigins: (env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()),
    });
    this.hub.source = OrvmsHub.pickSource(env);
    this.hub.focus = (v) => inBox(v.lat, v.lon, INDIA_BOX);
    if (env.SYNTHETIC === 'true') this.hub.feed = { ...this.hub.feed, synthetic: true };
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<ReturnType<Hub['exportState']>>('state');
      if (saved) this.hub.importState(saved);
      if (env.DB) await migrate(env.DB as unknown as SqlDb);
      await this.seedAndRotate();
      // open "unidentified boat" reports must be visible on the map again after a restart
      this.hub.restoreContacts((await this.repo.cases.listOpen()).filter((c) => c.manual).map((c) => ({ mmsi: c.mmsi, vesselName: c.vesselName, lat: c.lat, lon: c.lon, ts: c.createdAt })));
      this.hub.onPersist = () => this.scheduleSave();
    });
  }

  static pickSource(env: Env): DataSource {
    if (env.DATA_SOURCE === 'digitraffic') return 'digitraffic';
    if (env.DATA_SOURCE === 'simulated') return 'simulated';
    if (env.DATA_SOURCE === 'aisstream' || env.AISSTREAM_API_KEY) return env.AISSTREAM_API_KEY ? 'aisstream' : 'simulated';
    return 'simulated';
  }

  /** Seed demo organisations/users on first run; apply a rotated SEED_PASSWORD to the seeded accounts. */
  private async seedAndRotate(): Promise<void> {
    const pw = this.env.SEED_PASSWORD;
    if (!pw || pw.length < 8) {
      console.warn('SEED_PASSWORD secret missing or too short: no demo users created. Set it with `wrangler secret put SEED_PASSWORD`.');
      return;
    }
    await seedDemo(this.services, pw);
    const admin = this.hub.users.get('admin');
    if (admin && !(await verifyPassword(pw, admin.passwordHash))) {
      const hash = await hashPassword(pw);
      for (const u of this.hub.users.values()) if (SEED_USERNAMES.includes(u.username)) u.passwordHash = hash;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.ctx.storage.put('state', this.hub.exportState());
    }, 5000);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.lastActivity = Date.now();
    if (url.pathname === '/ws') return this.handleWebSocket(request, url);
    if (url.pathname === '/api/vessels' || url.pathname === '/api/alerts') this.ensureRunning();
    return this.app.fetch(request);
  }

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const claims = await verifyToken(url.searchParams.get('token') ?? '', this.env.JWT_SECRET);
    if (!claims || !this.hub.users.has(claims.sub)) return new Response('Unauthorized', { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sub: claims.sub, role: claims.role });
    this.ensureRunning();
    server.send(this.snapshotFor(server, this.hub.snapshot()));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(): void {
    this.lastActivity = Date.now(); // client heartbeat
  }
  override webSocketClose(ws: WebSocket): void {
    ws.close();
  }

  // ── lifecycle: run only while someone is watching ──────────────────────────
  private ensureRunning(): void {
    if (this.tickTimer) return;
    if (this.hub.source === 'aisstream') void this.connectUpstream();
    else if (this.hub.source === 'digitraffic') {
      void this.pollDigitraffic();
      this.pollTimer = setInterval(() => void this.pollDigitraffic(), 10_000);
    } else {
      this.sim = new Simulator();
      for (let i = 0; i < 45; i++) this.stepSim(this.sim); // warm start: first viewers see history, not an empty sea
    }
    this.tickTimer = setInterval(() => this.tick(), BROADCAST_MS);
  }

  private stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    this.upstream?.close();
    this.upstream = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.sim = undefined;
  }

  private tick(): void {
    const viewers = this.ctx.getWebSockets();
    if (viewers.length === 0 && Date.now() - this.lastActivity > IDLE_STOP_MS) {
      this.stop();
      return;
    }
    if (!this.backgroundRunning) {
      this.backgroundRunning = true;
      this.ctx.waitUntil(runBackground(this.services).catch((e) => console.error('background run failed', e)).finally(() => { this.backgroundRunning = false; }));
    }
    if (this.sim) {
      this.stepSim(this.sim);
    } else {
      this.stepSynthetic();
      this.hub.sweepGaps(Date.now());
    }
    if (viewers.length > 0) {
      const snap = this.hub.snapshot(this.sim?.now ?? Date.now());
      for (const ws of viewers) {
        try {
          ws.send(this.snapshotFor(ws, snap));
        } catch {
          /* socket closing */
        }
      }
    }
  }

  /** Serialise a snapshot with the alert list filtered for this socket's user (operators see only their fleet). */
  private snapshotFor(ws: WebSocket, snap: ReturnType<Hub['snapshot']>): string {
    const who = ws.deserializeAttachment() as { sub: string; role: Role } | null;
    if (!who) return JSON.stringify({ ...snap, alerts: [] });
    return JSON.stringify({ ...snap, alerts: this.hub.alertsFor(who.role, who.sub).slice(0, 100) });
  }

  private async pollDigitraffic(): Promise<void> {
    try {
      const now = Date.now();
      let n = 0;
      for (const r of await this.digitraffic.poll(now)) {
        this.hub.ingest(r, now);
        n++;
      }
      this.hub.feed = { connected: true, lastMessageAt: now, messages: (this.hub.feed.messages ?? 0) + n, region: 'baltic' };
    } catch (err) {
      console.error('Digitraffic poll failed', err);
      this.hub.feed = { ...this.hub.feed, connected: false, error: 'Digitraffic unavailable' };
    }
  }

  /** Blend real-time synthetic India traffic into a live feed while the switch is on. */
  private stepSynthetic(): void {
    if (!this.hub.feed.synthetic) {
      this.synth = undefined;
      return;
    }
    const now = Date.now();
    this.synth ??= new Simulator(7, now);
    for (const r of this.synth.tick(now)) this.hub.ingest(r, now);
  }

  private stepSim(sim: Simulator): void {
    for (const r of sim.tick()) this.hub.ingest(r, sim.now);
    this.hub.sweepGaps(sim.now);
  }

  private async connectUpstream(): Promise<void> {
    try {
      const resp = await fetch(this.env.AISSTREAM_URL ?? 'https://stream.aisstream.io/v0/stream', { headers: { Upgrade: 'websocket' } });
      const ws = resp.webSocket;
      if (!ws) throw new Error('upstream refused websocket upgrade');
      ws.accept();
      this.upstream = ws;
      this.hub.feed = { connected: true, region: parseRegion(this.env.AIS_REGION), messages: 0 };
      ws.send(
        JSON.stringify({
          APIKey: this.env.AISSTREAM_API_KEY,
          BoundingBoxes: boxesFor(parseRegion(this.env.AIS_REGION)),
          FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
        }),
      );
      // aisstream.io sends BINARY frames (JSON bytes), so decode ArrayBuffer/Blob as well as text.
      ws.addEventListener('message', (e) => {
        const d: unknown = e.data;
        if (typeof d === 'string') this.onUpstream(d);
        else if (d instanceof ArrayBuffer) this.onUpstream(new TextDecoder().decode(d));
        else if (typeof Blob !== 'undefined' && d instanceof Blob) void d.text().then((t) => this.onUpstream(t));
      });
      ws.addEventListener('close', () => {
        this.upstream = undefined;
        this.hub.feed = { ...this.hub.feed, connected: false };
        if (this.tickTimer) setTimeout(() => void this.connectUpstream(), this.hub.feed.error ? 60_000 : 5000); // simple reconnect
      });
      ws.addEventListener('error', () => ws.close());
    } catch (err) {
      console.error('AIS upstream connect failed', err);
      this.upstream = undefined;
      this.hub.feed = { ...this.hub.feed, connected: false, error: 'Cannot reach aisstream.io' };
      if (this.tickTimer) setTimeout(() => void this.connectUpstream(), 15_000);
    }
  }

  private onUpstream(data: string): void {
    const f = this.hub.feed;
    this.hub.feed = { ...f, connected: true, lastMessageAt: Date.now(), messages: (f.messages ?? 0) + 1, error: undefined };
    if (data.startsWith('{"error"')) {
      // e.g. {"error":"Api Key Is Not Valid"}: surface it instead of silently showing an empty sea
      let message = 'aisstream.io rejected the subscription';
      try {
        message = String((JSON.parse(data) as { error?: unknown }).error ?? message);
      } catch {
        /* keep default */
      }
      this.hub.feed = { ...this.hub.feed, connected: false, error: message };
      return;
    }
    const parsed = parseAisMessage(data);
    if (!parsed) return;
    if (parsed.kind === 'static') {
      if (this.statics.size >= MAX_STATIC) this.statics.clear();
      this.statics.set(parsed.mmsi, { name: parsed.name, type: parsed.shipType });
      this.hub.updateStatic(parsed.mmsi, parsed.name, parsed.shipType);
      return;
    }
    const now = Date.now();
    const last = this.lastAccepted.get(parsed.report.mmsi) ?? 0;
    if (now - last < minGapMs(parsed.report.lat, parsed.report.lon)) return;
    this.lastAccepted.set(parsed.report.mmsi, now);
    if (this.lastAccepted.size > 50_000) this.lastAccepted.clear();
    const st = this.statics.get(parsed.report.mmsi);
    const report: PositionReport = { ...parsed.report, shipType: st?.type, name: parsed.report.name ?? st?.name };
    this.hub.ingest(report, now);
  }
}
