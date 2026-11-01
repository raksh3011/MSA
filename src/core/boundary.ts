/**
 * Which modelled maritime zone is a position in, and how far is it from the nearest modelled boundary line?
 */
import { distanceToLineNm } from './geo';
import { ALL_BOUNDARY_LINES, CONTIGUOUS_ZONE, FOREIGN_WATERS, INDIA_EEZ, TERRITORIAL_SEA } from './zones';

export type WaterZone = 'territorial' | 'contiguous' | 'eez' | 'foreign' | 'high_seas';

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
