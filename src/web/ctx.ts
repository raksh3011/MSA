import type { Alert, Geofence, Severity } from '../core/types';
import type { Backend, FeedData, Reply, Session } from './backend';

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
  toast(message: string): void;
  alertsFor(mmsi: string): Alert[];
}
