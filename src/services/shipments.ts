/** Supply-chain service: shipments (consignments), allocation to voyages, live delivery-risk control tower. */
import { portById } from '../domain/ports';
import { buildView, summarize, type ShipmentView, type SupplyChainSummary } from '../domain/supplychain';
import type { CargoType, DeliveryRisk, Organization, Shipment } from '../domain/types';
import { emit, type Services } from './context';
import type { Result } from './org';
import { CARGO_TYPES } from './voyages';

const bad = (error: string, status: 400 | 402 | 403 | 404 | 409 = 400): { ok: false; status: 400 | 402 | 403 | 404 | 409; error: string } => ({ ok: false, status, error });

export const INCOTERMS = ['EXW', 'FOB', 'CFR', 'CIF', 'DAP', 'DDP'];

export interface ShipmentInput {
  reference?: unknown;
  customer?: unknown;
  commodity?: unknown;
  cargo?: unknown;
  quantity?: unknown;
  unit?: unknown;
  valueInr?: unknown;
  incoterm?: unknown;
  originPort?: unknown;
  destinationPort?: unknown;
  requiredBy?: unknown;
  voyageId?: unknown;
}

const str = (v: unknown, min: number, max: number): string | undefined => (typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : undefined);

function parse(i: ShipmentInput): Omit<Shipment, 'id' | 'orgId' | 'status' | 'deliveryRisk' | 'createdBy' | 'createdAt' | 'updatedAt' | 'history'> | string {
  const reference = str(i.reference, 3, 40);
  if (!reference) return 'reference (3-40 characters) is required';
  const customer = str(i.customer, 2, 80);
  if (!customer) return 'customer (2-80 characters) is required';
  const commodity = str(i.commodity, 2, 80);
  if (!commodity) return 'commodity (2-80 characters) is required';
  if (typeof i.cargo !== 'string' || !CARGO_TYPES.includes(i.cargo as CargoType)) return `cargo must be one of: ${CARGO_TYPES.join(', ')}`;
  if (typeof i.quantity !== 'number' || !(i.quantity > 0) || i.quantity > 1e9) return 'quantity must be a positive number';
  const unit = str(i.unit, 1, 12);
  if (!unit) return 'unit is required (e.g. MT, TEU, m3)';
  if (typeof i.valueInr !== 'number' || i.valueInr < 0 || i.valueInr > 1e12) return 'valueInr must be between 0 and 1e12';
  if (typeof i.incoterm !== 'string' || !INCOTERMS.includes(i.incoterm)) return `incoterm must be one of: ${INCOTERMS.join(', ')}`;
  if (typeof i.originPort !== 'string' || !portById(i.originPort)) return 'originPort must be a known port id';
  if (typeof i.destinationPort !== 'string' || !portById(i.destinationPort)) return 'destinationPort must be a known port id';
  if (typeof i.requiredBy !== 'number' || !Number.isFinite(i.requiredBy)) return 'requiredBy (epoch ms) is required';
  return {
    reference, customer, commodity, cargo: i.cargo as CargoType, quantity: i.quantity, unit, valueInr: Math.round(i.valueInr), incoterm: i.incoterm,
    originPort: i.originPort, destinationPort: i.destinationPort, requiredBy: i.requiredBy, voyageId: typeof i.voyageId === 'string' && i.voyageId ? i.voyageId : undefined,
  };
}

async function checkVoyage(s: Services, orgId: string, voyageId: string | undefined): Promise<string | undefined> {
  if (!voyageId) return undefined;
  const v = await s.repo.voyages.get(orgId, voyageId);
  if (!v) return 'voyageId does not exist in your organisation';
  if (v.status === 'completed' || v.status === 'cancelled' || v.status === 'rejected') return `A ${v.status} voyage cannot carry new shipments`;
  return undefined;
}

export async function createShipment(s: Services, org: Organization, actor: string, input: ShipmentInput): Promise<Result<Shipment>> {
  const p = parse(input);
  if (typeof p === 'string') return bad(p);
  if ((await s.repo.shipments.list(org.id)).some((x) => x.reference.toLowerCase() === p.reference.toLowerCase() && x.status !== 'cancelled')) return bad('A shipment with this reference already exists', 409);
  const err = await checkVoyage(s, org.id, p.voyageId);
  if (err) return bad(err, 404);
  const now = s.now();
  const x: Shipment = { ...p, id: crypto.randomUUID(), orgId: org.id, status: 'booked', deliveryRisk: 'unplanned', createdBy: actor, createdAt: now, updatedAt: now, history: [{ ts: now, actor, action: 'booked' }] };
  if (p.voyageId) x.history.push({ ts: now, actor, action: 'allocated', note: p.voyageId });
  await s.repo.shipments.insert(x);
  s.hub.log(actor, 'shipment.created', `${org.id} ${x.reference}`);
  return { ok: true, value: x };
}

