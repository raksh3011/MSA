/**
 * ORVMS REST API (Hono). Platform-neutral: runs inside the Cloudflare Durable Object
 * in production and inside the browser (via app.fetch) for the zero-backend demo.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { hashPassword, signToken, verifyPassword, verifyToken, type TokenClaims } from '../core/auth';
import { isValidCoord } from '../core/geo';
import type { Hub } from '../core/hub';
import { STATIONS } from '../core/stations';
import { isCompanyRole, type Alert, type Policy, type Role } from '../core/types';
import type { Repo } from '../data/repo';
import type { FetchLike } from '../domain/webhooks';
import { createServices, type Services } from '../services/context';
import { fleetMmsis, orgIdOf } from '../services/org';
import { registerEnterpriseRoutes } from './routes/enterprise';
import { BOUNDARIES, FOREIGN_WATERS, HIGH_RISK_ZONES, ZONES_META } from '../core/zones';
import { RateLimiter } from './ratelimit';
import { alertsToCsv } from './csv';

export interface AppDeps {
  hub: Hub;
  /** business-record storage (organisations, registry, voyages, cases, integrations) */
  repo: Repo;
  /** share one Services instance with the background runner (optional; created from the other deps otherwise) */
  services?: Services;
  fetch?: FetchLike;
  allowInsecureWebhooks?: boolean;
  defer?: (work: Promise<unknown>) => void;
  jwtSecret: string;
  /** allowed CORS origins; ['*'] allows any (safe: bearer tokens, no cookies) */
  allowedOrigins?: string[];
  now?: () => number;
}

type Env = { Variables: { claims: TokenClaims } };

const MMSI_RE = /^\d{9}$/;
const ALERT_STATUSES = new Set(['open', 'acknowledged', 'resolved']);
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

