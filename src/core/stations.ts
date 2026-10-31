/**
 * Indian Coast Guard regional / district headquarters and stations used to route user reports to the
 * NEAREST controller. Locations are APPROXIMATE (town level) and for routing demonstration only —
 * verify against official sources. In an emergency use official channels (e.g. the national MRCC / distress lines).
 */
import { distanceNm } from './geo';
import type { Station } from './types';

export const STATIONS: Station[] = [
  { id: 'mumbai', name: 'ICG Regional HQ (West) - MRCC Mumbai', kind: 'Regional HQ', lat: 18.93, lon: 72.84 },
  { id: 'chennai', name: 'ICG Regional HQ (East) - MRCC Chennai', kind: 'Regional HQ', lat: 13.09, lon: 80.29 },
  { id: 'portblair', name: 'ICG Regional HQ (A&N) - MRCC Port Blair', kind: 'Regional HQ', lat: 11.68, lon: 92.74 },
  { id: 'gandhinagar', name: 'ICG Regional HQ (North-West) - Gandhinagar', kind: 'Regional HQ', lat: 23.22, lon: 72.65 },
  { id: 'porbandar', name: 'ICG District HQ Porbandar', kind: 'District HQ', lat: 21.64, lon: 69.61 },
  { id: 'okha', name: 'ICG Station Okha', kind: 'Station', lat: 22.47, lon: 69.07 },
  { id: 'vadinar', name: 'ICG Station Vadinar', kind: 'Station', lat: 22.4, lon: 69.7 },
  { id: 'veraval', name: 'ICG Station Veraval', kind: 'Station', lat: 20.91, lon: 70.37 },
  { id: 'pipavav', name: 'ICG Station Pipavav', kind: 'Station', lat: 20.9, lon: 71.5 },
  { id: 'goa', name: 'ICG District HQ Goa', kind: 'District HQ', lat: 15.41, lon: 73.8 },
  { id: 'karwar', name: 'ICG Station Karwar', kind: 'Station', lat: 14.81, lon: 74.13 },
  { id: 'mangalore', name: 'ICG District HQ Mangalore', kind: 'District HQ', lat: 12.92, lon: 74.82 },
  { id: 'kochi', name: 'ICG District HQ Kochi', kind: 'District HQ', lat: 9.97, lon: 76.27 },
  { id: 'kavaratti', name: 'ICG Station Kavaratti (Lakshadweep)', kind: 'Station', lat: 10.57, lon: 72.64 },
  { id: 'minicoy', name: 'ICG Station Minicoy', kind: 'Station', lat: 8.28, lon: 73.05 },
  { id: 'tuticorin', name: 'ICG Station Tuticorin', kind: 'Station', lat: 8.76, lon: 78.18 },
  { id: 'mandapam', name: 'ICG Station Mandapam', kind: 'Station', lat: 9.28, lon: 79.13 },
  { id: 'visakhapatnam', name: 'ICG District HQ Visakhapatnam', kind: 'District HQ', lat: 17.69, lon: 83.3 },
  { id: 'kakinada', name: 'ICG Station Kakinada', kind: 'Station', lat: 16.97, lon: 82.25 },
  { id: 'paradip', name: 'ICG District HQ Paradip', kind: 'District HQ', lat: 20.27, lon: 86.67 },
  { id: 'haldia', name: 'ICG Station Haldia', kind: 'Station', lat: 22.03, lon: 88.07 },
  { id: 'diglipur', name: 'ICG Station Diglipur (A&N)', kind: 'Station', lat: 13.27, lon: 93.0 },
  { id: 'campbellbay', name: 'ICG Station Campbell Bay (Nicobar)', kind: 'Station', lat: 7.0, lon: 93.92 },
];

/**
 * Each station reports to a regional controller desk. Users with `station = <desk id>` are the controllers
 * who are notified when a report is routed to any station of that desk.
 */
const DESK: Record<string, string> = {
  mumbai: 'mumbai', goa: 'mumbai', karwar: 'mumbai', mangalore: 'mumbai',
  gandhinagar: 'gandhinagar', porbandar: 'gandhinagar', okha: 'gandhinagar', vadinar: 'gandhinagar', veraval: 'gandhinagar', pipavav: 'gandhinagar',
  kochi: 'kochi', kavaratti: 'kochi', minicoy: 'kochi',
  chennai: 'chennai', mandapam: 'chennai', tuticorin: 'chennai', visakhapatnam: 'chennai', kakinada: 'chennai', paradip: 'chennai', haldia: 'chennai',
  portblair: 'portblair', diglipur: 'portblair', campbellbay: 'portblair',
};

export const DESKS: Array<{ id: string; name: string }> = [
  { id: 'mumbai', name: 'MRCC Mumbai desk' },
  { id: 'gandhinagar', name: 'North-West Region desk (Gandhinagar)' },
  { id: 'kochi', name: 'Kochi desk' },
  { id: 'chennai', name: 'MRCC Chennai desk' },
  { id: 'portblair', name: 'MRCC Port Blair desk' },
];

export function deskOf(stationId: string): string {
  return DESK[stationId] ?? stationId;
}

export function stationById(id: string): Station | undefined {
  return STATIONS.find((s) => s.id === id);
}

/** The nearest Coast Guard station to a position, with the great-circle distance in nautical miles. */
export interface NearestStation {
  station: Station;
  distanceNm: number;
}

export function nearestStation(lat: number, lon: number): NearestStation {
  let best = STATIONS[0] as Station;
  let bestD = Infinity;
  for (const s of STATIONS) {
    const d = distanceNm([lat, lon], [s.lat, s.lon]);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return { station: best, distanceNm: Math.round(bestD) };
}
