/** Parser for aisstream.io messages. Pure and defensive: never throws on bad input. */
import type { PositionReport } from '../core/types';

export type ParsedAis =
  | { kind: 'position'; report: PositionReport }
  | { kind: 'static'; mmsi: string; name?: string; shipType?: number };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);

export function parseAisMessage(raw: string): ParsedAis | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(msg)) return null;
  const meta = isObj(msg.MetaData) ? msg.MetaData : {};
  const body = isObj(msg.Message) ? msg.Message : {};
  const mmsi = String(meta.MMSI ?? '').trim();
  if (!/^\d{9}$/.test(mmsi)) return null;
  const metaName = typeof meta.ShipName === 'string' ? meta.ShipName.trim() : undefined;

  if (msg.MessageType === 'ShipStaticData' && isObj(body.ShipStaticData)) {
    const s = body.ShipStaticData;
    return { kind: 'static', mmsi, name: (typeof s.Name === 'string' ? s.Name.trim() : metaName) || undefined, shipType: num(s.Type) };
  }

  if (msg.MessageType === 'PositionReport' && isObj(body.PositionReport)) {
    const p = body.PositionReport;
    const lat = num(p.Latitude);
    const lon = num(p.Longitude);
    if (lat === undefined || lon === undefined) return null;
    const heading = num(p.TrueHeading);
    const t = typeof meta.time_utc === 'string' ? Date.parse(meta.time_utc.replace(' +0000 UTC', 'Z').replace(' ', 'T')) : NaN;
    return {
      kind: 'position',
      report: {
        mmsi,
        name: metaName || undefined,
        lat,
        lon,
        sog: num(p.Sog),
        cog: num(p.Cog),
        heading: heading !== undefined && heading < 360 ? heading : undefined, // 511 = not available
        ts: Number.isFinite(t) ? t : undefined,
      },
    };
  }
  return null;
}
