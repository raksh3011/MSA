/**
 * Durable Object: the single global "hub" instance in production.
 *  - owns the Hub (state + risk engine) and the REST app
 *  - holds ONE upstream AIS WebSocket (aisstream.io), only while viewers are connected
 *  - fans snapshots out to browsers over hibernation-API WebSockets
 *  - persists alerts/users/watchlists/geofences/audit to DO storage
 */
import { DurableObject } from 'cloudflare:workers';
import { createApp } from '../api/app';
import { verifyToken } from '../core/auth';
import { Hub } from '../core/hub';
import { Simulator } from '../core/simulator';
import type { PositionReport, Role } from '../core/types';
import { parseAisMessage } from './ais';

export interface Env {
  HUB: DurableObjectNamespace;
  JWT_SECRET: string;
  AISSTREAM_API_KEY?: string;
  SEED_PASSWORD?: string;
  ALLOWED_ORIGINS?: string;
}

const BROADCAST_MS = 5000;
const IDLE_STOP_MS = 3 * 60_000;
const MIN_REPORT_GAP_MS = 10_000; // per-MMSI throttle: keeps CPU and bandwidth inside free-tier limits
const AIS_BBOX = [[-10, 44], [30, 100]]; // Indian Ocean region of interest
const MAX_STATIC = 20_000;

export class NavSightHub extends DurableObject<Env> {
  private readonly hub = new Hub();
  private readonly app;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private upstream: WebSocket | undefined;
  private sim: Simulator | undefined;
  private lastActivity = Date.now();
  private readonly lastAccepted = new Map<string, number>();
  private readonly statics = new Map<string, { name?: string; type?: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.app = createApp({
      hub: this.hub,
      jwtSecret: env.JWT_SECRET,
      allowedOrigins: (env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()),
    });
    this.hub.source = env.AISSTREAM_API_KEY ? 'live' : 'demo';
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<ReturnType<Hub['exportState']>>('state');
      if (saved) this.hub.importState(saved);
      if (this.hub.users.size === 0) await this.seedUsers();
      this.hub.onPersist = () => this.scheduleSave();
    });
  }

  private async seedUsers(): Promise<void> {
    const pw = this.env.SEED_PASSWORD;
    if (!pw || pw.length < 8) {
      console.warn('SEED_PASSWORD secret missing or too short: no users created. Set it with `wrangler secret put SEED_PASSWORD`.');
      return;
    }
    await this.hub.addUser('admin', pw, 'admin', 'Administrator');
    await this.hub.addUser('analyst', pw, 'analyst', 'Maritime Analyst');
    await this.hub.addUser('operator', pw, 'operator', 'Fleet Operator');
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
    if (this.env.AISSTREAM_API_KEY) void this.connectUpstream();
    else {
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
    this.sim = undefined;
  }

  private tick(): void {
    const viewers = this.ctx.getWebSockets();
    if (viewers.length === 0 && Date.now() - this.lastActivity > IDLE_STOP_MS) {
      this.stop();
      return;
    }
    if (this.sim) {
      this.stepSim(this.sim);
    } else {
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

  private stepSim(sim: Simulator): void {
    for (const r of sim.tick()) this.hub.ingest(r, sim.now);
    this.hub.sweepGaps(sim.now);
  }

  private async connectUpstream(): Promise<void> {
    try {
      const resp = await fetch('https://stream.aisstream.io/v0/stream', { headers: { Upgrade: 'websocket' } });
      const ws = resp.webSocket;
      if (!ws) throw new Error('upstream refused websocket upgrade');
      ws.accept();
      this.upstream = ws;
      ws.send(
        JSON.stringify({
          APIKey: this.env.AISSTREAM_API_KEY,
          BoundingBoxes: [AIS_BBOX],
          FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
        }),
      );
      ws.addEventListener('message', (e) => this.onUpstream(e.data));
      ws.addEventListener('close', () => {
        this.upstream = undefined;
        if (this.tickTimer) setTimeout(() => void this.connectUpstream(), 5000); // simple reconnect
      });
      ws.addEventListener('error', () => ws.close());
    } catch (err) {
      console.error('AIS upstream connect failed', err);
      this.upstream = undefined;
      if (this.tickTimer) setTimeout(() => void this.connectUpstream(), 15_000);
    }
  }

  private onUpstream(data: unknown): void {
    if (typeof data !== 'string') return;
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
    if (now - last < MIN_REPORT_GAP_MS) return;
    this.lastAccepted.set(parsed.report.mmsi, now);
    if (this.lastAccepted.size > 50_000) this.lastAccepted.clear();
    const st = this.statics.get(parsed.report.mmsi);
    const report: PositionReport = { ...parsed.report, shipType: st?.type, name: parsed.report.name ?? st?.name };
    this.hub.ingest(report, now);
  }
}
