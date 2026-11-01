// Dev helper: dump every synthetic vessel lane (densified) with zone classification for scripts/check_routes.py.
import { writeFileSync } from 'node:fs';
import { classifyZone } from '../src/core/boundary';
import { distanceNm, type LatLon } from '../src/core/geo';
import { LANES, SIM_VESSELS } from '../src/core/simulator';

const out: Record<string, LatLon[]> = {};
const add = (name: string, lane: LatLon[]): void => {
  const pts: LatLon[] = [];
  for (let i = 0; i < lane.length - 1; i++) {
    const a = lane[i] as LatLon;
    const b = lane[i + 1] as LatLon;
    const n = Math.max(1, Math.ceil(distanceNm(a, b) / 4));
    for (let k = 0; k <= n; k++) pts.push([a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)]);
  }
  if (lane.length === 1) pts.push(lane[0] as LatLon);
  out[name] = pts;
  const zones: string[] = [];
  for (const p of pts) {
    const z = classifyZone(p[0], p[1]);
    const tag = z.zone === 'foreign' ? `foreign:${z.country}` : z.zone;
    if (zones[zones.length - 1] !== tag) zones.push(tag);
  }
  console.log(name.padEnd(22), zones.join(' > '));
};
for (const [id, lane] of Object.entries(LANES)) add(`lane:${id}`, lane);
for (const v of SIM_VESSELS) if (!v.name.match(/^M[VT] [A-Z]+ [A-Z]+$/) || v.mmsi.startsWith('4192')) add(v.name || v.mmsi, v.lane);
// eslint-disable-next-line security/detect-non-literal-fs-filename
writeFileSync(process.argv[2] ?? 'routes.json', JSON.stringify(out));
