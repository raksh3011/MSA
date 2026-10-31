import type { LatLon } from '../core/geo';
import type { Alert, Geofence, Severity } from '../core/types';
import type { CaseRecord, CargoType, Plan, Port, RouteTemplate } from '../domain/types';
import type { Backend, FeedData, Reply, Session } from './backend';

/** Reference data served by /api/catalog. */
export interface Catalog {
  ports: Port[];
  routes: RouteTemplate[];
  plans: Plan[];
  cargoTypes: CargoType[];
  incoterms: string[];
  closureCodes: string[];
  webhookEvents: string[];
}

/** Everything the page modules need from the running workspace. */
export interface Ctx {
  backend: Backend;
  session: Session;
  isOperator: boolean;
  canManage: boolean;
  data(): FeedData | null;
  watch(): ReadonlySet<string>;
  geofences(): readonly Geofence[];
  pendingGeo: { lat: number; lon: number } | null;
  api<T>(method: string, path: string, body?: unknown): Promise<Reply<T>>;
  alertSeverity(): Map<string, Severity>;
  openOnMap(mmsi: string): void;
  toggleWatch(mmsi: string): Promise<void>;
  reloadGeofences(): Promise<void>;
  rerenderPage(): void;
  toast(message: string, kind?: 'info' | 'ok' | 'warn' | 'crit', ms?: number): void;
  alertsFor(mmsi: string): Alert[];
  incidents(): readonly CaseRecord[];
  catalog(): Catalog | null;
  /** the application clock: the server's clock as of the last feed frame */
  nowMs(): number;
  showRoute(waypoints: LatLon[] | null): void;
  refreshIncidents(): Promise<void>;
  reportVessel(mmsi: string): void;
}
