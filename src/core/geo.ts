/** Geodesy helpers. Polygons/lines are arrays of [lat, lon]. */

export type LatLon = [number, number];

const EARTH_RADIUS_NM = 3440.065;
const toRad = (d: number): number => (d * Math.PI) / 180;

export function isValidCoord(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** Great-circle distance in nautical miles (haversine). */
export function distanceNm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray-casting point-in-polygon. */
export function pointInPolygon(lat: number, lon: number, poly: readonly LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [latI, lonI] = poly[i] as LatLon;
    const [latJ, lonJ] = poly[j] as LatLon;
    if (lonI > lon !== lonJ > lon && lat < ((latJ - latI) * (lon - lonI)) / (lonJ - lonI) + latI) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Shortest distance (nm) from a point to a polyline, using a local equirectangular
 * projection — accurate to well under 1% at the distances (<200 nm) used here.
 */
export function distanceToLineNm(lat: number, lon: number, line: readonly LatLon[]): number {
  if (line.length === 0) return Infinity;
  const kLon = Math.cos(toRad(lat));
  const toXY = (p: LatLon): [number, number] => [(p[1] - lon) * kLon * 60, (p[0] - lat) * 60];
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = toXY(line[i] as LatLon);
    const [bx, by] = toXY(line[i + 1] as LatLon);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-ax * dx + -ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Initial bearing (degrees) from a to b. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x =
    Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
    Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Move a position by `nm` along `bearing` degrees. */
export function destination(p: LatLon, bearing: number, nm: number): LatLon {
  const d = nm / EARTH_RADIUS_NM;
  const br = toRad(bearing);
  const lat1 = toRad(p[0]);
  const lon1 = toRad(p[1]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lon2 =
    lon1 +
    Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [(lat2 * 180) / Math.PI, (((lon2 * 180) / Math.PI + 540) % 360) - 180];
}
