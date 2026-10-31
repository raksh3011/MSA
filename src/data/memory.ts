import type { ApiKey, CaseRecord, Delivery, Organization, RegistryVessel, Shipment, UsageMetric, Voyage, Webhook } from '../domain/types';
import type { CaseFilter, Repo } from './repo';

const clone = <T>(x: T): T => structuredClone(x);

/** In-memory repository: used by tests and the in-browser demo. Stores copies so callers cannot mutate state by accident. */
export class MemoryRepo implements Repo {
  private orgMap = new Map<string, Organization>();
  private registryMap = new Map<string, RegistryVessel>();
  private voyageMap = new Map<string, Voyage>();
  private shipmentMap = new Map<string, Shipment>();
  private caseMap = new Map<string, CaseRecord>();
  private keyMap = new Map<string, ApiKey>();
  private hookMap = new Map<string, Webhook>();
  private deliveryMap = new Map<string, Delivery>();
  private usageMap = new Map<string, number>();

  orgs = {
    get: async (id: string) => clone(this.orgMap.get(id)),
    list: async () => [...this.orgMap.values()].map(clone),
    insert: async (o: Organization) => void this.orgMap.set(o.id, clone(o)),
    update: async (o: Organization) => void this.orgMap.set(o.id, clone(o)),
  };

  registry = {
    list: async (orgId: string) => [...this.registryMap.values()].filter((v) => v.orgId === orgId).map(clone),
    get: async (orgId: string, mmsi: string) => clone(this.registryMap.get(`${orgId}:${mmsi}`)),
    upsert: async (v: RegistryVessel) => void this.registryMap.set(`${v.orgId}:${v.mmsi}`, clone(v)),
    remove: async (orgId: string, mmsi: string) => this.registryMap.delete(`${orgId}:${mmsi}`),
    count: async (orgId: string) => [...this.registryMap.values()].filter((v) => v.orgId === orgId && v.status === 'active').length,
  };

  voyages = {
    get: async (orgId: string, id: string) => {
      const v = this.voyageMap.get(id);
      return v && v.orgId === orgId ? clone(v) : undefined;
    },
    list: async (orgId: string, status?: Voyage['status']) =>
      [...this.voyageMap.values()].filter((v) => v.orgId === orgId && (!status || v.status === status)).sort((a, b) => b.updatedAt - a.updatedAt).map(clone),
    listActive: async () => [...this.voyageMap.values()].filter((v) => v.status === 'active').map(clone),
    insert: async (v: Voyage) => void this.voyageMap.set(v.id, clone(v)),
    update: async (v: Voyage) => void this.voyageMap.set(v.id, clone(v)),
    countCreatedBetween: async (orgId: string, from: number, to: number) =>
      [...this.voyageMap.values()].filter((v) => v.orgId === orgId && v.createdAt >= from && v.createdAt < to).length,
  };

  shipments = {
    get: async (orgId: string, id: string) => {
      const x = this.shipmentMap.get(id);
      return x && x.orgId === orgId ? clone(x) : undefined;
    },
    list: async (orgId: string) => [...this.shipmentMap.values()].filter((x) => x.orgId === orgId).sort((a, b) => a.requiredBy - b.requiredBy).map(clone),
    listOpen: async () => [...this.shipmentMap.values()].filter((x) => x.status === 'booked' || x.status === 'in_transit').map(clone),
    insert: async (x: Shipment) => void this.shipmentMap.set(x.id, clone(x)),
    update: async (x: Shipment) => void this.shipmentMap.set(x.id, clone(x)),
  };

  cases = {
    get: async (id: string) => clone(this.caseMap.get(id)),
    list: async (f: CaseFilter = {}) =>
      [...this.caseMap.values()]
        .filter((c) => (!f.orgId || c.orgId === f.orgId) && (!f.status || c.status === f.status) && (!f.desk || c.station.desk === f.desk))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(clone),
    listOpen: async () => [...this.caseMap.values()].filter((c) => c.status !== 'closed').map(clone),
    insert: async (c: CaseRecord) => void this.caseMap.set(c.id, clone(c)),
    update: async (c: CaseRecord) => void this.caseMap.set(c.id, clone(c)),
  };

  apiKeys = {
    insert: async (k: ApiKey) => void this.keyMap.set(k.id, clone(k)),
    findByHash: async (hash: string) => clone([...this.keyMap.values()].find((k) => k.hash === hash && !k.revokedAt)),
    list: async (orgId: string) => [...this.keyMap.values()].filter((k) => k.orgId === orgId).map(clone),
    revoke: async (orgId: string, id: string, ts: number) => {
      const k = this.keyMap.get(id);
      if (!k || k.orgId !== orgId || k.revokedAt) return false;
      k.revokedAt = ts;
      return true;
    },
    touch: async (id: string, ts: number) => {
      const k = this.keyMap.get(id);
      if (k) k.lastUsedAt = ts;
    },
  };

  webhooks = {
    list: async (orgId: string) => [...this.hookMap.values()].filter((w) => w.orgId === orgId).map(clone),
    get: async (orgId: string, id: string) => {
      const w = this.hookMap.get(id);
      return w && w.orgId === orgId ? clone(w) : undefined;
    },
    insert: async (w: Webhook) => void this.hookMap.set(w.id, clone(w)),
    remove: async (orgId: string, id: string) => {
      const w = this.hookMap.get(id);
      return w && w.orgId === orgId ? this.hookMap.delete(id) : false;
    },
  };

  deliveries = {
    insert: async (d: Delivery) => void this.deliveryMap.set(d.id, clone(d)),
    update: async (d: Delivery) => void this.deliveryMap.set(d.id, clone(d)),
    list: async (orgId: string, limit: number) =>
      [...this.deliveryMap.values()].filter((d) => d.orgId === orgId).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(clone),
  };

  usage = {
    increment: async (orgId: string, period: string, metric: UsageMetric, by = 1) => {
      const k = `${orgId}:${period}:${metric}`;
      const n = (this.usageMap.get(k) ?? 0) + by;
      this.usageMap.set(k, n);
      return n;
    },
    get: async (orgId: string, period: string, metric: UsageMetric) => this.usageMap.get(`${orgId}:${period}:${metric}`) ?? 0,
  };
}
