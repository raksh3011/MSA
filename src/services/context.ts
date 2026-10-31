import type { Hub } from '../core/hub';
import type { Repo } from '../data/repo';
import type { FetchLike } from '../domain/webhooks';
import { dispatchEvent } from '../domain/webhooks';
import type { WebhookEvent } from '../domain/types';

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
}

export function createServices(partial: Pick<Services, 'hub' | 'repo'> & Partial<Services>): Services {
  return {
    now: Date.now,
    fetch: async (url, init) => {
      const r = await fetch(url, init);
      return { status: r.status, ok: r.ok };
    },
    allowInsecureWebhooks: false,
    defer: (p) => void p.catch(() => undefined),
    ...partial,
  };
}

/** Publish a domain event to the organisation's subscribed webhooks (never throws into the caller). */
export function emit(s: Services, orgId: string, event: WebhookEvent, data: unknown): void {
  s.defer(dispatchEvent(s.repo, orgId, event, data, { fetch: s.fetch, now: s.now() }).catch(() => []));
}
