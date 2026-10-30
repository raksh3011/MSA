import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { Hub } from '../../src/core/hub';

const SECRET = 'test-secret';
let app: ReturnType<typeof createApp>;
let hub: Hub;
const tokens: Record<string, string> = {};

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (rest.body) headers.set('Content-Type', 'application/json');
  return app.request(path, { ...rest, headers });
};
const post = (path: string, body: unknown, token?: string) => call(path, { method: 'POST', body: JSON.stringify(body), token });
const put = (path: string, body: unknown, token?: string) => call(path, { method: 'PUT', body: JSON.stringify(body), token });

beforeAll(async () => {
  hub = new Hub();
  await hub.addUser('admin', 'adminpass1', 'admin', 'Admin');
  await hub.addUser('analyst', 'analystpass1', 'analyst', 'Analyst');
  await hub.addUser('operator', 'operatorpass1', 'operator', 'Operator');
  app = createApp({ hub, jwtSecret: SECRET });
  for (const [u, p] of [['admin', 'adminpass1'], ['analyst', 'analystpass1'], ['operator', 'operatorpass1']] as const) {
    const res = await post('/api/auth/login', { username: u, password: p });
    tokens[u] = ((await res.json()) as { token: string }).token;
  }
  hub.ingest({ mmsi: '636000001', name: 'MV Intruder', lat: 13, lon: 48, sog: 12, shipType: 70, ts: 1000 }, 1000);
  hub.ingest({ mmsi: '419000001', name: 'MV Mine', lat: 15, lon: 72, sog: 10, shipType: 70, ts: 1000 }, 1000);
  hub.ingest({ mmsi: '419000001', name: 'MV Mine', lat: 15, lon: 72.1, sog: 10, shipType: 70, ts: 2000 }, 2000);
});

