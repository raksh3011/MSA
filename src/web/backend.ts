/** Client for the deployed ORVMS server (REST + WebSocket). All data and business logic live server-side. */
import type { Alert, DataSource, FeedInfo, PublicUser, Snapshot } from '../core/types';

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

const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
/** Static build (`vite build --mode static`): the server runs inside the page, see local.ts. */
export const STATIC_MODE = (import.meta.env.VITE_STATIC as string | undefined) === 'true';

export class Backend {
  /** true when the API runs inside this page (static demo) */
  readonly isLocal: boolean = false;
  protected constructor(protected readonly base: string) {}

  /** Resolves to a backend when the server answers its health check, otherwise null. */
  static async connect(): Promise<Backend | null> {
    if (STATIC_MODE) return (await import('./local')).LocalBackend.create();
    try {
      const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(6000) });
      const body = (await res.json()) as { status?: string };
      return res.ok && body.status === 'ok' ? new Backend(API_BASE) : null;
    } catch {
      return null;
    }
  }

  async request<T>(method: string, path: string, token?: string, body?: unknown): Promise<Reply<T>> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
        onStatus({ online: true });
      } else onStatus({ online: false });
    };

    void poll();
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
