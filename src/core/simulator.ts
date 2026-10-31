/**
 * Synthetic AIS traffic around India. Produces PositionReports through exactly the same pipeline as live AIS
 * (Hub.ingest → risk engine), flagged `synthetic` so the UI can always tell them apart from real vessels.
 *
 * Vessels sail looping shipping lanes (open water only — verified against land by scripts/check_routes.py).
 * Two clock modes:
 *  - time-lapse (default demo): every tick advances simulated time by `stepSec`, so scenarios play out in minutes;
 *  - real-time (`tick(wallNow)`): movement follows the wall clock, i.e. the same pace as live AIS.
 */
import { bearingDeg, destination, distanceNm, type LatLon } from './geo';
import type { PositionReport } from './types';

type Behavior = 'lane' | 'dark' | 'loiter' | 'jumper';

export interface SimVessel {
  mmsi: string;
  name: string;
  sog: number;
  shipType: number | undefined;
  behavior: Behavior;
  /** ping-pong route; the vessel starts `phase` (0..1) of the way along it */
  lane: LatLon[];
  phase: number;
  /** AIS reports roughly every `reportEverySec` seconds of simulated time */
  reportEverySec: number;
}

/** Main shipping lanes in and around India's waters. */
export const LANES: Record<string, LatLon[]> = {
  adenColombo: [[12.6, 45.0], [12.4, 49.5], [12.0, 53.0], [10.0, 60.0], [8.8, 68.0], [7.6, 74.0], [6.2, 78.5], [5.4, 80.6]],
  colomboMalacca: [[5.4, 80.6], [5.6, 86.0], [6.5, 92.5], [5.9, 97.8]],
  adenMumbai: [[12.6, 45.0], [14.0, 52.0], [15.5, 60.0], [17.5, 66.5], [18.6, 71.2]],
  mumbaiKochi: [[18.7, 71.0], [15.0, 72.2], [11.0, 73.8], [9.6, 75.2]],
  kochiSouth: [[9.6, 75.2], [7.6, 76.4], [6.0, 78.4]],
  chennaiColombo: [[13.0, 81.0], [10.8, 82.0], [8.0, 82.8], [6.4, 82.0]],
  kolkataChennai: [[20.8, 88.6], [18.4, 87.3], [15.8, 84.4], [13.2, 81.4]],
  mumbaiGulf: [[18.7, 71.0], [20.5, 66.0], [23.0, 61.0], [24.9, 58.2], [25.8, 56.8]],
  mumbaiKandla: [[18.7, 71.0], [20.4, 69.5], [22.2, 68.0]],
  chennaiPortBlair: [[13.1, 81.6], [12.3, 85.0], [11.6, 91.8]],
  karachiGulf: [[24.6, 66.4], [24.0, 63.0], [24.6, 58.8]],
  chittagongColombo: [[21.5, 91.8], [19.0, 90.0], [15.0, 88.0], [10.0, 86.0], [7.0, 83.5]],
  colomboEquator: [[5.4, 80.6], [1.5, 73.2], [-3.0, 68.0]],
};

/** A fictional shipping company whose vessels the demo fleet operator manages. */
export const FLEET_NAME = 'Bharat Ocean Carriers';

const FLEET: Array<{ mmsi: string; name: string; type: number; lane: keyof typeof LANES; reverse: boolean; phase: number; sog: number }> = [
  { mmsi: '419200101', name: 'BOC ARAVALI', type: 80, lane: 'adenMumbai', reverse: true, phase: 0.78, sog: 13 },
  { mmsi: '419200102', name: 'BOC NILGIRI', type: 70, lane: 'mumbaiGulf', reverse: false, phase: 0.85, sog: 13 },
  { mmsi: '419200103', name: 'BOC VINDHYA', type: 71, lane: 'mumbaiKochi', reverse: false, phase: 0.25, sog: 14 },
  { mmsi: '419200104', name: 'BOC SAHYADRI', type: 70, lane: 'kolkataChennai', reverse: false, phase: 0.5, sog: 12 },
  { mmsi: '419200105', name: 'BOC KAVERI', type: 81, lane: 'mumbaiKandla', reverse: true, phase: 0.4, sog: 11 },
  { mmsi: '419200106', name: 'BOC GANGA', type: 71, lane: 'colomboMalacca', reverse: false, phase: 0.6, sog: 15 },
  { mmsi: '419200107', name: 'BOC NARMADA', type: 70, lane: 'chennaiColombo', reverse: false, phase: 0.35, sog: 13 },
  { mmsi: '419200108', name: 'BOC SUTLEJ', type: 82, lane: 'adenColombo', reverse: true, phase: 0.7, sog: 14 },
  { mmsi: '419200109', name: 'BOC GODAVARI', type: 70, lane: 'mumbaiKochi', reverse: true, phase: 0.6, sog: 12 },
  { mmsi: '419200110', name: 'BOC KRISHNA', type: 71, lane: 'chittagongColombo', reverse: true, phase: 0.45, sog: 13 },
];
export const FLEET_MMSIS: string[] = FLEET.map((f) => f.mmsi);
/** Fleet vessels with their static attributes (used to seed the fleet registry). */
export const FLEET_VESSELS: Array<{ mmsi: string; name: string; type: number }> = FLEET.map((f) => ({ mmsi: f.mmsi, name: f.name, type: f.type }));