export function createApp(deps: AppDeps): Hono<Env> {
  const { hub, jwtSecret } = deps;
  const now = deps.now ?? Date.now;
  const services = deps.services ?? createServices({ hub, repo: deps.repo, now, fetch: deps.fetch, allowInsecureWebhooks: deps.allowInsecureWebhooks ?? false, defer: deps.defer });
  const app = new Hono<Env>();
  const loginLimiter = new RateLimiter(10, 60_000);
  const reportLimiter = new RateLimiter(10, 60_000);
  let dummyHash: Promise<string> | undefined;

  const clientKey = (c: Context): string =>
    c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';

  // ── security headers + CORS ────────────────────────────────────────────────
  app.use(
    '*',
    cors({
      origin: (deps.allowedOrigins?.includes('*') ?? true) ? '*' : (o: string) => (deps.allowedOrigins?.includes(o) ? o : null),
      allowHeaders: ['Authorization', 'Content-Type'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
  });

  // ── auth middleware ────────────────────────────────────────────────────────
  const requireAuth =
    (...roles: Role[]): MiddlewareHandler<Env> =>
    async (c, next) => {
      const header = c.req.header('Authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const claims = token ? await verifyToken(token, jwtSecret, now()) : null;
      if (!claims || !hub.users.has(claims.sub)) return c.json({ error: 'Authentication required' }, 401);
      if (roles.length > 0 && !roles.includes(claims.role)) return c.json({ error: 'Forbidden for your role' }, 403);
      c.set('claims', claims);
      await next();
    };

  const readJson = async (c: Context): Promise<Record<string, unknown> | null> => {
    try {
      const body: unknown = await c.req.json();
      return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  /** Company users see alerts for their organisation's fleet (registry) and personal set; Coast Guard / platform see all. */
  const visibleAlerts = async (claims: TokenClaims): Promise<Alert[]> => {
    if (!isCompanyRole(claims.role)) return hub.alerts;
    const orgId = orgIdOf(services, claims.sub);
    return hub.alertsFor(claims.role, claims.sub, orgId ? await fleetMmsis(services, orgId) : undefined);
  };

  // ── public ─────────────────────────────────────────────────────────────────
  app.get('/api/health', (c) =>
    c.json({ status: 'ok', source: hub.source, feed: hub.feed, vessels: hub.vessels.size, alerts: hub.alerts.length, ts: now() }),
  );

  app.get('/api/public/zones', (c) =>
    c.json({
      disclaimer: 'Modelled zones for situational awareness only. Not the official gazetted limits. Not for navigation or legal use.',
      method: ZONES_META.method,
      source: ZONES_META.source,
      boundaries: BOUNDARIES,
      neighbours: FOREIGN_WATERS.map((f) => ({ code: f.code, name: f.name })),
      highRisk: HIGH_RISK_ZONES,
    }),
  );

  // ── auth ───────────────────────────────────────────────────────────────────
  app.post('/api/auth/login', async (c) => {
    if (!loginLimiter.allow(clientKey(c), now())) return c.json({ error: 'Too many login attempts. Try again later.' }, 429);
    const body = await readJson(c);
    const username = body?.username;
    const password = body?.password;
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || username.length > 64 || password.length > 128) {
      return c.json({ error: 'username and password are required' }, 400);
    }
    const user = hub.users.get(username.toLowerCase());
    dummyHash ??= hashPassword('not-a-real-password');
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
    if (!user || !ok) {
      hub.log(username.slice(0, 64), 'auth.login_failed', clientKey(c));
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    hub.log(user.username, 'auth.login', clientKey(c));
    const token = await signToken({ sub: user.username, role: user.role }, jwtSecret, 8 * 3600, now());
    return c.json({ token, user: hub.publicUser(user) });
  });

  app.get('/api/me', requireAuth(), (c) => {
    const claims = c.get('claims');
    const user = hub.users.get(claims.sub);
    return user ? c.json({ user: hub.publicUser(user), watchlist: hub.watchlistOf(claims.sub) }) : c.json({ error: 'Not found' }, 404);
  });

  // ── vessels ────────────────────────────────────────────────────────────────
  app.get('/api/vessels', requireAuth(), (c) => {
    const snap = hub.snapshot(now());
    return c.json({ vessels: snap.vessels, total: snap.vessels.length, ts: snap.ts, source: snap.source, feed: snap.feed });
  });

  app.get('/api/vessels/:mmsi', requireAuth(), (c) => {
    const mmsi = c.req.param('mmsi');
    if (!MMSI_RE.test(mmsi)) return c.json({ error: 'MMSI must be 9 digits' }, 400);
    const v = hub.vessels.get(mmsi);
    return v ? c.json(v) : c.json({ error: 'Vessel not found' }, 404);
  });

  // ── alerts ─────────────────────────────────────────────────────────────────
  app.get('/api/alerts', requireAuth(), async (c) => {
    const claims = c.get('claims');
    const status = c.req.query('status');
    const severity = c.req.query('severity');
    if ((status && !ALERT_STATUSES.has(status)) || (severity && !SEVERITIES.has(severity))) {
      return c.json({ error: 'Invalid status or severity filter' }, 400);
    }
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100) || 100));
    const list = (await visibleAlerts(claims))
      .filter((a) => (!status || a.status === status) && (!severity || a.severity === severity))
      .slice(0, limit);
    return c.json({ alerts: list, total: list.length });
  });

  const transition = (status: 'acknowledged' | 'resolved') => async (c: Context<Env>) => {
    const claims = c.get('claims');
    const id = c.req.param('id') ?? '';
    const alert = (await visibleAlerts(claims)).find((a) => a.id === id);
    if (!alert) return c.json({ error: 'Alert not found' }, 404);
    const body = await readJson(c);
    const note = typeof body?.note === 'string' ? body.note : undefined;
    return c.json(hub.updateAlert(id, status, claims.sub, note));
  };
  app.post('/api/alerts/:id/ack', requireAuth(), transition('acknowledged'));
  app.post('/api/alerts/:id/resolve', requireAuth(), transition('resolved'));

  app.get('/api/reports/alerts.csv', requireAuth(), async (c) => {
    const csv = alertsToCsv(await visibleAlerts(c.get('claims')));
    return new Response(csv, {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="orvms-alerts.csv"', 'Access-Control-Allow-Origin': '*' },
    });
  });

  // ── watchlist ("my set") ───────────────────────────────────────────────────
  app.get('/api/watchlist', requireAuth(), (c) => c.json({ mmsi: hub.watchlistOf(c.get('claims').sub) }));

  app.post('/api/watchlist', requireAuth(), async (c) => {
    const body = await readJson(c);
    const mmsi = body?.mmsi;
    if (typeof mmsi !== 'string' || !MMSI_RE.test(mmsi)) return c.json({ error: 'mmsi must be a 9-digit string' }, 400);
    const list = hub.watchlistOf(c.get('claims').sub);
    if (list.length >= 200) return c.json({ error: 'Watchlist limit (200) reached' }, 400);
    hub.watch(c.get('claims').sub, mmsi);
    return c.json({ mmsi: hub.watchlistOf(c.get('claims').sub) }, 201);
  });

  app.delete('/api/watchlist/:mmsi', requireAuth(), (c) => {
    const ok = hub.unwatch(c.get('claims').sub, c.req.param('mmsi'));
    return ok ? c.json({ removed: true }) : c.json({ error: 'Not on watchlist' }, 404);
  });

  // ── enterprise modules: tenancy, registry, voyages, cases, integrations ────
  app.get('/api/stations', requireAuth(), (c) => c.json({ stations: STATIONS }));
  registerEnterpriseRoutes(app, { s: services, requireAuth, readJson, reportLimiter });

  // ── synthetic traffic switch ───────────────────────────────────────────────
  app.put('/api/feed/synthetic', requireAuth('analyst', 'admin'), async (c) => {
    const body = await readJson(c);
    if (typeof body?.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) is required' }, 400);
    hub.setSynthetic(body.enabled, c.get('claims').sub);
    return c.json({ synthetic: body.enabled });
  });

  // ── geofences ──────────────────────────────────────────────────────────────
  app.get('/api/geofences', requireAuth(), (c) => c.json({ geofences: hub.geofences }));

  app.post('/api/geofences', requireAuth('analyst', 'admin'), async (c) => {
    const body = await readJson(c);
    const { name, lat, lon, radiusNm } = body ?? {};
    if (
      typeof name !== 'string' || name.trim().length < 1 || name.length > 60 ||
      typeof lat !== 'number' || typeof lon !== 'number' || !isValidCoord(lat, lon) ||
      typeof radiusNm !== 'number' || !(radiusNm >= 1 && radiusNm <= 500)
    ) {
      return c.json({ error: 'name (1-60 chars), lat, lon and radiusNm (1-500) are required' }, 400);
    }
    if (hub.geofences.length >= 100) return c.json({ error: 'Geofence limit (100) reached' }, 400);
    return c.json(hub.addGeofence({ name: name.trim(), lat, lon, radiusNm, createdBy: c.get('claims').sub }), 201);
  });

  app.delete('/api/geofences/:id', requireAuth('analyst', 'admin'), (c) =>
    hub.removeGeofence(c.req.param('id'), c.get('claims').sub) ? c.json({ removed: true }) : c.json({ error: 'Geofence not found' }, 404),
  );

  // ── policy + audit (admin) ─────────────────────────────────────────────────
  app.get('/api/policy', requireAuth(), (c) => c.json(hub.policy));

  app.put('/api/policy', requireAuth('admin'), async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'JSON body required' }, 400);
    const next: Partial<Policy> = {};
    const num = (key: 'highSpeedKn' | 'aisGapMinutes' | 'loiterSogKn' | 'approachNm', lo: number, hi: number): boolean => {
      const val = body[key];
      if (val === undefined) return true;
      if (typeof val !== 'number' || !Number.isFinite(val) || val < lo || val > hi) return false;
      next[key] = val;
      return true;
    };
    if (!num('highSpeedKn', 5, 60) || !num('aisGapMinutes', 5, 720) || !num('loiterSogKn', 0, 10) || !num('approachNm', 10, 200)) {
      return c.json({ error: 'Policy value out of range' }, 400);
    }
    if (body.flagsOfInterest !== undefined) {
      const f = body.flagsOfInterest;
      if (!Array.isArray(f) || f.length > 30 || f.some((x) => typeof x !== 'string' || x.length > 40)) {
        return c.json({ error: 'flagsOfInterest must be an array of up to 30 short strings' }, 400);
      }
      next.flagsOfInterest = f as string[];
    }
    return c.json(hub.setPolicy(next, c.get('claims').sub));
  });

  app.get('/api/audit', requireAuth('admin'), (c) => c.json({ audit: hub.audit.slice(0, 200) }));

  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError((err, c) => {
    console.error('Unhandled error', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
