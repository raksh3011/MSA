/** Live-AIS coverage presets for the aisstream.io subscription. Boxes are [[lat, lon], [lat, lon]] corners. */
export type Box = [[number, number], [number, number]];
export type Region = 'india' | 'indian-ocean' | 'world';

/** Everything inside and around India's modelled EEZ (mainland, Lakshadweep, Andaman & Nicobar). */
export const INDIA_BOX: Box = [[-2, 58], [28, 102]];

const CHOKEPOINTS: Box[] = [
  [[10, 32], [32, 60]], // Red Sea, Gulf of Aden, Arabian Sea approaches, Hormuz, Gulf of Oman
  [[-5, 95], [10, 108]], // Malacca & Singapore Straits, Andaman Sea
];

export function parseRegion(value: string | undefined): Region {
  return value === 'world' || value === 'indian-ocean' ? value : 'india';
}

export function boxesFor(region: Region): Box[] {
  switch (region) {
    case 'world':
      return [[[-90, -180], [90, 180]]];
    case 'indian-ocean':
      return [[[-40, 20], [32, 125]]];
    default:
      return [INDIA_BOX, ...CHOKEPOINTS];
  }
}

export function inBox(lat: number, lon: number, box: Box): boolean {
  const [[la1, lo1], [la2, lo2]] = box;
  return lat >= Math.min(la1, la2) && lat <= Math.max(la1, la2) && lon >= Math.min(lo1, lo2) && lon <= Math.max(lo1, lo2);
}

/** Reports near India are kept at full rate; the rest of the world is thinned to protect free-tier CPU/bandwidth. */
export function minGapMs(lat: number, lon: number): number {
  return inBox(lat, lon, INDIA_BOX) ? 10_000 : 60_000;
}
