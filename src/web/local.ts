/**
 * Zero-backend mode: the real ORVMS server runs inside the browser tab.
 *
 * The REST API (Hono), services, domain rules, in-memory repository, risk engine and traffic simulator are the same modules the
 * Cloudflare Worker uses (`src/worker/hub-do.ts`); only the transport differs: requests go to `app.fetch()` instead of the network,
 * and the "WebSocket" feed is a timer. Used for the hosted static demo; state lives in memory and resets on reload.
 */
import { createApp } from '../api/app';
import { Hub } from '../core/hub';
import { Simulator } from '../core/simulator';
import type { PublicUser } from '../core/types';
import { MemoryRepo } from '../data/memory';
import { runBackground } from '../services/background';
import { createServices, type Services } from '../services/context';
import { seedDemo } from '../services/seed';
import { DEMO_PASSWORD } from './personas';
import { INDIA_BOX, inBox } from '../worker/regions';
import { Backend, type FeedData, type FeedStatus, type Reply, type Session } from './backend';

export const SPEEDS = [1, 4, 16] as const;
const BASE_TICK_MS = 4000;

export class LocalServer {
  readonly hub = new Hub();
  readonly repo = new MemoryRepo();
  readonly services: Services;
  private readonly app: ReturnType<typeof createApp>;
  private sim = new Simulator();
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private listeners = new Set<() => void>();
  speed: (typeof SPEEDS)[number] = 4;
  paused = false;
  /** simulated vessel-seconds elapsed since the page opened (shown in the demo bar) */
  ticks = 0;

  private constructor() {
    this.services = createServices({ hub: this.hub, repo: this.repo, allowInsecureWebhooks: false });
    this.services.state.environment = 'browser demo';
    this.app = createApp({ hub: this.hub, repo: this.repo, services: this.services, jwtSecret: crypto.randomUUID() + crypto.randomUUID() });
    this.hub.source = 'simulated';
    this.hub.focus = (v) => inBox(v.lat, v.lon, INDIA_BOX);
  }

  static async start(): Promise<LocalServer> {
    const s = new LocalServer();
    await seedDemo(s.services, DEMO_PASSWORD);
    for (let i = 0; i < 45; i++) s.step(); // warm start: the first viewer sees history, not an empty sea
    s.schedule();
    return s;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private step(): void {
    for (const r of this.sim.tick()) this.hub.ingest(r, this.sim.now);
    this.hub.sweepGaps(this.sim.now);
    this.ticks++;
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), BASE_TICK_MS / this.speed);
  }

  private async tick(): Promise<void> {
    if (this.paused) return;
    this.step();
    if (!this.busy) {
      this.busy = true;
      try {
        await runBackground(this.services);
      } catch (e) {
        console.error('background run failed', e);
      } finally {
        this.busy = false;
      }
    }
    for (const fn of this.listeners) fn();
  }

  setSpeed(s: (typeof SPEEDS)[number]): void {
    this.speed = s;
    this.schedule();
  }
  setPaused(p: boolean): void {
    this.paused = p;
    for (const fn of this.listeners) fn();
  }

  /** The simulated clock (the traffic simulator runs in time-lapse). */
  get simTime(): number {
    return this.sim.now;
  }

  async fetch(method: string, path: string, token: string | undefined, body: unknown): Promise<Reply<unknown>> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.app.fetch(new Request(`http://orvms.local${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
  }

  snapshotFor(user: PublicUser): FeedData {
    const snap = this.hub.snapshot(this.sim.now);
    return { vessels: snap.vessels, alerts: this.hub.alertsFor(user.role, user.username).slice(0, 100), ts: snap.ts, source: snap.source, feed: snap.feed };
  }
}

/** Backend implementation that talks to the in-browser server instead of the network. */
export class LocalBackend extends Backend {
  override readonly isLocal = true;
  private constructor(readonly server: LocalServer) {
    super('');
  }

  static async create(): Promise<LocalBackend> {
    return new LocalBackend(await LocalServer.start());
  }

  override async request<T>(method: string, path: string, token?: string, body?: unknown): Promise<Reply<T>> {
    return (await this.server.fetch(method, path, token, body)) as Reply<T>;
  }

  override async fetchOnce(session: Session): Promise<FeedData | null> {
    return this.server.snapshotFor(session.user);
  }

  override startFeed(session: Session, onData: (d: FeedData) => void, onStatus: (s: FeedStatus) => void): () => void {
    const push = (): void => {
      onData(this.server.snapshotFor(session.user));
      onStatus({ online: true });
    };
    push();
    return this.server.onChange(push);
  }
}
