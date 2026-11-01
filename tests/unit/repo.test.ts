import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRepo } from '../../src/data/memory';
import type { Repo } from '../../src/data/repo';
import { MIGRATIONS } from '../../src/data/migrations';
import { SqlRepo, migrate } from '../../src/data/sql';
import type { ApiKey, CaseRecord, Delivery, Organization, RegistryVessel, Shipment, Voyage, Webhook } from '../../src/domain/types';
import { createSqliteDb } from '../helpers/sqlite';

const org = (id: string, over: Partial<Organization> = {}): Organization => ({ id, name: `Org ${id}`, kind: 'shipping_company', planId: 'starter', status: 'active', createdAt: 1000, ...over });
const vessel = (orgId: string, mmsi: string, over: Partial<RegistryVessel> = {}): RegistryVessel => ({ orgId, mmsi, name: `V${mmsi}`, vesselType: 'cargo', flag: 'India', status: 'active', createdAt: 1, ...over });
const voyage = (orgId: string, id: string, over: Partial<Voyage> = {}): Voyage => ({
  id, orgId, reference: `VY-${id}`, mmsi: '419200101', vesselName: 'BOC X', originPort: 'INBOM', destinationPort: 'YEADE', waypoints: [[18, 71], [12, 45]], etd: 1000, eta: 9_000_000,
  cargo: 'general', status: 'draft', approvalsRequired: [], approvals: [], history: [], createdBy: 'u1', createdAt: 5000, updatedAt: 5000, ...over,
});
const kase = (id: string, orgId: string, over: Partial<CaseRecord> = {}): CaseRecord => ({
  id, orgId, reporter: 'u1', reporterRole: 'operator', mmsi: '419200101', vesselName: 'BOC X', lat: 10, lon: 75, category: 'other', note: 'n', status: 'open', priority: 'P4',
  station: { id: 'kochi', name: 'ICG Kochi', distanceNm: 40, desk: 'kochi' }, manual: false, createdAt: 1000, ackDueAt: 2000, resolveDueAt: 3000, escalationLevel: 0, slaBreached: false, history: [], ...over,
});

/** The same contract is run against both implementations, so the in-memory demo and the SQL database behave identically. */
const impls: Array<[string, () => Promise<Repo>]> = [
  ['MemoryRepo', async () => new MemoryRepo()],
  ['SqlRepo (SQLite)', async () => {
    const db = createSqliteDb();
    await migrate(db);
    return new SqlRepo(db);
  }],
];

