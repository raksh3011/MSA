/**
 * Digitraffic Marine (Finnish Transport Infrastructure Agency) — real, live, keyless AIS for the Baltic Sea.
 * https://www.digitraffic.fi/en/marine-traffic/  (CC BY 4.0). Used as the no-signup real-time source.
 */
import type { PositionReport } from './types';

export const DIGITRAFFIC_BASE = 'https://meri.digitraffic.fi/api/ais/v1';
export const DIGITRAFFIC_ATTRIBUTION = 'AIS data: Fintraffic / digitraffic.fi, CC BY 4.0';

interface LocationFeature {
  mmsi?: number;
  geometry?: { coordinates?: [number, number] };
  properties?: { sog?: number; cog?: number; heading?: number; timestampExternal?: number };
}
interface VesselMeta {
  mmsi?: number;
  name?: string;
  shipType?: number;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function parseLocations(json: unknown): PositionReport[] {
  const features = (json as { features?: LocationFeature[] } | null)?.features;
  if (!Array.isArray(features)) return [];
  const out: PositionReport[] = [];
  for (const f of features) {
    const c = f.geometry?.coordinates;
    const p = f.properties;
    if (!f.mmsi || !c || !p) continue;
    out.push({
      mmsi: String(f.mmsi),
      lon: c[0],
      lat: c[1],
      sog: p.sog !== undefined && p.sog <= 102 ? p.sog : 0,
      cog: p.cog !== undefined && p.cog < 360 ? p.cog : undefined,
      heading: p.heading !== undefined && p.heading < 360 ? p.heading : undefined,
      ts: p.timestampExternal,
    });
  }
  return out;
}

export function parseVessels(json: unknown): Map<string, { name?: string; type?: number }> {
  const m = new Map<string, { name?: string; type?: number }>();
  if (!Array.isArray(json)) return m;
  for (const v of json as VesselMeta[]) {
    if (v.mmsi) m.set(String(v.mmsi), { name: v.name, type: v.shipType });
  }
  return m;
}

/** Pulls recent positions and (when asked) vessel metadata, returning reports ready for Hub.ingest. */
export class DigitrafficClient {
  private meta = new Map<string, { name?: string; type?: number }>();
  private metaAt = 0;

  constructor(
    private readonly fetcher: Fetcher,
    private readonly headers: Record<string, string> = {},
  ) {}

  async poll(now: number = Date.now()): Promise<PositionReport[]> {
    if (now - this.metaAt > 15 * 60_000) {
      try {
        const res = await this.fetcher(`${DIGITRAFFIC_BASE}/vessels`, { headers: this.headers });
        if (res.ok) {
          this.meta = parseVessels(await res.json());
          this.metaAt = now;
        }
      } catch {
        /* metadata is optional: positions still flow */
      }
    }
    const from = now - 20 * 60_000;
    const res = await this.fetcher(`${DIGITRAFFIC_BASE}/locations?from=${from}`, { headers: this.headers });
    if (!res.ok) throw new Error(`Digitraffic ${res.status}`);
    return parseLocations(await res.json()).map((r) => {
      const m = this.meta.get(r.mmsi);
      return { ...r, name: m?.name, shipType: m?.type };
    });
  }
}