export async function updateShipment(s: Services, org: Organization, actor: string, id: string, input: ShipmentInput): Promise<Result<Shipment>> {
  const x = await s.repo.shipments.get(org.id, id);
  if (!x) return bad('Shipment not found', 404);
  if (x.status === 'delivered' || x.status === 'cancelled') return bad(`A ${x.status} shipment cannot be changed`, 409);
  const merged = parse({ ...x, ...input, voyageId: 'voyageId' in input ? input.voyageId : x.voyageId });
  if (typeof merged === 'string') return bad(merged);
  const err = await checkVoyage(s, org.id, merged.voyageId);
  if (err) return bad(err, 404);
  const now = s.now();
  const next: Shipment = { ...x, ...merged, updatedAt: now, history: [...x.history] };
  if (merged.voyageId !== x.voyageId) next.history.push({ ts: now, actor, action: merged.voyageId ? 'allocated' : 'deallocated', note: merged.voyageId });
  else next.history.push({ ts: now, actor, action: 'edited' });
  await s.repo.shipments.update(next);
  return { ok: true, value: next };
}

export async function shipmentAction(s: Services, org: Organization, actor: string, id: string, action: 'deliver' | 'cancel', note: string): Promise<Result<Shipment>> {
  const x = await s.repo.shipments.get(org.id, id);
  if (!x) return bad('Shipment not found', 404);
  if (x.status === 'delivered' || x.status === 'cancelled') return bad(`Shipment is already ${x.status}`, 409);
  const now = s.now();
  x.status = action === 'deliver' ? 'delivered' : 'cancelled';
  x.updatedAt = now;
  x.history.push({ ts: now, actor, action: x.status, note: note || undefined });
  await s.repo.shipments.update(x);
  s.hub.log(actor, `shipment.${x.status}`, `${org.id} ${x.reference}`);
  return { ok: true, value: x };
}

/** Shipments of an organisation with live ETA, delivery risk, value at risk and advisories, plus portfolio KPIs. */
export async function controlTower(s: Services, orgId: string): Promise<{ summary: SupplyChainSummary; shipments: ShipmentView[] }> {
  const now = s.now();
  const [shipments, voyages] = await Promise.all([s.repo.shipments.list(orgId), s.repo.voyages.list(orgId)]);
  const byId = new Map(voyages.map((v) => [v.id, v]));
  const views = shipments.map((x) => {
    const v = x.voyageId ? byId.get(x.voyageId) : undefined;
    const live = v ? s.hub.vessels.get(v.mmsi) : undefined;
    return buildView(x, v, live, now);
  });
  return { summary: summarize(views), shipments: views };
}

/**
 * Sweep: keep shipment status in step with its voyage (in transit when the voyage sails, delivered when it completes)
 * and raise `shipment.at_risk` when the delivery risk worsens.
 */
export async function sweepShipments(s: Services): Promise<number> {
  const now = s.now();
  let changes = 0;
  const open = await s.repo.shipments.listOpen();
  const voyageCache = new Map<string, Awaited<ReturnType<Services['repo']['voyages']['get']>>>();
  for (const x of open) {
    const key = `${x.orgId}:${x.voyageId}`;
    if (x.voyageId && !voyageCache.has(key)) voyageCache.set(key, await s.repo.voyages.get(x.orgId, x.voyageId));
    const v = x.voyageId ? voyageCache.get(key) : undefined;
    const live = v ? s.hub.vessels.get(v.mmsi) : undefined;
    const view = buildView(x, v, live, now);
    let dirty = false;
    if (v?.status === 'active' && x.status === 'booked') {
      x.status = 'in_transit';
      x.history.push({ ts: now, actor: 'system', action: 'in_transit', note: v.reference });
      dirty = true;
    } else if (v?.status === 'completed') {
      x.status = 'delivered';
      x.history.push({ ts: now, actor: 'system', action: 'delivered', note: `voyage ${v.reference} completed` });
      dirty = true;
    }
    const worse = (r: DeliveryRisk): boolean => r === 'at_risk' || r === 'late';
    if (view.deliveryRisk !== x.deliveryRisk) {
      if (worse(view.deliveryRisk) && !(x.deliveryRisk === 'late' && view.deliveryRisk === 'at_risk')) {
        emit(s, x.orgId, 'shipment.at_risk', {
          shipmentId: x.id, reference: x.reference, customer: x.customer, risk: view.deliveryRisk, projectedEta: view.projectedEta ? new Date(view.projectedEta).toISOString() : null,
          requiredBy: new Date(x.requiredBy).toISOString(), valueAtRiskInr: view.valueAtRiskInr, advisories: view.advisories,
        });
        changes++;
      }
      x.deliveryRisk = view.deliveryRisk;
      x.history.push({ ts: now, actor: 'system', action: `risk_${view.deliveryRisk}` });
      dirty = true;
    }
    if (dirty) {
      x.updatedAt = now;
      await s.repo.shipments.update(x);
    }
  }
  return changes;
}
