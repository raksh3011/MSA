/** Demo data: organisations, users, fleet registries and voyages in every workflow state. Idempotent. */
import { FLEET_NAME, FLEET_VESSELS, KT_FLEET_NAME, KT_FLEET_VESSELS } from '../core/simulator';
import { DESKS } from '../core/stations';
import type { Role } from '../core/types';
import type { Organization } from '../domain/types';
import type { Services } from './context';
import { projectEta } from '../domain/supplychain';
import { createShipment, sweepShipments } from './shipments';
import { actOnVoyage, createVoyage } from './voyages';

const DAY = 86_400_000;

/** Accounts created by the seed (a rotated SEED_PASSWORD applies to exactly these). */
export const SEED_USERNAMES: string[] = ['admin', 'analyst', ...DESKS.map((d) => `cg.${d.id}`), 'operator', 'riskofficer', 'orgadmin', 'kt.operator', 'kt.admin'];
const typeOf = (t: number): string => (t >= 80 ? 'tanker' : t >= 70 ? (t === 71 ? 'container' : 'cargo') : t >= 60 ? 'passenger' : 'other');

async function ensureUser(s: Services, username: string, password: string, role: Role, displayName: string, orgId: string, fleetName?: string, station?: string): Promise<void> {
  const existing = s.hub.users.get(username);
  if (existing) {
    existing.orgId = orgId;
    existing.fleetName = fleetName ?? existing.fleetName;
    if (role === 'operator' && existing.role !== 'operator') existing.role = role;
    return;
  }
  await s.hub.addUser(username, password, role, displayName, station, fleetName, orgId);
}

