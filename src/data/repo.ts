/**
 * Repository layer: the single boundary between business logic and storage.
 * Two implementations: MemoryRepo (tests) and SqlRepo (Cloudflare D1 / SQLite).
 * Every query for tenant data takes the organisation id, so cross-tenant access is impossible by construction.
 */
import type { ApiKey, CaseRecord, CaseStatus, Delivery, Organization, RegistryVessel, Shipment, UsageMetric, Voyage, VoyageStatus, Webhook } from '../domain/types';

export interface OrgRepo {
  get(id: string): Promise<Organization | undefined>;
  list(): Promise<Organization[]>;
  insert(o: Organization): Promise<void>;
  update(o: Organization): Promise<void>;
}

export interface RegistryRepo {
  list(orgId: string): Promise<RegistryVessel[]>;
  get(orgId: string, mmsi: string): Promise<RegistryVessel | undefined>;
  upsert(v: RegistryVessel): Promise<void>;
  remove(orgId: string, mmsi: string): Promise<boolean>;
  count(orgId: string): Promise<number>;
}

export interface VoyageRepo {
  get(orgId: string, id: string): Promise<Voyage | undefined>;
  list(orgId: string, status?: VoyageStatus): Promise<Voyage[]>;
  /** voyages currently being monitored, across all organisations (used by the monitor) */
  listActive(): Promise<Voyage[]>;
  insert(v: Voyage): Promise<void>;
  update(v: Voyage): Promise<void>;
  countCreatedBetween(orgId: string, from: number, to: number): Promise<number>;
}

export interface ShipmentRepo {
  get(orgId: string, id: string): Promise<Shipment | undefined>;
  list(orgId: string): Promise<Shipment[]>;
  /** shipments that are still moving through the supply chain, across all organisations (used by the sweeper) */
  listOpen(): Promise<Shipment[]>;
  insert(s: Shipment): Promise<void>;
  update(s: Shipment): Promise<void>;
}

export interface CaseFilter {
  orgId?: string;
  status?: CaseStatus;
  desk?: string;
}

export interface CaseRepo {
  get(id: string): Promise<CaseRecord | undefined>;
  list(filter?: CaseFilter): Promise<CaseRecord[]>;
  /** every case that is not closed (for the SLA sweeper) */
  listOpen(): Promise<CaseRecord[]>;
  insert(c: CaseRecord): Promise<void>;
  update(c: CaseRecord): Promise<void>;
}

export interface ApiKeyRepo {
  insert(k: ApiKey): Promise<void>;
  findByHash(hash: string): Promise<ApiKey | undefined>;
  list(orgId: string): Promise<ApiKey[]>;
  revoke(orgId: string, id: string, ts: number): Promise<boolean>;
  touch(id: string, ts: number): Promise<void>;
}

export interface WebhookRepo {
  list(orgId: string): Promise<Webhook[]>;
  get(orgId: string, id: string): Promise<Webhook | undefined>;
  insert(w: Webhook): Promise<void>;
  remove(orgId: string, id: string): Promise<boolean>;
}

export interface DeliveryRepo {
  insert(d: Delivery): Promise<void>;
  update(d: Delivery): Promise<void>;
  list(orgId: string, limit: number): Promise<Delivery[]>;
}

export interface UsageRepo {
  increment(orgId: string, period: string, metric: UsageMetric, by?: number): Promise<number>;
  get(orgId: string, period: string, metric: UsageMetric): Promise<number>;
}

export interface Repo {
  orgs: OrgRepo;
  registry: RegistryRepo;
  voyages: VoyageRepo;
  shipments: ShipmentRepo;
  cases: CaseRepo;
  apiKeys: ApiKeyRepo;
  webhooks: WebhookRepo;
  deliveries: DeliveryRepo;
  usage: UsageRepo;
}
