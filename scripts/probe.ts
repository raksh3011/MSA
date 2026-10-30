// Dev helper: dump simulator routes with zone classification, for scripts/check_routes.py and manual review.
import { writeFileSync } from 'node:fs';
import { classifyZone, nearestBoundaryNm } from '../src/core/boundary';
import { distanceNm, destination, type LatLon } from '../src/core/geo';
import { SIM_VESSELS } from '../src/core/simulator';

const out: Record<string, LatLon[]> = {};
for (const v of SIM_VESSELS) {
  const pts: LatLon[] = [];
  const r = v.route;
  const closed = [...r, r[0] as LatLon];
  for (let i = 0; i < closed.length - 1; i++) {
    const a = closed[i] as LatLon;
    const b = closed[i + 1] as LatLon;
    const d = distanceNm(a, b);
    const n = Math.max(1, Math.ceil(d / 4));
    for (let k = 0; k <= n; k++) {
      const f = k / n;
      pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
  }
  out[v.name] = pts;
  const zones: string[] = [];
  for (const p of pts) {
    const z = classifyZone(p[0], p[1]);
    const tag = z.zone === 'foreign' ? `foreign:${z.country}` : z.zone;
    if (zones[zones.length - 1] !== tag) zones.push(tag);
  }
  const start = r[0] as LatLon;
  console.log(v.name.padEnd(18), 'start', JSON.stringify(classifyZone(start[0], start[1])), 'distBoundary', nearestBoundaryNm(start[0], start[1]).toFixed(1), '|', zones.join(' > '));
}
void destination;
writeFileSync(process.argv[2] ?? 'routes.json', JSON.stringify(out));
