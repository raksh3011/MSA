/**
 * Backend abstraction. "live": the deployed Worker (REST + WebSocket).
 * "demo": the very same API app and risk engine running inside the browser, fed either by the
 * deterministic simulator (Indian Ocean scenarios) or by real, keyless live AIS (Digitraffic, Baltic Sea) —
 * so the site is fully functional with no server at all.
 */
import { createApp } from '../api/app';
import { DigitrafficClient } from '../core/digitraffic';
import { Hub } from '../core/hub';
import { FLEET_MMSIS, FLEET_NAME, Simulator } from '../core/simulator';
import { DESKS } from '../core/stations';
import type { Alert, DataSource, FeedInfo, PublicUser, Snapshot } from '../core/types';

export type Mode = 'live' | 'demo';
export interface Session {
  token: string;
  user: PublicUser;
}
export interface FeedData {
  vessels: Snapshot['vessels'];
  alerts: Alert[];
  ts: number;
  source: DataSource;
  feed?: FeedInfo;
}
export interface Reply<T> {
  status: number;
  data: T;
}
export interface FeedStatus {
  online: boolean;
  /** human-readable problem with the upstream source, if any */
  error?: string;
}

export const DEMO_PASSWORD = 'demo1234';
const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
const LIVE_POLL_MS = 10_000;

interface DemoState {
  hub: Hub;
  sim: Simulator;
  source: DataSource;
  dt: DigitrafficClient;
  lastLivePoll: number;
  /** real-time synthetic India traffic blended into a live feed */
  synth?: Simulator;
  error?: string;
}

export class Backend {
  private constructor(
    readonly mode: Mode,
    private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>,
    private readonly base: string,
    private readonly demo?: DemoState,
  ) {}

  static async connect(forceDemo = false): Promise<Backend> {
    if (!forceDemo) {
      try {
        const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(4000) });
        const body = (await res.json()) as { status?: string };
        if (res.ok && body.status === 'ok') return new Backend('live', (u, i) => fetch(u, i), API_BASE);
      } catch {
        /* no backend reachable: fall through to demo */
      }
    }
    return Backend.createDemo();
  }

  private static async createDemo(): Promise<Backend> {
    const hub = new Hub();
    const sim = new Simulator();
    const demo: DemoState = {
      hub,
      sim,
      source: 'simulated',
      dt: new DigitrafficClient((u, i) => fetch(u, i)),
      lastLivePoll: 0,
    };
    await hub.addUser('analyst', DEMO_PASSWORD, 'analyst', 'Demo Analyst (Coast Guard)');
    await hub.addUser('operator', DEMO_PASSWORD, 'operator', 'Fleet Manager', undefined, FLEET_NAME);
    await hub.addUser('admin', DEMO_PASSWORD, 'admin', 'Demo Administrator');
    for (const d of DESKS) await hub.addUser(`cg.${d.id}`, DEMO_PASSWORD, 'analyst', `CG Controller - ${d.name}`, d.id);
    // the demo operator manages a company fleet (distinct from the generic synthetic traffic)
    for (const mmsi of FLEET_MMSIS) hub.watch('operator', mmsi);
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
    // The API clock follows the data: simulated time for the simulator, wall-clock for real AIS.
    const app = createApp({ hub, jwtSecret: secret, now: () => (demo.source === 'simulated' ? demo.sim.now : Date.now()) });
    Backend.warmSim(demo);
    return new Backend('demo', (u, i) => Promise.resolve(app.fetch(new Request(u, i))), 'http://orvms.local', demo);
  }

  private static warmSim(d: DemoState): void {
    for (let i = 0; i < 45; i++) Backend.stepSim(d); // warm start so the first screen has history
  }

  /** Blend (or remove) real-time synthetic India traffic according to the hub's synthetic switch. */
  private static stepSynthetic(d: DemoState): void {
    if (!d.hub.feed.synthetic) {
      d.synth = undefined;
      return;
    }
    const now = Date.now();
    d.synth ??= new Simulator(7, now);
    for (const r of d.synth.tick(now)) d.hub.ingest(r, now);
  }

  private static stepSim(d: DemoState): void {
    for (const r of d.sim.tick()) d.hub.ingest(r, d.sim.now);
    d.hub.sweepGaps(d.sim.now);
  }

  /** Demo mode only: switch between the simulator and real live AIS. */
  async setDemoSource(source: DataSource): Promise<void> {
    const d = this.demo;
    if (!d || d.source === source) return;
    d.hub.resetFeed(source);
    d.source = source;
    d.error = undefined;
    d.lastLivePoll = 0;
    if (source === 'simulated') {
      d.sim = new Simulator();
      Backend.warmSim(d);
    } else {
      await this.pollLive(d);
    }
  }

  get demoSource(): DataSource | undefined {
    return this.demo?.source;
  }

  private async pollLive(d: DemoState): Promise<void> {
    d.lastLivePoll = Date.now();
    try {
      const now = Date.now();
      for (const r of await d.dt.poll(now)) d.hub.ingest(r, now);
      d.hub.sweepGaps(now);
      d.error = undefined;
    } catch (e) {
      d.error = e instanceof Error ? e.message : 'live feed unavailable';
    }
  }

  async request<T>(method: string, path: string, token?: string, body?: unknown): Promise<Reply<T>> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetcher(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const ct = res.headers.get('content-type') ?? '';
    const data = (ct.includes('json') ? await res.json() : await res.text()) as T;
    return { status: res.status, data };
  }

  /** One-shot fetch of vessels + alerts (also used to refresh immediately after an action). */
  async fetchOnce(session: Session): Promise<FeedData | null> {
    try {
      const [v, a] = await Promise.all([
        this.request<{ vessels: FeedData['vessels']; ts: number; source: DataSource; feed?: FeedInfo }>('GET', '/api/vessels', session.token),
        this.request<{ alerts: Alert[] }>('GET', '/api/alerts?limit=300', session.token),
      ]);
      if (v.status !== 200 || a.status !== 200) return null;
      return { vessels: v.data.vessels, alerts: a.data.alerts, ts: v.data.ts, source: v.data.source, feed: v.data.feed };
    } catch {
      return null;
    }
  }

  /** Start streaming updates. Returns a stop function. */
  startFeed(session: Session, onData: (d: FeedData) => void, onStatus: (s: FeedStatus) => void): () => void {
    const poll = async (): Promise<void> => {
      const d = await this.fetchOnce(session);
      if (d) {
        onData(d);
        onStatus({ online: true, error: this.demo?.error });
      } else onStatus({ online: false });
    };

    void poll();
    if (this.demo) {
      const d = this.demo;
      const timer = setInterval(() => {
        if (d.source === 'simulated') Backend.stepSim(d);
        else {
          Backend.stepSynthetic(d);
          if (Date.now() - d.lastLivePoll >= LIVE_POLL_MS) void this.pollLive(d);
        }
        void poll();
      }, 3000);
      return () => clearInterval(timer);
    }

    let ws: WebSocket | undefined;
    let closed = false;
    let retry = 2000;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const connect = (): void => {
      const origin = this.base || window.location.origin;
      const url = `${origin.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(session.token)}`;
      ws = new WebSocket(url);
      ws.onopen = () => {
        retry = 2000;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
      };
      ws.onmessage = (e: MessageEvent<string>) => {
        try {
          onData(JSON.parse(e.data) as FeedData);
          onStatus({ online: true });
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        onStatus({ online: false });
        if (closed) return;
        pollTimer ??= setInterval(() => void poll(), 15_000); // degrade gracefully to polling
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }
}
