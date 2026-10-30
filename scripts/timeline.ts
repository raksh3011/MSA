// Dev helper: simulate the time-lapse demo and print when each scripted alert first fires (tick numbers).
import { Hub } from '../src/core/hub';
import { Simulator } from '../src/core/simulator';

const hub = new Hub();
const sim = new Simulator();
const ticks = Number(process.argv[2] ?? 120);
const seen = new Set<string>();
for (let i = 1; i <= ticks; i++) {
  for (const r of sim.tick()) hub.ingest(r, sim.now);
  hub.sweepGaps(sim.now);
  for (const a of [...hub.alerts].reverse()) {
    const key = `${a.ruleId}|${a.mmsi}`;
    if (seen.has(key) || a.ruleId === 'user_report') continue;
    seen.add(key);
    if (['419', '412000777', '412000555', '000'].some((p) => a.mmsi.startsWith(p)) || a.severity !== 'low') {
      console.log(String(i).padStart(4), a.severity.padEnd(8), a.vesselClass?.padEnd(8), a.ruleId.padEnd(22), a.message.slice(0, 110));
    }
  }
}
console.log('alerts:', hub.alerts.length, 'vessels:', hub.vessels.size);
