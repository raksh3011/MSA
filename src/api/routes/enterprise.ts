/** Enterprise routes: catalog, organisation admin, registry, voyages, cases, API keys, webhooks, integration API. */
import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { TokenClaims } from '../../core/auth';
import { isValidCoord } from '../../core/geo';
import type { IncidentCategory, Role } from '../../core/types';
import { PLANS } from '../../domain/plans';
import { PORTS, ROUTE_TEMPLATES } from '../../domain/ports';
import type { Organization } from '../../domain/types';
import type { VoyageAction } from '../../domain/voyage';
import { CLOSURE_CODES, assignCase, openCase, progressCase, visibleCases } from '../../services/cases';
import type { Services } from '../../services/context';
import {
  WEBHOOK_EVENTS, authenticateApiKey, createApiKey, createOrgUser, createOrganization, createWebhook, fleetMmsis, orgIdOf, upsertRegistryVessel, usageSummary, usersOfOrg,
} from '../../services/org';
import { INCOTERMS, controlTower, createShipment, shipmentAction, updateShipment } from '../../services/shipments';
import { CARGO_TYPES, actOnVoyage, createVoyage, previewAssessment, updateVoyage } from '../../services/voyages';

type Env = { Variables: { claims: TokenClaims } };

export interface Kit {
  s: Services;
  requireAuth: (...roles: Role[]) => MiddlewareHandler<Env>;
  readJson: (c: Context) => Promise<Record<string, unknown> | null>;
  reportLimiter: { allow(key: string, now: number): boolean };
}

const INCIDENT_CATEGORIES = new Set<IncidentCategory>(['suspicious_behaviour', 'unidentified_vessel', 'ais_spoofing', 'illegal_activity', 'distress', 'other']);
const VOYAGE_ACTIONS = new Set<VoyageAction>(['submit', 'approve', 'reject', 'request_changes', 'start', 'complete', 'cancel']);
const CASE_STATUSES = new Set(['acknowledged', 'investigating', 'closed']);
const COMPANY: Role[] = ['operator', 'risk_officer', 'org_admin'];

type ErrStatus = 400 | 402 | 403 | 404 | 409;

