/**
 * Maritime zones.
 *
 * Territorial sea / contiguous zone / EEZ and neighbouring-state waters are MODELLED from real
 * coastlines (Natural Earth, public domain) using UNCLOS distances (12 / 24 / 200 nm) with
 * equidistance lines where neighbouring coasts are closer — see scripts/build_zones.py.
 * They are NOT the official gazetted limits. High-risk areas are indicative and based on
 * public maritime-security advisories. Never use for navigation, enforcement or legal purposes.
 */
import { Area, type LatLon, type Poly } from './geo';
import raw from './zones.data.json';

interface RawNeighbour {
  code: string;
  name: string;
  eez: Poly[];
}
interface RawBoundary {
  code: string;
  name: string;
  lines: LatLon[][];
}
interface RawZones {
  meta: { source: string; method: string };
  territorial: Poly[];
  contiguous: Poly[];
  eez: Poly[];
  neighbours: RawNeighbour[];
  boundaries: RawBoundary[];
}

const data = raw as unknown as RawZones;

export const ZONES_META = data.meta;

/** Raw polygons (for drawing) and prepared areas (for fast containment). */
export const TERRITORIAL_POLYS = data.territorial;
export const CONTIGUOUS_POLYS = data.contiguous;
export const EEZ_POLYS = data.eez;

export const TERRITORIAL_SEA = new Area(data.territorial);
export const CONTIGUOUS_ZONE = new Area(data.contiguous);
export const INDIA_EEZ = new Area(data.eez);

export interface ForeignWaters {
  code: string;
  name: string;
  polys: Poly[];
  area: Area;
}
export const FOREIGN_WATERS: ForeignWaters[] = data.neighbours.map((n) => ({ code: n.code, name: n.name, polys: n.eez, area: new Area(n.eez) }));

export interface BoundaryLine {
  code: string;
  name: string;
  lines: LatLon[][];
}
export const BOUNDARIES: BoundaryLine[] = data.boundaries;
export const ALL_BOUNDARY_LINES: LatLon[][] = BOUNDARIES.flatMap((b) => b.lines);

export type RiskLevel = 'high' | 'elevated';

export interface RiskZone {
  id: string;
  name: string;
  level: RiskLevel;
  polygon: LatLon[];
  note: string;
}

const ADVISORY = 'Indicative area from public maritime-security advisories (BMP5 / UKMTO / IMB). Check current advisories.';

export const HIGH_RISK_ZONES: RiskZone[] = [
  {
    id: 'hr-gulf-of-aden',
    name: 'Gulf of Aden',
    level: 'high',
    polygon: [[12.5, 43.2], [14.0, 46.5], [15.6, 52.2], [12.0, 52.0], [11.2, 49.0], [10.6, 45.0], [11.6, 43.2]],
    note: ADVISORY,
  },
  {
    id: 'hr-bab-el-mandeb',
    name: 'Bab-el-Mandeb & southern Red Sea',
    level: 'high',
    polygon: [[12.2, 43.0], [12.8, 44.0], [16.0, 42.6], [16.0, 40.6], [13.4, 41.6]],
    note: ADVISORY,
  },
  {
    id: 'hr-somali-basin',
    name: 'Somali Basin',
    level: 'elevated',
    polygon: [[11.0, 51.5], [11.0, 62.0], [-6.0, 62.0], [-6.0, 41.0], [2.0, 41.2], [8.0, 49.5]],
    note: ADVISORY,
  },
  {
    id: 'hr-hormuz',
    name: 'Strait of Hormuz approaches',
    level: 'elevated',
    polygon: [[25.3, 55.6], [26.8, 56.9], [26.9, 57.8], [24.9, 58.0], [24.6, 56.4]],
    note: 'Dense traffic and regional tension. Indicative area.',
  },
  {
    id: 'hr-malacca',
    name: 'Malacca & Singapore Straits',
    level: 'elevated',
    polygon: [[5.8, 98.6], [4.5, 99.6], [2.2, 102.2], [1.0, 103.9], [1.4, 104.5], [3.0, 101.6], [5.2, 98.2]],
    note: 'Dense traffic and opportunistic piracy / armed robbery. Indicative area.',
  },
];
