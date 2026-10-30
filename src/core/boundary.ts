/**
 * Boundary Safety — how close is a position to the modelled maritime boundary, and is it already
 * in a neighbour's waters? Offline-first: pure computation on bundled geometry.
 */
import { distanceToLineNm, isValidCoord } from './geo';
import { ALL_BOUNDARY_LINES, CONTIGUOUS_ZONE, FOREIGN_WATERS, INDIA_EEZ, TERRITORIAL_SEA } from './zones';

export type BoundaryLevel = 'safe' | 'caution' | 'danger' | 'crossed';
export type WaterZone = 'territorial' | 'contiguous' | 'eez' | 'foreign' | 'high_seas';

export interface BoundaryStatus {
  level: BoundaryLevel;
  /** nautical miles to the nearest modelled boundary line */
  distanceNm: number;
  /** true unless the position is inside a neighbouring state's modelled waters */
  indianSide: boolean;
  zone: WaterZone;
  /** name of the neighbouring state when level is "crossed" */
  country?: string;
}

export function classifyZone(lat: number, lon: number): { zone: WaterZone; country?: string } {
  const foreign = FOREIGN_WATERS.find((f) => f.area.contains(lat, lon));
  if (foreign) return { zone: 'foreign', country: foreign.name };
  if (TERRITORIAL_SEA.contains(lat, lon)) return { zone: 'territorial' };
  if (CONTIGUOUS_ZONE.contains(lat, lon)) return { zone: 'contiguous' };
  if (INDIA_EEZ.contains(lat, lon)) return { zone: 'eez' };
  return { zone: 'high_seas' };
}

export function nearestBoundaryNm(lat: number, lon: number): number {
  let best = Infinity;
  for (const line of ALL_BOUNDARY_LINES) best = Math.min(best, distanceToLineNm(lat, lon, line));
  return best;
}

export function checkBoundary(lat: number, lon: number, warnNm = 10): BoundaryStatus | null {
  if (!isValidCoord(lat, lon)) return null;
  const { zone, country } = classifyZone(lat, lon);
  const distanceNm = Math.round(nearestBoundaryNm(lat, lon) * 10) / 10;
  const indianSide = zone !== 'foreign';
  let level: BoundaryLevel;
  if (!indianSide) level = 'crossed';
  else if (distanceNm <= warnNm / 2) level = 'danger';
  else if (distanceNm <= warnNm) level = 'caution';
  else level = 'safe';
  return { level, distanceNm, indianSide, zone, country };
}
