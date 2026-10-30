/**
 * Static maritime zones.
 *
 * IMPORTANT: all coordinates are simplified and ILLUSTRATIVE. They are for
 * situational awareness and demonstration only and must never be used for
 * navigation, legal boundary determination or enforcement.
 */
import type { LatLon } from './geo';

export interface Zone {
  id: string;
  name: string;
  kind: 'eez' | 'high_risk';
  polygon: LatLon[];
}

/** Approximate outline of India's mainland EEZ (Arabian Sea + Bay of Bengal). */
const INDIA_MAINLAND: LatLon[] = [
  [23.5, 62.0], [23.5, 68.0], [23.5, 72.0], [23.0, 80.0], [22.5, 87.0], [22.0, 89.5],
  [20.0, 89.0], [18.0, 88.5], [16.0, 88.0], [14.0, 87.5], [12.5, 87.0], [11.0, 86.5],
  [10.0, 85.5], [9.0, 84.0], [8.0, 82.5], [7.0, 81.0], [6.0, 80.0], [5.0, 78.5],
  [3.5, 77.0], [2.5, 75.5], [2.0, 74.0], [2.5, 72.5], [3.5, 71.0], [5.0, 69.5],
  [6.5, 68.0], [7.5, 67.5], [9.0, 67.0], [11.0, 66.5], [13.0, 66.0], [15.0, 65.5],
  [17.0, 65.0], [19.0, 64.0], [21.0, 63.0], [22.5, 62.5],
];

/** Approximate outline of the Andaman & Nicobar EEZ. */
const INDIA_ANDAMAN: LatLon[] = [
  [14.0, 91.5], [14.0, 96.5], [13.0, 97.0], [12.0, 97.0], [11.0, 96.5], [10.0, 96.0],
  [9.0, 95.5], [8.0, 95.0], [7.0, 94.5], [6.5, 93.5], [6.0, 92.5], [6.5, 91.5],
  [7.5, 91.0], [9.0, 91.0], [11.0, 91.0], [13.0, 91.0],
];

export const EEZ_ZONES: Zone[] = [
  { id: 'in-eez-main', name: 'India EEZ (mainland, approx.)', kind: 'eez', polygon: INDIA_MAINLAND },
  { id: 'in-eez-andaman', name: 'India EEZ (Andaman & Nicobar, approx.)', kind: 'eez', polygon: INDIA_ANDAMAN },
];

export const HIGH_RISK_ZONES: Zone[] = [
  {
    id: 'hr-gulf-of-aden',
    name: 'Gulf of Aden (high-risk area, approx.)',
    kind: 'high_risk',
    polygon: [[11.0, 43.0], [15.5, 43.0], [15.5, 53.0], [11.0, 53.0]],
  },
  {
    id: 'hr-somali-basin',
    name: 'Somali Basin (high-risk area, approx.)',
    kind: 'high_risk',
    polygon: [[-5.0, 45.0], [11.0, 45.0], [11.0, 60.0], [-5.0, 60.0]],
  },
];

/**
 * Illustrative India–Pakistan maritime boundary line (Sir Creek towards the
 * open Arabian Sea). Used by the Boundary Safety feature for fishermen.
 */
export const FISHING_BOUNDARY: LatLon[] = [
  [23.95, 68.15], [23.5, 67.4], [22.9, 66.5], [22.0, 65.2], [21.0, 63.8],
];

/** Side of the boundary that counts as "India" for the crossing check. */
export const BOUNDARY_INDIA_SIDE_REFERENCE: LatLon = [21.5, 69.5];
