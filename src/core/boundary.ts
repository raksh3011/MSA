/** Boundary Safety — distance/side check against the (illustrative) fishing boundary. */
import { distanceToLineNm, isValidCoord, type LatLon } from './geo';
import { BOUNDARY_INDIA_SIDE_REFERENCE, FISHING_BOUNDARY } from './zones';

export type BoundaryLevel = 'safe' | 'caution' | 'danger' | 'crossed';

export interface BoundaryStatus {
  level: BoundaryLevel;
  distanceNm: number;
  /** true when the position is on the Indian side of the line */
  indianSide: boolean;
}

/** Signed side of the nearest boundary segment: >0 / <0 / 0. */
function sideOfNearestSegment(lat: number, lon: number, line: readonly LatLon[]): number {
  let best = Infinity;
  let sign = 0;
  const kLon = Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i] as LatLon;
    const b = line[i + 1] as LatLon;
    const d = distanceToLineNm(lat, lon, [a, b]);
    if (d < best) {
      best = d;
      const cross = (b[1] - a[1]) * kLon * (lat - a[0]) - (b[0] - a[0]) * (lon - a[1]) * kLon;
      sign = Math.sign(cross);
    }
  }
  return sign;
}

export function checkBoundary(
  lat: number,
  lon: number,
  warnNm = 10,
  line: readonly LatLon[] = FISHING_BOUNDARY,
): BoundaryStatus | null {
  if (!isValidCoord(lat, lon)) return null;
  const distanceNm = distanceToLineNm(lat, lon, line);
  const refSide = sideOfNearestSegment(BOUNDARY_INDIA_SIDE_REFERENCE[0], BOUNDARY_INDIA_SIDE_REFERENCE[1], line);
  const mySide = sideOfNearestSegment(lat, lon, line);
  const indianSide = mySide === 0 || mySide === refSide;
  let level: BoundaryLevel;
  if (!indianSide) level = 'crossed';
  else if (distanceNm <= warnNm / 2) level = 'danger';
  else if (distanceNm <= warnNm) level = 'caution';
  else level = 'safe';
  return { level, distanceNm: Math.round(distanceNm * 10) / 10, indianSide };
}