/** A second, smaller customer fleet, to demonstrate tenant isolation. */
export const KT_FLEET_NAME = 'Konkan Tankers Pvt Ltd';
const KT_FLEET: Array<{ mmsi: string; name: string; type: number; lane: keyof typeof LANES; reverse: boolean; phase: number; sog: number }> = [
  { mmsi: '419400101', name: 'KONKAN VIKRAM', type: 80, lane: 'mumbaiGulf', reverse: false, phase: 0.4, sog: 12 },
  { mmsi: '419400102', name: 'KONKAN SAGAR', type: 81, lane: 'mumbaiKandla', reverse: false, phase: 0.55, sog: 11 },
  { mmsi: '419400103', name: 'KONKAN SHAKTI', type: 82, lane: 'adenMumbai', reverse: true, phase: 0.3, sog: 13 },
];
export const KT_FLEET_VESSELS: Array<{ mmsi: string; name: string; type: number }> = KT_FLEET.map((f) => ({ mmsi: f.mmsi, name: f.name, type: f.type }));
export const KT_FLEET_MMSIS: string[] = KT_FLEET.map((f) => f.mmsi);

/** Lane traffic: lane, number of vessels, base speed (kn). */
const LANE_TRAFFIC: Array<[keyof typeof LANES, number, number]> = [
  ['adenColombo', 8, 14], ['colomboMalacca', 7, 14], ['adenMumbai', 6, 13], ['mumbaiKochi', 5, 12], ['kochiSouth', 3, 12],
  ['chennaiColombo', 4, 13], ['kolkataChennai', 4, 12], ['mumbaiGulf', 6, 13], ['mumbaiKandla', 3, 11], ['chennaiPortBlair', 2, 15],
  ['karachiGulf', 3, 12], ['chittagongColombo', 3, 12], ['colomboEquator', 3, 14],
];

const MIDS = [636, 351, 538, 563, 477, 412, 419, 240, 229, 248, 256, 235, 211, 257, 371, 311, 355, 564, 447, 470, 403, 463, 405, 417, 219, 273];
const WORD_A = ['AURORA', 'CORAL', 'ORION', 'PACIFIC', 'ATLANTIC', 'GOLDEN', 'SILVER', 'HARMONY', 'FORTUNE', 'OCEAN', 'LOTUS', 'PEARL', 'EAGLE', 'FALCON', 'TITAN', 'NEPTUNE', 'ATLAS', 'MERIDIAN', 'HORIZON', 'VOYAGER', 'PIONEER', 'CRESCENT', 'SAPPHIRE', 'EMERALD', 'JADE', 'AMBER', 'IVORY', 'MONSOON', 'CASPIAN', 'BOREAL'];
const WORD_B = ['EXPRESS', 'TRADER', 'CARRIER', 'SPIRIT', 'GLORY', 'PRIDE', 'LEGACY', 'BRIDGE', 'WAVE', 'BREEZE', 'STAR', 'QUEST', 'ARROW', 'HARVEST'];

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