export async function seedDemo(s: Services, password: string): Promise<boolean> {
  if ((await s.repo.orgs.list()).length > 0) return false;
  const now = s.now();
  const org = (id: string, name: string, kind: Organization['kind'], planId: Organization['planId']): Organization => ({ id, name, kind, planId, status: 'active', createdAt: now - 90 * DAY });
  const platform = org('org-platform', 'ORVMS Platform Operations', 'platform', 'enterprise');
  const icg = org('org-icg', 'Indian Coast Guard (demo tenant)', 'coast_guard', 'enterprise');
  const boc = org('org-boc', FLEET_NAME, 'shipping_company', 'professional');
  const kt = org('org-kt', KT_FLEET_NAME, 'shipping_company', 'starter');
  for (const o of [platform, icg, boc, kt]) await s.repo.orgs.insert(o);

  // users (identity lives in the Hub); every user belongs to exactly one organisation
  await ensureUser(s, 'admin', password, 'admin', 'Platform Administrator', platform.id);
  await ensureUser(s, 'analyst', password, 'analyst', 'Maritime Analyst (Coast Guard)', icg.id);
  for (const d of DESKS) await ensureUser(s, `cg.${d.id}`, password, 'analyst', `CG Controller - ${d.name}`, icg.id, undefined, d.id);
  await ensureUser(s, 'operator', password, 'operator', 'Fleet Operator', boc.id, boc.name);
  await ensureUser(s, 'riskofficer', password, 'risk_officer', 'Risk Officer', boc.id, boc.name);
  await ensureUser(s, 'orgadmin', password, 'org_admin', 'Organisation Admin', boc.id, boc.name);
  await ensureUser(s, 'kt.operator', password, 'operator', 'Fleet Operator', kt.id, kt.name);
  await ensureUser(s, 'kt.admin', password, 'org_admin', 'Organisation Admin', kt.id, kt.name);

  // fleet registries (master data)
  await Promise.all([
    ...FLEET_VESSELS.map((f, i) =>
      s.repo.registry.upsert({ orgId: boc.id, mmsi: f.mmsi, imo: `94${String(1001 + i).padStart(5, '0')}`, name: f.name, vesselType: typeOf(f.type), flag: 'India', grossTonnage: 30_000 + i * 4_500, owner: boc.name, status: 'active', createdAt: now - 80 * DAY }),
    ),
    ...KT_FLEET_VESSELS.map((f, i) =>
      s.repo.registry.upsert({ orgId: kt.id, mmsi: f.mmsi, imo: `95${String(2001 + i).padStart(5, '0')}`, name: f.name, vesselType: typeOf(f.type), flag: 'India', grossTonnage: 45_000 + i * 6_000, owner: kt.name, status: 'active', createdAt: now - 60 * DAY }),
    ),
  ]);

  // voyages in every workflow state (created through the same service the API uses, so rules are exercised)
  const ops = { username: 'operator', role: 'operator' as Role };
  const risk = { username: 'riskofficer', role: 'risk_officer' as Role };
  const admin = { username: 'orgadmin', role: 'org_admin' as Role };
  const mk = async (mmsi: string, routeId: string, from: string, to: string, cargo: string, etdDays: number, durDays: number) => {
    const r = await createVoyage(s, boc, ops, { mmsi, routeId, originPort: from, destinationPort: to, cargo, etd: now + etdDays * DAY, eta: now + (etdDays + durDays) * DAY });
    if (!r.ok) throw new Error(`seed voyage failed: ${r.error}`);
    return r.value;
  };
  const approveAll = async (id: string): Promise<void> => {
    const sub = await actOnVoyage(s, boc, ops, id, 'submit', '');
    if (!sub.ok) throw new Error(sub.error);
    for (const need of sub.value.approvalsRequired) {
      const who = need === 'org_admin' ? admin : risk;
      const r = await actOnVoyage(s, boc, who, id, 'approve', 'Approved with BMP5 measures and charterer / insurer notified.');
      if (!r.ok) throw new Error(r.error);
    }
  };

  const active = await mk('419200101', 'aden-mumbai', 'YEADE', 'INBOM', 'crude_oil', -3, 6); // tanker out of the Gulf of Aden
  await approveAll(active.id);
  await actOnVoyage(s, boc, ops, active.id, 'start', 'Departed Aden');

  const offRoute = await mk('419200109', 'mumbai-fujairah', 'INBOM', 'AEFJR', 'general', -1, 4); // sails a different lane: deviation alert
  await approveAll(offRoute.id);
  await actOnVoyage(s, boc, ops, offRoute.id, 'start', 'Departed Mumbai');

  const pending = await mk('419200105', 'mumbai-aden', 'INBOM', 'YEADE', 'refined_products', 2, 18); // high risk: awaiting approval
  await actOnVoyage(s, boc, ops, pending.id, 'submit', '');

  const ready = await mk('419200103', 'mumbai-kochi', 'INBOM', 'INCOK', 'containers', 1, 3); // low risk: auto-approved
  await actOnVoyage(s, boc, ops, ready.id, 'submit', '');

  await mk('419200110', 'chittagong-colombo', 'BDCGP', 'LKCMB', 'containers', 5, 4); // draft

  const done = await mk('419200104', 'kolkata-chennai', 'INCCU', 'INMAA', 'bulk', -9, 3);
  await actOnVoyage(s, boc, ops, done.id, 'submit', '');
  await actOnVoyage(s, boc, ops, done.id, 'start', 'Sailed');
  await actOnVoyage(s, boc, ops, done.id, 'complete', 'Arrived Chennai');

  // supply chain: customer shipments allocated to those voyages. Commitments are set relative to each voyage's projected ETA
  // so every delivery-risk state (on track / at risk / late / unplanned / delivered) is visible in the demo.
  const etaOf = async (voyageId: string): Promise<number> => {
    const v = await s.repo.voyages.get(boc.id, voyageId);
    return v ? projectEta(v, s.hub.vessels.get(v.mmsi), now).eta : now + DAY;
  };
  const ship = async (reference: string, customer: string, commodity: string, cargo: string, qty: number, unit: string, valueInr: number, incoterm: string, from: string, to: string, voyageId: string | undefined, requiredBy: number) => {
    const r = await createShipment(s, boc, 'operator', { reference, customer, commodity, cargo, quantity: qty, unit, valueInr, incoterm, originPort: from, destinationPort: to, voyageId, requiredBy });
    if (!r.ok) throw new Error(`seed shipment failed: ${r.error}`);
    return r.value;
  };
  const H = 3_600_000;
  await ship('PO-2026-1187', 'Western Refineries Ltd', 'Arabian light crude', 'crude_oil', 95_000, 'MT', 4_900_000_000, 'CIF', 'YEADE', 'INBOM', active.id, (await etaOf(active.id)) + 10 * H);
  await ship('PO-2026-1203', 'Gulf Retail Trading LLC', 'Polymer granules', 'general', 4_200, 'MT', 520_000_000, 'FOB', 'INBOM', 'AEFJR', offRoute.id, (await etaOf(offRoute.id)) - 6 * H);
  await ship('PO-2026-1215', 'Gulf Petro Trading', 'Refined diesel', 'refined_products', 60_000, 'MT', 3_300_000_000, 'CFR', 'INBOM', 'YEADE', pending.id, (await etaOf(pending.id)) + 30 * H);
  await ship('PO-2026-1220', 'Malabar Foods Exports', 'Spices (containerised)', 'containers', 310, 'TEU', 210_000_000, 'FOB', 'INBOM', 'INCOK', ready.id, (await etaOf(ready.id)) + 5 * 24 * H);
  await ship('PO-2026-1244', 'Eastern Steel Works', 'Steel coils', 'containers', 180, 'TEU', 390_000_000, 'DAP', 'BDCGP', 'LKCMB', undefined, now + 9 * DAY);
  // historical shipment on the already-completed voyage (the API refuses new allocations to a completed voyage)
  const past = await ship('PO-2026-1102', 'Eastern Steel Works', 'Iron ore fines', 'bulk', 38_000, 'MT', 260_000_000, 'FOB', 'INCCU', 'INMAA', undefined, now - 5 * DAY);
  await s.repo.shipments.update({ ...past, voyageId: done.id, history: [...past.history, { ts: now, actor: 'operator', action: 'allocated', note: done.reference }] });
  await createShipment(s, kt, 'kt.operator', { reference: 'KT-PO-501', customer: 'Konkan Refinery', commodity: 'Fuel oil', cargo: 'refined_products', quantity: 40_000, unit: 'MT', valueInr: 1_900_000_000, incoterm: 'CIF', originPort: 'INBOM', destinationPort: 'INMUN', requiredBy: now + 6 * DAY });
  await sweepShipments(s); // settle statuses (in transit / delivered) and delivery risk from the voyages
  return true;
}
