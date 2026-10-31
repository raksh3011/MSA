import type { Hub } from '../core/hub';
import type { Repo } from '../data/repo';
import type { FetchLike } from '../domain/webhooks';
import { dispatchEvent } from '../domain/webhooks';
import type { WebhookEvent } from '../domain/types';

export type LogLevel = 'info' | 'warn' | 'error';
export interface LogEntry {
  ts: number;
  level: LogLevel;
  event: string;
  data?: Record<string, unknown>;
}

/** Runtime facts the operations console reports (kept in memory; rebuilt after a restart). */
export interface RuntimeState {
  bootedAt: number;
  /** deployment environment shown on the operations console (production | staging | local) */
  environment: string;
  backgroundRuns: number;
  backgroundErrors: number;
  lastBackground?: { at: number; ms: number; result: Record<string, number> };
  lastBilling: number;
  lastReports: number;
  lastRetention: number;
  /** structured log ring buffer (newest last) */
  logs: LogEntry[];
}

/** Everything the application services need. Built once per runtime (Worker, tests). */
export interface Services {
  hub: Hub;
  repo: Repo;
  now: () => number;
  /** outbound HTTP for webhooks */
  fetch: FetchLike;
  /** allow plain-http / private webhook targets (tests and local demos only) */
  allowInsecureWebhooks: boolean;
  /** schedule background work (Worker: ctx.waitUntil). Defaults to fire-and-forget. */
  defer: (work: Promise<unknown>) => void;
  state: RuntimeState;
  /** structured logging: one JSON line per event on the console, plus an in-memory ring for the ops console */
  log: (level: LogLevel, event: string, data?: Record<string, unknown>) => void;
}

const LOG_RING = 300;
const quiet = (): boolean => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITEST !== undefined;

export function createServices(partial: Pick<Services, 'hub' | 'repo'> & Partial<Services>): Services {
  const now = partial.now ?? Date.now;
  const state: RuntimeState = partial.state ?? { bootedAt: now(), environment: 'production', backgroundRuns: 0, backgroundErrors: 0, lastBilling: 0, lastReports: 0, lastRetention: 0, logs: [] };
  const log: Services['log'] = (level, event, data) => {
    const entry: LogEntry = { ts: now(), level, event, data };
    state.logs.push(entry);
    if (state.logs.length > LOG_RING) state.logs.splice(0, state.logs.length - LOG_RING);
    if (!quiet()) console.log(JSON.stringify({ t: new Date(entry.ts).toISOString(), level, event, ...data }));
  };
  return {
    now,
    fetch: async (url, init) => {
      const r = await fetch(url, init);
      return { status: r.status, ok: r.ok };
    },
    allowInsecureWebhooks: false,
    defer: (p) => void p.catch(() => undefined),
    state,
    log,
    ...partial,
  };
}

/** Publish a domain event to the organisation's subscribed webhooks (never throws into the caller). */
export function emit(s: Services, orgId: string, event: WebhookEvent, data: unknown): void {
  s.defer(dispatchEvent(s.repo, orgId, event, data, { fetch: s.fetch, now: s.now() }).catch(() => []));
}
