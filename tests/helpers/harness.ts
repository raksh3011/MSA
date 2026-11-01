import { createApp } from '../../src/api/app';
import { Hub } from '../../src/core/hub';
import { MemoryRepo } from '../../src/data/memory';
import type { Repo } from '../../src/data/repo';
import type { FetchLike } from '../../src/domain/webhooks';
import { createServices, type Services } from '../../src/services/context';
import { seedDemo } from '../../src/services/seed';

export const PW = 'SeedPass#12345';
export const T0 = Date.UTC(2026, 9, 30, 8, 0, 0);

export interface WebhookCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A complete application instance on in-memory storage with a controllable clock and fake outbound HTTP. */
export async function makeHarness(opts: { seed?: boolean; allowInsecureWebhooks?: boolean; repo?: Repo } = {}) {
  let clock = T0;
  const hub = new Hub();
  const repo: Repo = opts.repo ?? new MemoryRepo();
  const calls: WebhookCall[] = [];
  const deferred: Promise<unknown>[] = [];
  let fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { status: 200, ok: true };
  };
  const services: Services = createServices({
    hub,
    repo,
    now: () => clock,
    fetch: (u, i) => fetchImpl(u, i),
    allowInsecureWebhooks: opts.allowInsecureWebhooks ?? false,
    defer: (p) => void deferred.push(p.catch(() => undefined)),
  });
  if (opts.seed !== false) await seedDemo(services, PW);
  const app = createApp({ hub, repo, services, jwtSecret: 'test-secret', now: () => clock });
  const tokens = new Map<string, string>();

  const call = (path: string, init: RequestInit & { token?: string } = {}) => {
    const { token, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (rest.body) headers.set('Content-Type', 'application/json');
    return app.request(path, { ...rest, headers });
  };
  const json = (method: string) => (path: string, body: unknown, token?: string) => call(path, { method, body: JSON.stringify(body), token });

  return {
    hub,
    repo,
    services,
    app,
    calls,
    call,
    post: json('POST'),
    put: json('PUT'),
    del: (path: string, token?: string) => call(path, { method: 'DELETE', token }),
    /** log in as a seeded user (cached) */
    async as(username: string): Promise<string> {
      const cached = tokens.get(username);
      if (cached) return cached;
      const res = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password: PW }) });
      const body = (await res.json()) as { token?: string };
      if (!body.token) throw new Error(`login failed for ${username}: ${res.status}`);
      tokens.set(username, body.token);
      return body.token;
    },
    now: () => clock,
    setClock: (t: number) => void (clock = t),
    advance: (ms: number) => void (clock += ms),
    setFetch: (f: FetchLike) => void (fetchImpl = f),
    /** wait for deferred background work (webhook deliveries) */
    flush: async () => void (await Promise.all(deferred.splice(0))),
  };
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>;
