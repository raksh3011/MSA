/**
 * Deterministic vessel simulator. Powers the zero-backend demo mode and the
 * test-suite. Time is simulated: each tick advances the clock by `stepSec`.
 */
import { destination, type LatLon } from './geo';
import type { PositionReport } from './types';

type Behavior = 'cruise' | 'dark' | 'loiter' | 'jumper' | 'fisher';

interface SimVessel {
  mmsi: string;
  name: string;
  lat: number;
  lon: number;
  cog: number;
  sog: number;
  shipType: number;
  behavior: Behavior;
}

const SEEDS: SimVessel[] = [
  { mmsi: '419000001', name: 'INS Vikrant', lat: 15.5, lon: 69.2, cog: 45, sog: 18, shipType: 35, behavior: 'cruise' },
  { mmsi: '419000003', name: 'ICGS Samarth', lat: 17.2, lon: 70.5, cog: 180, sog: 14, shipType: 55, behavior: 'cruise' },
  { mmsi: '419000010', name: 'MV Mumbai Trader', lat: 20.5, lon: 67.8, cog: 160, sog: 10, shipType: 70, behavior: 'cruise' },
  { mmsi: '419000011', name: 'MT Kochi Tanker', lat: 6.5, lon: 73.8, cog: 350, sog: 11, shipType: 80, behavior: 'cruise' },
  { mmsi: '419000012', name: 'MV Andaman Star', lat: 9.0, lon: 90.5, cog: 90, sog: 13, shipType: 60, behavior: 'cruise' },
  { mmsi: '636092001', name: 'MV Pacific Star', lat: 7.8, lon: 74.2, cog: 90, sog: 12, shipType: 70, behavior: 'cruise' },
  { mmsi: '412000221', name: 'CSCL Globe', lat: 5.5, lon: 80.5, cog: 315, sog: 15, shipType: 71, behavior: 'cruise' },
  { mmsi: '477000310', name: 'MT Gulf Voyager', lat: 13.0, lon: 58.0, cog: 70, sog: 13, shipType: 81, behavior: 'cruise' },
  { mmsi: '636000099', name: 'MV Atlantic Hope', lat: 3.5, lon: 76.0, cog: 45, sog: 14, shipType: 70, behavior: 'cruise' },
  { mmsi: '470000555', name: 'MT Aden Pearl', lat: 13.5, lon: 44.0, cog: 95, sog: 11, shipType: 80, behavior: 'cruise' },
  { mmsi: '463000007', name: 'Speedboat Raptor', lat: 22.0, lon: 61.0, cog: 95, sog: 28, shipType: 40, behavior: 'cruise' },
  // scripted scenarios
  { mmsi: '477000901', name: 'MV Silent Anchor', lat: 12.0, lon: 70.0, cog: 0, sog: 0.6, shipType: 70, behavior: 'loiter' },
  { mmsi: '351000404', name: 'MT Phantom', lat: 10.0, lon: 72.0, cog: 90, sog: 12, shipType: 80, behavior: 'jumper' },
  { mmsi: '538000808', name: 'MV Blackout', lat: 14.0, lon: 75.0, cog: 200, sog: 13, shipType: 70, behavior: 'dark' },
  // fishermen
  { mmsi: '419100001', name: 'FV Sagar Laxmi', lat: 22.0, lon: 65.55, cog: 270, sog: 6, shipType: 30, behavior: 'fisher' },
  { mmsi: '419100002', name: 'FV Kerala Star', lat: 9.5, lon: 75.0, cog: 220, sog: 4, shipType: 30, behavior: 'cruise' },
  { mmsi: '419100003', name: 'FV Tamil Nila', lat: 10.2, lon: 82.0, cog: 120, sog: 5, shipType: 30, behavior: 'cruise' },
  { mmsi: '419100004', name: 'FV Konkan Pride', lat: 16.0, lon: 71.0, cog: 300, sog: 5, shipType: 30, behavior: 'cruise' },
];

/** mulberry32 — tiny deterministic PRNG */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOUNDS = { latMin: -8, latMax: 30, lonMin: 44, lonMax: 100 };

export class Simulator {
  private readonly vessels: SimVessel[];
  private readonly rand: () => number;
  private tickNo = 0;
  now: number;

  constructor(seed = 42, startMs = Date.UTC(2026, 9, 30, 6, 0, 0), private readonly stepSec = 120) {
    this.rand = rng(seed);
    this.now = startMs;
    this.vessels = SEEDS.map((s) => ({ ...s }));
  }

  /** Advance simulated time by one step and return the position reports "received". */
  tick(): PositionReport[] {
    this.tickNo++;
    this.now += this.stepSec * 1000;
    const hours = this.stepSec / 3600;
    const out: PositionReport[] = [];

    for (const v of this.vessels) {
      if (v.behavior === 'jumper' && this.tickNo === 40) {
        v.lon += 8; // spoofed / corrupted position
      } else if (v.behavior !== 'loiter') {
        if (v.behavior !== 'fisher') v.cog = (v.cog + (this.rand() - 0.5) * 2 + 360) % 360;
        const p: LatLon = destination([v.lat, v.lon], v.cog, v.sog * hours);
        v.lat = p[0];
        v.lon = p[1];
      } else {
        v.lat += (this.rand() - 0.5) * 0.001;
        v.lon += (this.rand() - 0.5) * 0.001;
      }
      if (v.lat < BOUNDS.latMin || v.lat > BOUNDS.latMax || v.lon < BOUNDS.lonMin || v.lon > BOUNDS.lonMax) {
        v.cog = (v.cog + 180) % 360;
        v.lat = Math.min(BOUNDS.latMax, Math.max(BOUNDS.latMin, v.lat));
        v.lon = Math.min(BOUNDS.lonMax, Math.max(BOUNDS.lonMin, v.lon));
      }
      if (v.behavior === 'dark' && this.tickNo >= 20 && this.tickNo < 60) continue; // transponder off
      out.push({
        mmsi: v.mmsi,
        name: v.name,
        lat: Math.round(v.lat * 1e5) / 1e5,
        lon: Math.round(v.lon * 1e5) / 1e5,
        sog: Math.max(0, Math.round((v.sog + (this.rand() - 0.5) * 0.4) * 10) / 10),
        cog: Math.round(v.cog),
        heading: Math.round(v.cog),
        shipType: v.shipType,
        ts: this.now,
      });
    }
    return out;
  }
}