function buildFleet(): SimVessel[] {
  const r = rng(2026);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)] as T;
  const usedNames = new Set<string>();
  const usedMmsi = new Set<string>();
  const mmsi = (mid: number): string => {
    for (;;) {
      const m = `${mid}${String(Math.floor(r() * 1_000_000)).padStart(6, '0')}`;
      if (!usedMmsi.has(m)) {
        usedMmsi.add(m);
        return m;
      }
    }
  };
  const name = (prefix: string): string => {
    for (;;) {
      const n = `${prefix} ${pick(WORD_A)} ${pick(WORD_B)}`;
      if (!usedNames.has(n)) {
        usedNames.add(n);
        return n;
      }
    }
  };
  const fleet: SimVessel[] = [];

  // ordinary lane traffic
  for (const [laneId, count, base] of LANE_TRAFFIC) {
    const lane = LANES[laneId] as LatLon[];
    for (let i = 0; i < count; i++) {
      const roll = r();
      const tanker = roll < 0.32;
      const passenger = laneId === 'chennaiPortBlair';
      const type = passenger ? 60 : tanker ? 80 + Math.floor(r() * 5) : roll < 0.6 ? 71 : 70 + Math.floor(r() * 5);
      fleet.push({
        mmsi: mmsi(pick(MIDS)),
        name: name(tanker ? 'MT' : 'MV'),
        sog: Math.round((base + (r() - 0.5) * 4) * 10) / 10,
        shipType: type,
        behavior: 'lane',
        lane: r() < 0.5 ? lane : [...lane].reverse(),
        phase: r(),
        reportEverySec: 10 + Math.floor(r() * 50),
      });
    }
  }

  // the operator's fleet
  for (const f of FLEET) {
    const lane = LANES[f.lane] as LatLon[];
    fleet.push({ mmsi: f.mmsi, name: f.name, sog: f.sog, shipType: f.type, behavior: 'lane', lane: f.reverse ? [...lane].reverse() : lane, phase: f.phase, reportEverySec: 15 });
  }

  for (const f of KT_FLEET) {
    const lane = LANES[f.lane] as LatLon[];
    fleet.push({ mmsi: f.mmsi, name: f.name, sog: f.sog, shipType: f.type, behavior: 'lane', lane: f.reverse ? [...lane].reverse() : lane, phase: f.phase, reportEverySec: 15 });
  }

  // Indian Coast Guard / Navy patrols
  const patrols: Array<[string, number, LatLon[]]> = [
    ['ICG PATROL 01', 55, [[19.2, 71.0], [18.6, 70.4], [19.4, 70.2]]],
    ['ICG PATROL 02', 55, [[10.2, 74.6], [9.4, 74.9], [10.0, 75.2]]],
    ['ICG PATROL 03', 55, [[13.2, 81.0], [12.6, 81.5], [13.4, 81.6]]],
    ['ICG PATROL 04', 55, [[11.6, 91.6], [11.9, 92.0], [11.3, 91.9]]],
    ['ICG PATROL 05', 55, [[21.9, 68.0], [21.5, 68.3], [22.0, 68.4]]],
    ['ICG PATROL 06', 55, [[10.6, 71.4], [10.2, 71.9], [10.9, 71.9]]],
    ['INDIAN NAVY 01', 35, [[15.5, 69.2], [13.5, 66.5], [16.5, 66.0], [18.0, 69.0]]],
    ['INDIAN NAVY 02', 35, [[14.0, 84.0], [12.0, 86.0], [16.0, 86.0]]],
  ];
  patrols.forEach(([n, type, lane], i) =>
    fleet.push({ mmsi: `4190${String(10 + i).padStart(5, '0')}`, name: n, sog: type === 35 ? 16 : 12, shipType: type, behavior: 'lane', lane, phase: r(), reportEverySec: 10 }),
  );

  // scenarios the risk engine should pick up
  fleet.push(
    { mmsi: '000000101', name: '', sog: 22, shipType: undefined, behavior: 'lane', lane: [[22.0, 61.5], [21.4, 66.0], [21.9, 69.15]], phase: 0.85, reportEverySec: 20 },
    { mmsi: '000000202', name: '', sog: 18, shipType: undefined, behavior: 'lane', lane: [[8.0, 97.0], [8.6, 94.6]], phase: 0, reportEverySec: 20 },
    { mmsi: '463000007', name: 'SPEEDBOAT RAPTOR', sog: 28, shipType: 40, behavior: 'lane', lane: [[22.0, 61.0], [20.0, 64.0], [18.5, 66.0]], phase: 0, reportEverySec: 10 },
    { mmsi: '419000808', name: 'MV BLACKOUT', sog: 13, shipType: 70, behavior: 'dark', lane: [[17.5, 70.8], [14.5, 72.0]], phase: 0.3, reportEverySec: 20 },
    { mmsi: '419300111', name: 'MSV KANDLA SAIL 11', sog: 9, shipType: undefined, behavior: 'lane', lane: [[22.0, 67.8], [23.4, 66.0]], phase: 0.3, reportEverySec: 20 },
    { mmsi: '412000777', name: 'FOREIGN WARSHIP 1', sog: 28, shipType: 35, behavior: 'lane', lane: [[15.5, 60.0], [15.4, 73.35]], phase: 0.6, reportEverySec: 10 },
    { mmsi: '412000555', name: 'RESEARCH SURVEY 7', sog: 1.5, shipType: 59, behavior: 'lane', lane: [[8.2, 91.5], [8.5, 91.8]], phase: 0, reportEverySec: 20 },
    { mmsi: '351000404', name: 'MT PHANTOM', sog: 12, shipType: 80, behavior: 'jumper', lane: [[10.0, 70.0], [10.0, 68.0]], phase: 0.5, reportEverySec: 20 },
    { mmsi: '477000901', name: 'MV SILENT ANCHOR', sog: 0.6, shipType: 70, behavior: 'loiter', lane: [[12.0, 70.0]], phase: 0, reportEverySec: 20 },
  );
  return fleet;
}

