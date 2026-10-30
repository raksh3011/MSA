/**
 * Backend abstraction. "live": the deployed Worker (REST + WebSocket).
 * "demo": the very same API app and risk engine running inside the browser,
 * fed by the simulator — so the site is fully functional with no server at all.
 */
import { createApp } from '../api/app';
import { Hub } from '../core/hub';
import { Simulator } from '../core/simulator';
import type { Alert, PublicUser, Snapshot } from '../core/types';

export type Mode = 'live' | 'demo';
export interface Session {
  token: string;
  user: PublicUser;
}
export interface FeedData {
  vessels: Snapshot['vessels'];
  alerts: Alert[];
  ts: number;
  source: Snapshot['source'];
}
export interface Reply<T> {
  status: number;
  data: T;
}

export const DEMO_PASSWORD = 'demo1234';
const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

export class Backend {
  private constructor(
    readonly mode: Mode,
    private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>,
    private readonly base: string,
    private readonly demo?: { hub: Hub; sim: Simulator },
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
    hub.source = 'demo';
    await hub.addUser('analyst', DEMO_PASSWORD, 'analyst', 'Demo Analyst (Coast Guard)');
    await hub.addUser('operator', DEMO_PASSWORD, 'operator', 'Demo Fleet Operator');
    await hub.addUser('admin', DEMO_PASSWORD, 'admin', 'Demo Administrator');
    hub.watch('operator', '636092001');
    hub.watch('operator', '419000011');
    hub.watch('operator', '470000555');
    hub.watch('operator', '477000310');
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
    const app = createApp({ hub, jwtSecret: secret, now: () => sim.now }); // API clock = simulated clock
    for (let i = 0; i < 45; i++) Backend.stepDemo({ hub, sim }); // warm start so the first screen has history
    return new Backend('demo', (u, i) => Promise.resolve(app.fetch(new Request(u, i))), 'http://navsight.local', { hub, sim });
  }

  private static stepDemo(d: { hub: Hub; sim: Simulator }): void {
    for (const r of d.sim.tick()) d.hub.ingest(r, d.sim.now);
    d.hub.sweepGaps(d.sim.now);
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
        this.request<{ vessels: FeedData['vessels']; ts: number; source: FeedData['source'] }>('GET', '/api/vessels', session.token),
        this.request<{ alerts: Alert[] }>('GET', '/api/alerts?limit=200', session.token),
      ]);
      if (v.status !== 200 || a.status !== 200) return null;
      return { vessels: v.data.vessels, alerts: a.data.alerts, ts: v.data.ts, source: v.data.source };
    } catch {
      return null;
    }
  }

  /** Start streaming updates. Returns a stop function. */
  startFeed(session: Session, onData: (d: FeedData) => void, onStatus: (online: boolean) => void): () => void {
    const poll = async (): Promise<void> => {
      const d = await this.fetchOnce(session);
      if (d) {
        onData(d);
        onStatus(true);
      } else onStatus(false);
    };

    void poll();
    if (this.demo) {
      const d = this.demo;
      const timer = setInterval(() => {
        Backend.stepDemo(d);
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
          const snap = JSON.parse(e.data) as FeedData;
          onData(snap);
          onStatus(true);
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        onStatus(false);
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