export function registerEnterpriseRoutes(app: Hono<Env>, kit: Kit): void {
  const { s, requireAuth, readJson } = kit;

  /** The caller's organisation (company roles) — every tenant query goes through this. */
  const myOrg = async (c: Context<Env>): Promise<Organization | undefined> => {
    const id = orgIdOf(s, c.get('claims').sub);
    return id ? s.repo.orgs.get(id) : undefined;
  };
  const noOrg = (c: Context<Env>) => c.json({ error: 'Your account is not linked to an organisation' }, 403);
  const fail = (c: Context<Env>, status: ErrStatus, error: string) => c.json({ error }, status);

  // ── catalog (reference data) ───────────────────────────────────────────────
  app.get('/api/catalog', requireAuth(), (c) =>
    c.json({
      ports: PORTS,
      routes: ROUTE_TEMPLATES,
      plans: Object.values(PLANS),
      cargoTypes: CARGO_TYPES,
      incoterms: INCOTERMS,
      closureCodes: CLOSURE_CODES,
      webhookEvents: WEBHOOK_EVENTS,
    }),
  );

  // ── organisation (tenant) ──────────────────────────────────────────────────
  app.get('/api/org', requireAuth(...COMPANY), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const summary = await usageSummary(s, org);
    const users = c.get('claims').role === 'org_admin' ? usersOfOrg(s, org.id) : undefined;
    return c.json({ ...summary, users });
  });

  app.get('/api/org/users', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    return org ? c.json({ users: usersOfOrg(s, org.id) }) : noOrg(c);
  });

  app.post('/api/org/users', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const r = await createOrgUser(s, org, (await readJson(c)) ?? {});
    if (!r.ok) return fail(c, r.status, r.error);
    s.hub.log(c.get('claims').sub, 'user.created', `${org.id} ${r.value.username} (${r.value.role})`);
    return c.json(r.value, 201);
  });

  // ── fleet registry (master data) ───────────────────────────────────────────
  app.get('/api/registry/vessels', requireAuth(...COMPANY), async (c) => {
    const org = await myOrg(c);
    return org ? c.json({ vessels: await s.repo.registry.list(org.id) }) : noOrg(c);
  });

  app.post('/api/registry/vessels', requireAuth('operator', 'org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const r = await upsertRegistryVessel(s, org, (await readJson(c)) ?? {});
    if (!r.ok) return fail(c, r.status, r.error);
    s.hub.log(c.get('claims').sub, 'registry.upsert', `${org.id} ${r.value.mmsi}`);
    return c.json(r.value, 201);
  });

  app.delete('/api/registry/vessels/:mmsi', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const v = await s.repo.registry.get(org.id, c.req.param('mmsi'));
    if (!v) return fail(c, 404, 'Vessel not in registry');
    await s.repo.registry.upsert({ ...v, status: 'retired' }); // soft delete keeps voyage history intact
    s.hub.log(c.get('claims').sub, 'registry.retire', `${org.id} ${v.mmsi}`);
    return c.json({ retired: true });
  });

  /** CSV import: `mmsi,imo,name,type,flag,grossTonnage` (header optional). Valid rows are imported, bad rows reported. */
  app.post('/api/registry/import', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const csv = (await readJson(c))?.csv;
    if (typeof csv !== 'string' || csv.length > 200_000) return fail(c, 400, 'csv (text, up to 200 KB) is required');
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines[0] && /^mmsi/i.test(lines[0])) lines.shift();
    if (lines.length > 500) return fail(c, 400, 'At most 500 rows per import');
    let imported = 0;
    const errors: Array<{ row: number; error: string }> = [];
    for (const [i, line] of lines.entries()) {
      const [mmsi, imo, name, type, flag, gt] = line.split(',').map((x) => x.trim());
      const r = await upsertRegistryVessel(s, org, { mmsi, imo: imo || undefined, name, vesselType: type || 'cargo', flag: flag || 'India', grossTonnage: gt ? Number(gt) : undefined });
      if (r.ok) imported++;
      else errors.push({ row: i + 1, error: r.error });
    }
    s.hub.log(c.get('claims').sub, 'registry.import', `${org.id} ${imported} imported, ${errors.length} rejected`);
    return c.json({ imported, errors });
  });

  // ── voyages ────────────────────────────────────────────────────────────────
  app.get('/api/voyages', requireAuth(...COMPANY), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const status = c.req.query('status');
    return c.json({ voyages: await s.repo.voyages.list(org.id, status ? (status as never) : undefined) });
  });

  app.post('/api/voyages/assess', requireAuth(...COMPANY), async (c) => {
    const r = previewAssessment(s, (await readJson(c)) ?? {});
    return r.ok ? c.json(r.value) : fail(c, r.status, r.error);
  });

  app.post('/api/voyages', requireAuth(...COMPANY), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const claims = c.get('claims');
    const r = await createVoyage(s, org, { username: claims.sub, role: claims.role }, (await readJson(c)) ?? {});
    return r.ok ? c.json(r.value, 201) : fail(c, r.status, r.error);
  });

  app.get('/api/voyages/:id', requireAuth(...COMPANY), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const v = await s.repo.voyages.get(org.id, c.req.param('id'));
    return v ? c.json(v) : fail(c, 404, 'Voyage not found');
  });

  app.put('/api/voyages/:id', requireAuth(...COMPANY), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const r = await updateVoyage(s, org.id, c.get('claims').sub, c.req.param('id'), (await readJson(c)) ?? {});
    return r.ok ? c.json(r.value) : fail(c, r.status, r.error);
  });

  app.post('/api/voyages/:id/actions', requireAuth(...COMPANY), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const body = await readJson(c);
    const action = body?.action;
    const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : '';
    if (typeof action !== 'string' || !VOYAGE_ACTIONS.has(action as VoyageAction)) return fail(c, 400, `action must be one of: ${[...VOYAGE_ACTIONS].join(', ')}`);
    const claims = c.get('claims');
    const r = await actOnVoyage(s, org, { username: claims.sub, role: claims.role }, c.req.param('id'), action as VoyageAction, note);
    return r.ok ? c.json(r.value) : fail(c, r.status, r.error);
  });

  // ── supply chain: shipments and the control tower ──────────────────────────
  app.get('/api/supply-chain/overview', requireAuth(...COMPANY), async (c) => {
    const org = await myOrg(c);
    return org ? c.json(await controlTower(s, org.id)) : noOrg(c);
  });

  app.post('/api/shipments', requireAuth('operator', 'risk_officer', 'org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const r = await createShipment(s, org, c.get('claims').sub, (await readJson(c)) ?? {});
    return r.ok ? c.json(r.value, 201) : fail(c, r.status, r.error);
  });

  app.put('/api/shipments/:id', requireAuth('operator', 'risk_officer', 'org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const r = await updateShipment(s, org, c.get('claims').sub, c.req.param('id'), (await readJson(c)) ?? {});
    return r.ok ? c.json(r.value) : fail(c, r.status, r.error);
  });

  app.post('/api/shipments/:id/actions', requireAuth('operator', 'risk_officer', 'org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const body = await readJson(c);
    if (body?.action !== 'deliver' && body?.action !== 'cancel') return fail(c, 400, 'action must be deliver or cancel');
    const r = await shipmentAction(s, org, c.get('claims').sub, c.req.param('id'), body.action, typeof body.note === 'string' ? body.note.slice(0, 300) : '');
    return r.ok ? c.json(r.value) : fail(c, r.status, r.error);
  });

  // ── cases (suspicious-vessel reports worked against an SLA) ────────────────
  app.post('/api/cases', requireAuth(), async (c) => {
    const claims = c.get('claims');
    if (!kit.reportLimiter.allow(claims.sub, s.now())) return c.json({ error: 'Too many reports. Try again in a minute.' }, 429);
    const body = await readJson(c);
    const category = body?.category;
    const note = typeof body?.note === 'string' ? body.note.trim() : '';
    const mmsi = body?.mmsi;
    const lat = body?.lat;
    const lon = body?.lon;
    if (typeof category !== 'string' || !INCIDENT_CATEGORIES.has(category as IncidentCategory)) return fail(c, 400, 'Invalid category');
    if (note.length > 500) return fail(c, 400, 'note must be at most 500 characters');
    if (mmsi !== undefined && (typeof mmsi !== 'string' || !/^\d{9}$/.test(mmsi))) return fail(c, 400, 'mmsi must be a 9-digit string');
    if (mmsi === undefined && (typeof lat !== 'number' || typeof lon !== 'number' || !isValidCoord(lat, lon))) return fail(c, 400, 'Provide an mmsi, or a valid lat and lon for an unidentified contact');
    const r = await openCase(s, { username: claims.sub, role: claims.role, orgId: orgIdOf(s, claims.sub) ?? 'none' }, { category: category as IncidentCategory, note, mmsi: mmsi as string | undefined, lat: lat as number | undefined, lon: lon as number | undefined });
    return r.ok ? c.json(r.value, 201) : fail(c, r.status, r.error);
  });

  app.get('/api/cases', requireAuth(), async (c) => {
    const claims = c.get('claims');
    const status = c.req.query('status');
    const desk = c.req.query('desk');
    if (status && !['open', 'acknowledged', 'investigating', 'closed'].includes(status)) return fail(c, 400, 'Invalid status');
    const list = await visibleCases(s, { role: claims.role, orgId: orgIdOf(s, claims.sub) }, { status: status as never, desk: desk || undefined });
    return c.json({ cases: list.slice(0, 200), total: list.length });
  });

  app.post('/api/cases/:id/assign', requireAuth('analyst', 'admin'), async (c) => {
    const assignee = (await readJson(c))?.assignee;
    if (typeof assignee !== 'string') return fail(c, 400, 'assignee is required');
    const r = await assignCase(s, c.get('claims').sub, c.req.param('id'), assignee);
    return r.ok ? c.json(r.value) : fail(c, r.status, r.error);
  });

  app.post('/api/cases/:id/status', requireAuth('analyst', 'admin'), async (c) => {
    const body = await readJson(c);
    const status = body?.status;
    if (typeof status !== 'string' || !CASE_STATUSES.has(status)) return fail(c, 400, 'status must be acknowledged, investigating or closed');
    const r = await progressCase(s, c.get('claims').sub, c.req.param('id'), status as 'acknowledged' | 'investigating' | 'closed', typeof body?.note === 'string' ? body.note : '', typeof body?.closureCode === 'string' ? body.closureCode : undefined);
    return r.ok ? c.json(r.value) : fail(c, r.status, r.error);
  });

  app.get('/api/controllers', requireAuth('analyst', 'admin'), (c) =>
    c.json({ controllers: [...s.hub.users.values()].filter((u) => u.role === 'analyst').map((u) => ({ username: u.username, displayName: u.displayName, desk: u.station })) }),
  );

  // ── API keys & webhooks (org admin) ────────────────────────────────────────
  app.get('/api/org/api-keys', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    return c.json({ keys: (await s.repo.apiKeys.list(org.id)).map(({ hash: _h, ...k }) => k) });
  });

  app.post('/api/org/api-keys', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const r = await createApiKey(s, org, c.get('claims').sub, (await readJson(c)) ?? {});
    if (!r.ok) return fail(c, r.status, r.error);
    const { hash: _h, ...safe } = r.value.key;
    return c.json({ key: safe, secret: r.value.secret, note: 'Store this secret now: it is shown only once.' }, 201);
  });

  app.delete('/api/org/api-keys/:id', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const ok = await s.repo.apiKeys.revoke(org.id, c.req.param('id'), s.now());
    if (ok) s.hub.log(c.get('claims').sub, 'apikey.revoked', `${org.id} ${c.req.param('id')}`);
    return ok ? c.json({ revoked: true }) : fail(c, 404, 'API key not found');
  });

  app.get('/api/org/webhooks', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    return org ? c.json({ webhooks: await s.repo.webhooks.list(org.id) }) : noOrg(c);
  });

  app.post('/api/org/webhooks', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const r = await createWebhook(s, org, c.get('claims').sub, (await readJson(c)) ?? {});
    return r.ok ? c.json({ ...r.value, note: 'Use the secret to verify the X-ORVMS-Signature header.' }, 201) : fail(c, r.status, r.error);
  });

  app.delete('/api/org/webhooks/:id', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    if (!org) return noOrg(c);
    const ok = await s.repo.webhooks.remove(org.id, c.req.param('id'));
    return ok ? c.json({ removed: true }) : fail(c, 404, 'Webhook not found');
  });

  app.get('/api/org/deliveries', requireAuth('org_admin'), async (c) => {
    const org = await myOrg(c);
    return org ? c.json({ deliveries: (await s.repo.deliveries.list(org.id, 50)).map(({ payload: _p, ...d }) => d) }) : noOrg(c);
  });

  // ── platform administration ────────────────────────────────────────────────
  app.get('/api/admin/orgs', requireAuth('admin'), async (c) => {
    const orgs = await s.repo.orgs.list();
    const rows = await Promise.all(orgs.map(async (o) => ({ ...o, vessels: await s.repo.registry.count(o.id), users: usersOfOrg(s, o.id).length })));
    return c.json({ organizations: rows });
  });

  app.post('/api/admin/orgs', requireAuth('admin'), async (c) => {
    const r = await createOrganization(s, c.get('claims').sub, (await readJson(c)) ?? {});
    return r.ok ? c.json(r.value, 201) : fail(c, r.status, r.error);
  });

  app.put('/api/admin/orgs/:id', requireAuth('admin'), async (c) => {
    const org = await s.repo.orgs.get(c.req.param('id'));
    if (!org) return fail(c, 404, 'Organisation not found');
    const body = await readJson(c);
    const next: Organization = { ...org };
    if (body?.planId !== undefined) {
      if (typeof body.planId !== 'string' || !(body.planId in PLANS)) return fail(c, 400, 'Unknown plan');
      next.planId = body.planId as Organization['planId'];
    }
    if (body?.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'suspended') return fail(c, 400, 'status must be active or suspended');
      next.status = body.status;
    }
    await s.repo.orgs.update(next);
    s.hub.log(c.get('claims').sub, 'org.updated', `${org.id} plan=${next.planId} status=${next.status}`);
    return c.json(next);
  });

  // ── integration API (API-key authenticated, read-mostly) ───────────────────
  const withKey = (scope: 'read:fleet' | 'read:alerts' | 'read:voyages' | 'write:voyages' | 'read:shipments', handler: (c: Context<Env>, org: Organization) => Promise<Response>) =>
    async (c: Context<Env>): Promise<Response> => {
      const raw = c.req.header('X-API-Key') ?? '';
      const auth = await authenticateApiKey(s, raw);
      if (!auth.ok) return c.json({ error: auth.error }, auth.status);
      if (!auth.value.key.scopes.includes(scope)) return c.json({ error: `API key lacks the ${scope} scope` }, 403);
      return handler(c, auth.value.org);
    };

  app.get('/api/integration/v1/fleet', withKey('read:fleet', async (c, org) => {
    const vessels = await s.repo.registry.list(org.id);
    return c.json({ vessels: vessels.map((v) => ({ ...v, live: s.hub.vessels.get(v.mmsi) ? { lat: s.hub.vessels.get(v.mmsi)?.lat, lon: s.hub.vessels.get(v.mmsi)?.lon, sog: s.hub.vessels.get(v.mmsi)?.sog, lastSeen: s.hub.vessels.get(v.mmsi)?.lastSeen } : null })) });
  }));

  app.get('/api/integration/v1/alerts', withKey('read:alerts', async (c, org) => {
    const fleet = await fleetMmsis(s, org.id);
    return c.json({ alerts: s.hub.alerts.filter((a) => fleet.has(a.mmsi)).slice(0, 200) });
  }));

  app.get('/api/integration/v1/shipments', withKey('read:shipments', async (c, org) => c.json(await controlTower(s, org.id))));

  app.get('/api/integration/v1/voyages', withKey('read:voyages', async (c, org) => c.json({ voyages: await s.repo.voyages.list(org.id) })));

  app.post('/api/integration/v1/voyages', withKey('write:voyages', async (c, org) => {
    const r = await createVoyage(s, org, { username: 'api-integration', role: 'operator' }, (await readJson(c)) ?? {});
    return r.ok ? c.json(r.value, 201) : c.json({ error: r.error }, r.status);
  }));

}