export const SIM_VESSELS: SimVessel[] = buildFleet();

interface State {
  def: SimVessel;
  lane: LatLon[];
  /** distance along lane, nm */
  s: number;
  dir: 1 | -1;
  len: number;
  seg: number[];
  lastReport: number;
  jumped: boolean;
}

function laneLengths(lane: LatLon[]): { seg: number[]; len: number } {
  const seg: number[] = [];
  let len = 0;
  for (let i = 0; i < lane.length - 1; i++) {
    const d = distanceNm(lane[i] as LatLon, lane[i + 1] as LatLon);
    seg.push(d);
    len += d;
  }
  return { seg, len };
}

function pointAt(lane: LatLon[], seg: number[], s: number): { pos: LatLon; cog: number } {
  if (lane.length === 1) return { pos: lane[0] as LatLon, cog: 0 };
  let rest = s;
  for (let i = 0; i < seg.length; i++) {
    const d = seg[i] as number;
    if (rest <= d || i === seg.length - 1) {
      const a = lane[i] as LatLon;
      const b = lane[i + 1] as LatLon;
      const cog = bearingDeg(a, b);
      return { pos: destination(a, cog, Math.min(rest, d)), cog };
    }
    rest -= d;
  }
  return { pos: lane[lane.length - 1] as LatLon, cog: 0 };
}

export class Simulator {
  private readonly states: State[];
  private readonly rand: () => number;
  private elapsedSec = 0;
  private lastWall: number | undefined;
  now: number;

  constructor(seed = 42, startMs = Date.UTC(2026, 9, 30, 6, 0, 0), private readonly stepSec = 120) {
    this.rand = rng(seed);
    this.now = startMs;
    this.states = SIM_VESSELS.map((def) => {
      const { seg, len } = laneLengths(def.lane);
      return { def, lane: def.lane, s: def.phase * len, dir: 1, len, seg, lastReport: startMs - Math.floor(this.rand() * def.reportEverySec * 1000), jumped: false };
    });
  }

  /**
   * Advance the simulation and return the reports "received" since the last call.
   * Pass the wall-clock time for real-time mode; omit it for time-lapse (each call = `stepSec` simulated seconds).
   */
  tick(wallNow?: number): PositionReport[] {
    let dtSec: number;
    if (wallNow !== undefined) {
      dtSec = this.lastWall === undefined ? 0 : Math.max(0, Math.min(60, (wallNow - this.lastWall) / 1000));
      this.lastWall = wallNow;
      this.now = wallNow;
    } else {
      dtSec = this.stepSec;
      this.now += dtSec * 1000;
    }
    this.elapsedSec += dtSec;
    const out: PositionReport[] = [];

    for (const st of this.states) {
      const { def } = st;
      if (def.behavior !== 'loiter') {
        st.s += st.dir * def.sog * (dtSec / 3600);
        if (st.s >= st.len) {
          st.s = st.len;
          st.dir = -1;
        } else if (st.s <= 0) {
          st.s = 0;
          st.dir = 1;
        }
      }
      if (def.behavior === 'jumper' && !st.jumped && this.elapsedSec >= 80 * 60) {
        // spoofed / corrupted position: the reported track suddenly jumps ~7 degrees of longitude away
        st.jumped = true;
        const [a, b] = st.lane as [LatLon, LatLon];
        st.lane = [a, [b[0], b[1] + 7]];
        const l = laneLengths(st.lane);
        st.seg = l.seg;
        st.len = l.len;
        st.s = st.len;
      }
      if (def.behavior === 'dark' && this.elapsedSec >= 40 * 60 && this.elapsedSec < 90 * 60) continue; // transponder off
      if (this.now - st.lastReport < def.reportEverySec * 1000) continue;
      st.lastReport = this.now;

      const { pos, cog: laneCog } = pointAt(st.lane, st.seg, st.s);
      const cog = (laneCog + (st.dir === -1 ? 180 : 0)) % 360;
      const jitter = def.behavior === 'loiter' ? 0.004 : 0.0004;
      out.push({
        mmsi: def.mmsi,
        name: def.name || undefined,
        lat: Math.round((pos[0] + (this.rand() - 0.5) * jitter) * 1e5) / 1e5,
        lon: Math.round((pos[1] + (this.rand() - 0.5) * jitter) * 1e5) / 1e5,
        sog: Math.max(0, Math.round((def.sog + (this.rand() - 0.5) * 0.4) * 10) / 10),
        cog: Math.round(cog) % 360,
        heading: Math.round(cog + (this.rand() - 0.5) * 4 + 360) % 360,
        shipType: def.shipType,
        ts: this.now,
        synthetic: true,
      });
    }
    return out;
  }
}