describe.each(impls)('Repo contract: %s', (_name, make) => {
  let repo: Repo;
  beforeEach(async () => {
    repo = await make();
    await repo.orgs.insert(org('a'));
    await repo.orgs.insert(org('b'));
  });

  it('organisations: insert, get, update, list', async () => {
    expect((await repo.orgs.get('a'))?.planId).toBe('starter');
    await repo.orgs.update(org('a', { planId: 'professional', name: 'Renamed' }));
    expect(await repo.orgs.get('a')).toMatchObject({ planId: 'professional', name: 'Renamed' });
    expect((await repo.orgs.list()).map((o) => o.id).sort()).toEqual(['a', 'b']);
    expect(await repo.orgs.get('zzz')).toBeUndefined();
  });

  it('registry: tenant-scoped, upsert replaces, counts only active vessels', async () => {
    await repo.registry.upsert(vessel('a', '419000001'));
    await repo.registry.upsert(vessel('a', '419000002', { status: 'retired' }));
    await repo.registry.upsert(vessel('b', '419000001', { name: 'Other tenant' }));
    await repo.registry.upsert(vessel('a', '419000001', { name: 'Renamed', imo: '9999999' }));
    expect((await repo.registry.list('a')).map((v) => v.name).sort()).toEqual(['Renamed', 'V419000002']);
    expect((await repo.registry.get('b', '419000001'))?.name).toBe('Other tenant');
    expect((await repo.registry.get('a', '419000001'))?.imo).toBe('9999999');
    expect(await repo.registry.count('a')).toBe(1);
    expect(await repo.registry.remove('a', '419000001')).toBe(true);
    expect(await repo.registry.remove('a', '419000001')).toBe(false);
  });

  it('voyages: org isolation, status filter, JSON fields round-trip, active listing, monthly count', async () => {
    const v = voyage('a', 'v1', { assessment: { score: 40, level: 'medium', factors: [{ code: 'hra', label: 'x', points: 40, detail: 'd' }], controls: ['c'], exposure: { totalNm: 1, highRiskNm: 1, elevatedRiskNm: 0, foreignWatersNm: 0, zones: ['Gulf of Aden'] }, assessedAt: 1 } });
    await repo.voyages.insert(v);
    await repo.voyages.insert(voyage('b', 'v2', { status: 'active' }));
    expect(await repo.voyages.get('b', 'v1')).toBeUndefined(); // cross-tenant read is impossible
    expect((await repo.voyages.get('a', 'v1'))?.assessment?.factors[0]?.code).toBe('hra');
    expect((await repo.voyages.get('a', 'v1'))?.waypoints).toEqual([[18, 71], [12, 45]]);
    await repo.voyages.update({ ...v, status: 'approved', approvals: [{ role: 'risk_officer', userId: 'u2', decision: 'approved', note: 'ok', ts: 7 }], history: [{ ts: 7, actor: 'u2', action: 'approved' }], updatedAt: 9000 });
    expect((await repo.voyages.list('a', 'approved')).length).toBe(1);
    expect((await repo.voyages.list('a', 'draft')).length).toBe(0);
    expect((await repo.voyages.get('a', 'v1'))?.approvals[0]?.userId).toBe('u2');
    expect((await repo.voyages.listActive()).map((x) => x.id)).toEqual(['v2']);
    expect(await repo.voyages.countCreatedBetween('a', 0, 10_000)).toBe(1);
    expect(await repo.voyages.countCreatedBetween('a', 6000, 10_000)).toBe(0);
  });

  it('shipments: tenant-scoped CRUD, open listing, voyage link round-trips', async () => {
    await repo.voyages.insert(voyage('a', 'v9'));
    const base: Shipment = {
      id: 's1', orgId: 'a', reference: 'PO-1', customer: 'C', commodity: 'Crude', cargo: 'crude_oil', quantity: 10, unit: 'MT', valueInr: 1_000_000, incoterm: 'CIF', originPort: 'INBOM',
      destinationPort: 'YEADE', requiredBy: 9000, status: 'booked', deliveryRisk: 'unplanned', createdBy: 'u1', createdAt: 1, updatedAt: 1, history: [{ ts: 1, actor: 'u1', action: 'booked' }],
    };
    await repo.shipments.insert(base);
    await repo.shipments.insert({ ...base, id: 's2', orgId: 'b', reference: 'PO-2' });
    expect((await repo.shipments.list('a')).map((x) => x.id)).toEqual(['s1']);
    expect(await repo.shipments.get('b', 's1')).toBeUndefined();
    await repo.shipments.update({ ...base, voyageId: 'v9', status: 'in_transit', deliveryRisk: 'at_risk', updatedAt: 5, history: [...base.history, { ts: 5, actor: 'system', action: 'in_transit' }] });
    expect(await repo.shipments.get('a', 's1')).toMatchObject({ voyageId: 'v9', status: 'in_transit', deliveryRisk: 'at_risk' });
    expect((await repo.shipments.listOpen()).length).toBe(2);
    await repo.shipments.update({ ...base, status: 'delivered' });
    expect((await repo.shipments.listOpen()).map((x) => x.id)).toEqual(['s2']);
  });

  it('cases: filters, update persists SLA/escalation state, open listing', async () => {
    await repo.cases.insert(kase('c1', 'a'));
    await repo.cases.insert(kase('c2', 'b', { station: { id: 'goa', name: 'ICG Goa', distanceNm: 5, desk: 'mumbai' } }));
    expect((await repo.cases.list({ orgId: 'a' })).map((c) => c.id)).toEqual(['c1']);
    expect((await repo.cases.list({ desk: 'mumbai' })).map((c) => c.id)).toEqual(['c2']);
    const c = (await repo.cases.get('c1'))!;
    await repo.cases.update({ ...c, status: 'closed', assignee: 'cg.kochi', closureCode: 'false_alarm', closedAt: 4000, escalationLevel: 2, slaBreached: true, history: [{ ts: 1, actor: 'x', action: 'closed' }] });
    expect(await repo.cases.get('c1')).toMatchObject({ status: 'closed', assignee: 'cg.kochi', closureCode: 'false_alarm', escalationLevel: 2, slaBreached: true });
    expect((await repo.cases.listOpen()).map((x) => x.id)).toEqual(['c2']);
    expect((await repo.cases.list({ status: 'closed' })).length).toBe(1);
  });

  it('API keys: lookup by hash, revoke is tenant-scoped, revoked keys no longer authenticate', async () => {
    const k: ApiKey = { id: 'k1', orgId: 'a', name: 'erp', prefix: 'orvms_ab', hash: 'h1', scopes: ['read:fleet'], createdBy: 'u1', createdAt: 1 };
    await repo.apiKeys.insert(k);
    expect((await repo.apiKeys.findByHash('h1'))?.scopes).toEqual(['read:fleet']);
    expect(await repo.apiKeys.revoke('b', 'k1', 5)).toBe(false);
    await repo.apiKeys.touch('k1', 9);
    expect((await repo.apiKeys.list('a'))[0]?.lastUsedAt).toBe(9);
    expect(await repo.apiKeys.revoke('a', 'k1', 10)).toBe(true);
    expect(await repo.apiKeys.findByHash('h1')).toBeUndefined();
  });

  it('webhooks and deliveries: scoped CRUD and delivery history', async () => {
    const w: Webhook = { id: 'w1', orgId: 'a', url: 'https://example.com/h', secret: 's', events: ['case.created'], active: true, createdAt: 1 };
    await repo.webhooks.insert(w);
    expect((await repo.webhooks.list('a')).length).toBe(1);
    expect(await repo.webhooks.get('b', 'w1')).toBeUndefined();
    const d: Delivery = { id: 'd1', orgId: 'a', webhookId: 'w1', event: 'case.created', payload: '{}', status: 'pending', attempts: 0, createdAt: 5 };
    await repo.deliveries.insert(d);
    await repo.deliveries.update({ ...d, status: 'delivered', attempts: 1, responseStatus: 200, deliveredAt: 6 });
    expect((await repo.deliveries.list('a', 10))[0]).toMatchObject({ status: 'delivered', responseStatus: 200 });
    expect(await repo.webhooks.remove('b', 'w1')).toBe(false);
    expect(await repo.webhooks.remove('a', 'w1')).toBe(true);
  });

  it('usage counters accumulate per organisation, period and metric', async () => {
    expect(await repo.usage.increment('a', '2026-10', 'voyages')).toBe(1);
    expect(await repo.usage.increment('a', '2026-10', 'voyages', 2)).toBe(3);
    expect(await repo.usage.increment('a', '2026-11', 'voyages')).toBe(1);
    expect(await repo.usage.get('a', '2026-10', 'voyages')).toBe(3);
    expect(await repo.usage.get('b', '2026-10', 'voyages')).toBe(0);
    expect(await repo.usage.get('a', '2026-10', 'api_calls')).toBe(0);
  });
});

describe('SQL migrations', () => {
  it('are idempotent and enforce referential integrity / checks', async () => {
    const db = createSqliteDb();
    expect(await migrate(db)).toBe(MIGRATIONS.length);
    expect(await migrate(db)).toBe(0);
    const repo = new SqlRepo(db);
    await expect(repo.orgs.insert(org('x', { kind: 'bogus' as never }))).rejects.toThrow();
  });
});