describe('health and public endpoints', () => {
  it('GET /api/health returns 200 without auth', async () => {
    const res = await call('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('GET /api/public/zones exposes boundary data', async () => {
    const body = (await (await call('/api/public/zones')).json()) as { boundaries: unknown[]; highRisk: unknown[] };
    expect(body.boundaries.length).toBeGreaterThan(3);
    expect(body.highRisk.length).toBeGreaterThan(0);
  });

});

describe('authentication', () => {
  it('login returns a token and user for valid credentials', async () => {
    const res = await post('/api/auth/login', { username: 'Admin', password: 'adminpass1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { username: 'admin', role: 'admin' } });
  });

  it('login rejects wrong password with 401 and a generic message', async () => {
    const res = await post('/api/auth/login', { username: 'admin', password: 'bad' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid credentials' });
  });

  it('login rejects unknown users identically', async () => {
    expect((await post('/api/auth/login', { username: 'ghost', password: 'whatever1' })).status).toBe(401);
  });

  it('login rejects missing fields with 400', async () => {
    expect((await post('/api/auth/login', { username: 'admin' })).status).toBe(400);
  });

  it('protected routes require a valid token', async () => {
    expect((await call('/api/vessels')).status).toBe(401);
    expect((await call('/api/vessels', { token: 'garbage.token.value' })).status).toBe(401);
  });

  it('rate-limits repeated login attempts', async () => {
    const fresh = createApp({ hub, jwtSecret: SECRET });
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fresh.request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'x', password: 'y' }),
        headers: { 'Content-Type': 'application/json' },
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

describe('vessels and alerts', () => {
  it('GET /api/vessels returns tracked vessels for authenticated users', async () => {
    const res = await call('/api/vessels', { token: tokens.admin });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total: number }).total).toBe(2);
  });

  it('GET /api/vessels/:mmsi validates, finds and 404s', async () => {
    expect((await call('/api/vessels/abc', { token: tokens.admin })).status).toBe(400);
    expect((await call('/api/vessels/419000001', { token: tokens.admin })).status).toBe(200);
    expect((await call('/api/vessels/111111111', { token: tokens.admin })).status).toBe(404);
  });

  it('GET /api/alerts lists alerts and validates filters', async () => {
    const res = await call('/api/alerts?severity=high', { token: tokens.analyst });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total: number }).total).toBeGreaterThan(0);
    expect((await call('/api/alerts?severity=bogus', { token: tokens.analyst })).status).toBe(400);
  });

  it('operators only see alerts for vessels on their watchlist', async () => {
    const before = (await (await call('/api/alerts', { token: tokens.operator })).json()) as { total: number };
    expect(before.total).toBe(0);
    expect((await post('/api/watchlist', { mmsi: '636000001' }, tokens.operator)).status).toBe(201);
    const after = (await (await call('/api/alerts', { token: tokens.operator })).json()) as { total: number };
    expect(after.total).toBeGreaterThan(0);
  });

  it('acknowledges and resolves an alert, recording the actor', async () => {
    const list = (await (await call('/api/alerts', { token: tokens.analyst })).json()) as { alerts: Array<{ id: string }> };
    const id = list.alerts[0]!.id;
    const ack = await post(`/api/alerts/${id}/ack`, { note: 'looking' }, tokens.analyst);
    expect(ack.status).toBe(200);
    expect(await ack.json()).toMatchObject({ status: 'acknowledged', handledBy: 'analyst', note: 'looking' });
    expect(((await (await post(`/api/alerts/${id}/resolve`, {}, tokens.analyst)).json()) as { status: string }).status).toBe('resolved');
    expect((await post('/api/alerts/does-not-exist/ack', {}, tokens.analyst)).status).toBe(404);
  });

  it('exports alerts as CSV', async () => {
    const res = await call('/api/reports/alerts.csv', { token: tokens.analyst });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect((await res.text()).split('\n')[0]).toContain('severity');
  });
});

describe('watchlist, geofences, policy, audit', () => {
  it('POST /api/watchlist rejects invalid MMSI with 400', async () => {
    expect((await post('/api/watchlist', { mmsi: '12' }, tokens.operator)).status).toBe(400);
    expect((await post('/api/watchlist', {}, tokens.operator)).status).toBe(400);
  });

  it('removes watchlist entries', async () => {
    expect((await call('/api/watchlist/636000001', { method: 'DELETE', token: tokens.operator })).status).toBe(200);
    expect((await call('/api/watchlist/636000001', { method: 'DELETE', token: tokens.operator })).status).toBe(404);
  });

  it('geofence creation is restricted to analysts/admins and validated', async () => {
    const body = { name: 'Mumbai Port', lat: 18.9, lon: 72.8, radiusNm: 25 };
    expect((await post('/api/geofences', body, tokens.operator)).status).toBe(403);
    expect((await post('/api/geofences', { ...body, radiusNm: 9999 }, tokens.analyst)).status).toBe(400);
    const created = await post('/api/geofences', body, tokens.analyst);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await call(`/api/geofences/${id}`, { method: 'DELETE', token: tokens.analyst })).status).toBe(200);
    expect((await call(`/api/geofences/${id}`, { method: 'DELETE', token: tokens.analyst })).status).toBe(404);
  });

  it('only admins can change policy, and values are range-checked', async () => {
    expect((await put('/api/policy', { highSpeedKn: 30 }, tokens.analyst)).status).toBe(403);
    expect((await put('/api/policy', { highSpeedKn: 999 }, tokens.admin)).status).toBe(400);
    const ok = await put('/api/policy', { highSpeedKn: 30, flagsOfInterest: ['Somalia'] }, tokens.admin);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ highSpeedKn: 30, flagsOfInterest: ['Somalia'] });
  });

  it('audit log is admin-only and records actions', async () => {
    expect((await call('/api/audit', { token: tokens.analyst })).status).toBe(403);
    const res = await call('/api/audit', { token: tokens.admin });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { audit: unknown[] }).audit.length).toBeGreaterThan(0);
  });

  it('unknown routes return JSON 404 and security headers are set', async () => {
    const res = await call('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('incident reporting (route suspicious vessels to the nearest Coast Guard controller)', () => {
  it('lists stations for authenticated users only', async () => {
    expect((await call('/api/stations')).status).toBe(401);
    const res = await call('/api/stations', { token: tokens.operator });
    expect(((await res.json()) as { stations: unknown[] }).stations.length).toBeGreaterThan(10);
  });

  it('an operator reports a tracked vessel: it is routed to the nearest station, added to their set and alerted', async () => {
    const res = await post('/api/incidents', { mmsi: '419000001', category: 'suspicious_behaviour', note: 'Circling near the rig' }, tokens.operator);
    expect(res.status).toBe(201);
    const inc = (await res.json()) as { id: string; station: { id: string; desk: string }; status: string; manual: boolean };
    expect(typeof inc.station.id).toBe('string');
    expect(typeof inc.station.desk).toBe('string');
    expect(inc.status).toBe('open');
    expect(inc.manual).toBe(false);
    expect(hub.watchlistOf('operator')).toContain('419000001');
    expect(hub.alerts.some((a) => a.ruleId === 'user_report' && a.mmsi === '419000001')).toBe(true);
  });

  it('an unidentified boat can be added from a position, becomes a map contact and is routed by location', async () => {
    const res = await post('/api/incidents', { lat: 9.3, lon: 79.2, category: 'unidentified_vessel', note: 'Unlit boat, no AIS' }, tokens.operator);
    expect(res.status).toBe(201);
    const inc = (await res.json()) as { mmsi: string; manual: boolean; station: { id: string } };
    expect(inc.manual).toBe(true);
    expect(inc.station.id).toBe('mandapam');
    expect(hub.vessels.get(inc.mmsi)?.origin).toBe('reported');
  });

  it('validates input', async () => {
    expect((await post('/api/incidents', { category: 'bogus', mmsi: '419000001' }, tokens.operator)).status).toBe(400);
    expect((await post('/api/incidents', { category: 'other' }, tokens.operator)).status).toBe(400);
    expect((await post('/api/incidents', { category: 'other', mmsi: '12' }, tokens.operator)).status).toBe(400);
    expect((await post('/api/incidents', { category: 'other', mmsi: '111111111' }, tokens.operator)).status).toBe(404);
    expect((await post('/api/incidents', { category: 'other', lat: 95, lon: 10 }, tokens.operator)).status).toBe(400);
  });

  it('operators see only their own reports; analysts see all and can progress them; operators cannot', async () => {
    const mine = (await (await call('/api/incidents', { token: tokens.operator })).json()) as { incidents: Array<{ id: string }> };
    expect(mine.incidents.length).toBeGreaterThanOrEqual(2);
    await post('/api/incidents', { mmsi: '636000001', category: 'distress', note: 'x' }, tokens.analyst);
    const all = (await (await call('/api/incidents', { token: tokens.analyst })).json()) as { total: number };
    expect(all.total).toBeGreaterThan(mine.incidents.length);
    const id = mine.incidents[0]!.id;
    expect((await post(`/api/incidents/${id}/status`, { status: 'acknowledged' }, tokens.operator)).status).toBe(403);
    const ack = await post(`/api/incidents/${id}/status`, { status: 'acknowledged', note: 'unit dispatched' }, tokens.analyst);
    expect(ack.status).toBe(200);
    expect(await ack.json()).toMatchObject({ status: 'acknowledged' });
    expect((await post(`/api/incidents/${id}/status`, { status: 'bogus' }, tokens.analyst)).status).toBe(400);
    expect((await post('/api/incidents/nope/status', { status: 'closed' }, tokens.analyst)).status).toBe(404);
  });

  it('closing an incident about a manual contact removes the contact from the map', async () => {
    const inc = (await (await post('/api/incidents', { lat: 20, lon: 70, category: 'other', note: 'x' }, tokens.operator)).json()) as { id: string; mmsi: string };
    expect(hub.vessels.has(inc.mmsi)).toBe(true);
    await post(`/api/incidents/${inc.id}/status`, { status: 'closed' }, tokens.analyst);
    expect(hub.vessels.has(inc.mmsi)).toBe(false);
  });

  it('rate-limits report floods per user', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await post('/api/incidents', { mmsi: '419000001', category: 'other' }, tokens.admin)).status;
    expect(last).toBe(429);
  });

  it('analysts can switch the synthetic traffic feed; operators cannot', async () => {
    expect((await put('/api/feed/synthetic', { enabled: true }, tokens.operator)).status).toBe(403);
    expect((await put('/api/feed/synthetic', { enabled: 'yes' }, tokens.analyst)).status).toBe(400);
    expect((await put('/api/feed/synthetic', { enabled: true }, tokens.analyst)).status).toBe(200);
    expect(hub.feed.synthetic).toBe(true);
  });
});
