/**
 * Deterministic vessel simulator. Powers the zero-backend demo mode and the test-suite.
 * Vessels follow looping open-water routes (so they never sail over land). Time is simulated:
 * each tick advances the clock by `stepSec`.
 */
import { bearingDeg, destination, distanceNm, type LatLon } from './geo';
import type { PositionReport } from './types';

type Behavior = 'route' | 'dark' | 'loiter' | 'jumper';

interface SimVessel {
  mmsi: string;
  name: string;
  sog: number;
  shipType: number;
  behavior: Behavior;
  /** waypoints the vessel cycles through; the first is also the start position */
  route: LatLon[];
}

/** Open-water routes, checked against Natural Earth land by scripts/check_routes.py. */
export const SIM_VESSELS: SimVessel[] = [
  // Indian naval / coast guard
  { mmsi: '419000001', name: 'INS Vikrant', sog: 18, shipType: 35, behavior: 'route', route: [[15.5, 69.2], [13.5, 66.5], [16.5, 66.0], [18.0, 69.0]] },
  { mmsi: '419000003', name: 'ICGS Samarth', sog: 14, shipType: 55, behavior: 'route', route: [[17.2, 70.5], [15.0, 71.0], [13.0, 71.5], [16.0, 70.2]] },
  // Indian merchant
  { mmsi: '419000010', name: 'MV Mumbai Trader', sog: 11, shipType: 70, behavior: 'route', route: [[18.6, 70.0], [15.0, 71.2], [12.0, 72.0], [15.0, 71.0]] },
  { mmsi: '419000011', name: 'MT Kochi Tanker', sog: 12, shipType: 80, behavior: 'route', route: [[9.5, 72.0], [11.0, 71.0], [9.0, 72.6]] },
  { mmsi: '419000012', name: 'MV Andaman Star', sog: 13, shipType: 60, behavior: 'route', route: [[12.5, 84.5], [10.5, 90.5], [12.5, 91.8], [14.5, 87.0]] },
  // Foreign merchant traffic on the main east-west lanes
  { mmsi: '636092001', name: 'MV Pacific Star', sog: 13, shipType: 70, behavior: 'route', route: [[7.8, 66.0], [7.4, 72.0], [6.0, 77.0], [5.2, 80.5], [5.8, 86.0], [5.2, 80.5], [6.0, 77.0], [7.4, 72.0]] },
  { mmsi: '412000221', name: 'CSCL Globe', sog: 16, shipType: 71, behavior: 'route', route: [[5.2, 80.5], [5.6, 86.0], [6.5, 92.5], [5.6, 86.0]] },
  { mmsi: '477000310', name: 'MT Gulf Voyager', sog: 13, shipType: 81, behavior: 'route', route: [[13.0, 58.0], [18.0, 62.0], [21.0, 64.0], [18.0, 62.0]] },
  { mmsi: '636000099', name: 'MV Atlantic Hope', sog: 14, shipType: 70, behavior: 'route', route: [[5.5, 69.0], [4.5, 73.0], [4.8, 78.0], [4.5, 73.0]] },
  { mmsi: '470000555', name: 'MT Aden Pearl', sog: 11, shipType: 80, behavior: 'route', route: [[12.2, 45.5], [12.5, 48.5], [12.4, 50.5], [12.5, 48.5]] },
  { mmsi: '463000007', name: 'Speedboat Raptor', sog: 28, shipType: 40, behavior: 'route', route: [[22.0, 61.0], [20.0, 64.0], [18.5, 66.0], [22.0, 61.0]] },
  // scripted scenarios
  { mmsi: '477000901', name: 'MV Silent Anchor', sog: 0.6, shipType: 70, behavior: 'loiter', route: [[12.0, 70.0]] },
  { mmsi: '351000404', name: 'MT Phantom', sog: 12, shipType: 80, behavior: 'jumper', route: [[10.0, 70.0], [10.0, 68.0]] },
  { mmsi: '538000808', name: 'MV Blackout', sog: 13, shipType: 70, behavior: 'dark', route: [[12.0, 71.5], [11.0, 69.0], [13.0, 70.0]] },
  // fishermen: boundary scenarios (Pakistan side, Sri Lanka side) + ordinary fishing
  { mmsi: '419100001', name: 'FV Sagar Laxmi', sog: 9, shipType: 30, behavior: 'route', route: [[22.0, 67.4], [21.6, 66.0], [22.0, 67.4]] },
  { mmsi: '419100002', name: 'FV Kerala Star', sog: 5, shipType: 30, behavior: 'route', route: [[9.8, 75.2], [10.4, 74.9], [9.6, 75.0]] },
  { mmsi: '419100005', name: 'FV Rameswaram 7', sog: 7, shipType: 30, behavior: 'route', route: [[9.62, 79.22], [9.5, 79.62], [9.62, 79.22]] },
  { mmsi: '419100004', name: 'FV Konkan Pride', sog: 5, shipType: 30, behavior: 'route', route: [[16.0, 71.0], [16.6, 71.6], [15.8, 71.4]] },
  { mmsi: '417000042', name: 'FV Lanka Star', sog: 8, shipType: 30, behavior: 'route', route: [[9.65, 79.65], [9.65, 79.18], [9.65, 79.65]] },
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

interface State {
  def: SimVessel;
  pos: LatLon;
  cog: number;
  next: number;
}

export class Simulator {
  private readonly states: State[];
  private readonly rand: () => number;
  private tickNo = 0;
  now: number;

  constructor(seed = 42, startMs = Date.UTC(2026, 9, 30, 6, 0, 0), private readonly stepSec = 120) {
    this.rand = rng(seed);
    this.now = startMs;
    this.states = SIM_VESSELS.map((def) => {
      const start = def.route[0] as LatLon;
      const target = (def.route[1] ?? start) as LatLon;
      return { def, pos: [start[0], start[1]], cog: bearingDeg(start, target), next: def.route.length > 1 ? 1 : 0 };
    });
  }

  /** Advance simulated time by one step and return the position reports "received". */
  tick(): PositionReport[] {
    this.tickNo++;
    this.now += this.stepSec * 1000;
    const hours = this.stepSec / 3600;
    const out: PositionReport[] = [];

    for (const s of this.states) {
      const { def } = s;
      if (def.behavior === 'jumper' && this.tickNo === 40) {
        s.pos = [s.pos[0], s.pos[1] + 7]; // spoofed / corrupted position
      } else if (def.behavior === 'loiter') {
        s.pos = [s.pos[0] + (this.rand() - 0.5) * 0.001, s.pos[1] + (this.rand() - 0.5) * 0.001];
      } else {
        const target = def.route[s.next] as LatLon;
        const remaining = distanceNm(s.pos, target);
        const step = def.sog * hours;
        if (remaining <= step) {
          s.pos = [target[0], target[1]];
          s.next = (s.next + 1) % def.route.length;
        } else {
          s.cog = bearingDeg(s.pos, target);
          s.pos = destination(s.pos, s.cog, step);
        }
      }
      if (def.behavior === 'dark' && this.tickNo >= 20 && this.tickNo < 60) continue; // transponder off
      out.push({
        mmsi: def.mmsi,
        name: def.name,
        lat: Math.round(s.pos[0] * 1e5) / 1e5,
        lon: Math.round(s.pos[1] * 1e5) / 1e5,
        sog: Math.max(0, Math.round((def.sog + (this.rand() - 0.5) * 0.4) * 10) / 10),
        cog: Math.round(s.cog) % 360,
        heading: Math.round(s.cog) % 360,
        shipType: def.shipType,
        ts: this.now,
      });
    }
    return out;
  }
}
