import { describe, expect, it } from 'vitest';
import { classifyZone } from '../../src/core/boundary';
import { DEFAULT_POLICY, Deduper, classOf, evaluateGaps, evaluateVessel, type RuleContext } from '../../src/core/engine';
import { distanceToEezNm } from '../../src/core/zones';
import { Hub } from '../../src/core/hub';
import { Simulator } from '../../src/core/simulator';
import type { Vessel } from '../../src/core/types';

const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({ policy: DEFAULT_POLICY, geofences: [], now: 1_000_000, ...over });
const vessel = (o: Partial<Vessel>): Vessel => ({
  mmsi: '636000001', name: 'MV Test', lat: 15, lon: 72, sog: 12, cog: 0, heading: 0,
  category: 'cargo', flag: 'Liberia', lastSeen: 1_000_000, trail: [], ...o,
});
const rules = (v: Vessel, prev: Vessel | undefined, c = ctx()) => evaluateVessel(v, prev, c).map((x) => x.ruleId);

describe('risk rules', () => {
  it('flags a foreign vessel entering the EEZ', () => {
    expect(rules(vessel({ lat: 17.2, lon: 70.5 }), vessel({ lat: 17.2, lon: 62 }))).toContain('eez_entry');
  });

  it('does not flag Indian-flag or military vessels', () => {
    expect(rules(vessel({ flag: 'India', lat: 17.2, lon: 70.5 }), vessel({ lat: 17.2, lon: 62 }))).not.toContain('eez_entry');
    expect(rules(vessel({ category: 'naval', flag: 'India', lat: 17.2, lon: 70.5 }), vessel({ lat: 17.2, lon: 62 }))).not.toContain('eez_entry');
    // ...but a foreign warship entering the EEZ is escalated
    const warship = evaluateVessel(vessel({ category: 'naval', flag: 'China', lat: 17.2, lon: 70.5 }), vessel({ lat: 17.2, lon: 62 }), ctx()).find((x) => x.ruleId === 'eez_entry');
    expect(warship?.severity).toBe('high');
  });

  it('escalates to critical for a fast vessel of a flag of interest', () => {
    const policy = { ...DEFAULT_POLICY, flagsOfInterest: ['Liberia'] };
    const f = evaluateVessel(vessel({ sog: 30, category: 'other', lat: 17.2, lon: 70.5 }), vessel({ lat: 17.2, lon: 62, category: 'other' }), ctx({ policy }));
    expect(f.find((x) => x.ruleId === 'eez_entry')?.severity).toBe('critical');
  });

  it('flags high speed inside the EEZ only once', () => {
    const fast = vessel({ sog: 30 });
    expect(rules(fast, undefined)).toContain('high_speed_in_eez');
    expect(rules(fast, fast)).not.toContain('high_speed_in_eez');
  });

  it('alerts when an Indian vessel enters a critical zone, graded by zone level; foreign traffic is only a low-priority note', () => {
    const aden = evaluateVessel(vessel({ flag: 'India', lat: 13, lon: 48 }), vessel({ flag: 'India', lat: 20, lon: 48 }), ctx()).find((x) => x.ruleId === 'indian_critical_zone');
    expect(aden?.severity).toBe('high');
    expect(aden?.message).toMatch(/Indian vessel/);
    const somali = evaluateVessel(vessel({ flag: 'India', lat: 0, lon: 50 }), vessel({ flag: 'India', lat: 20, lon: 48 }), ctx()).find((x) => x.ruleId === 'indian_critical_zone');
    expect(somali?.severity).toBe('medium');
    const foreign = evaluateVessel(vessel({ lat: 13, lon: 48 }), vessel({ lat: 20, lon: 48 }), ctx()).find((x) => x.ruleId === 'high_risk_zone');
    expect(foreign?.severity).toBe('low');
    expect(rules(vessel({ flag: 'India', category: 'naval', lat: 13, lon: 48 }), vessel({ lat: 20, lon: 48 }))).not.toContain('indian_critical_zone');
  });

  it('alerts when an Indian vessel crosses into foreign waters: high for small craft, low for merchant ships, none on first sighting of a merchant', () => {
    const inside = { flag: 'India', lat: 22.0, lon: 67.05 } as const;
    const across = { flag: 'India', lat: 22.0, lon: 66.0 } as const;
    const small = evaluateVessel(vessel({ ...across, category: 'other' }), vessel({ ...inside, category: 'other' }), ctx()).find((x) => x.ruleId === 'indian_foreign_waters');
    expect(small?.severity).toBe('high');
    expect(small?.message).toMatch(/Pakistan/);
    const merchant = evaluateVessel(vessel({ ...across }), vessel({ ...inside }), ctx()).find((x) => x.ruleId === 'indian_foreign_waters');
    expect(merchant?.severity).toBe('low');
    expect(rules(vessel({ ...across }), undefined)).not.toContain('indian_foreign_waters');
    expect(rules(vessel({ lat: 22.0, lon: 66.0 }), vessel({ lat: 22.0, lon: 67.05 }))).not.toContain('indian_foreign_waters'); // foreign vessel: not this rule
  });

  it('classifies vessels as Indian, foreign or unknown', () => {
    expect(classOf({ flag: 'India' })).toBe('indian');
    expect(classOf({ flag: 'Liberia' })).toBe('foreign');
    expect(classOf({ flag: 'Unknown' })).toBe('unknown');
    expect(classOf({ flag: 'Liberia', origin: 'reported' })).toBe('unknown');
  });

  it('alerts when a foreign or unknown vessel starts APPROACHING the EEZ (closing, inside the approach window) but not for merchants', () => {
    let lon = 60;
    while (distanceToEezNm(15.5, lon) > 60) lon += 0.05;
    const cur = { lat: 15.5, lon, sog: 14 };
    const prev = { lat: 15.5, lon: lon - 0.05, sog: 14 };
    const unknown = evaluateVessel(vessel({ ...cur, flag: 'Unknown', category: 'other' }), vessel({ ...prev, flag: 'Unknown', category: 'other' }), ctx()).find((x) => x.ruleId === 'eez_approach');
    expect(unknown?.severity).toBe('medium');
    const warship = evaluateVessel(vessel({ ...cur, flag: 'China', category: 'naval' }), vessel({ ...prev, flag: 'China', category: 'naval' }), ctx()).find((x) => x.ruleId === 'eez_approach');
    expect(warship?.severity).toBe('medium');
    expect(rules(vessel({ ...cur }), vessel({ ...prev }))).not.toContain('eez_approach'); // routine merchant
    expect(rules(vessel({ ...cur, flag: 'India', category: 'other' }), vessel({ ...prev, flag: 'India', category: 'other' }))).not.toContain('eez_approach');
    // moving away: no alert
    expect(rules(vessel({ ...prev, flag: 'Unknown', category: 'other' }), vessel({ ...cur, flag: 'Unknown', category: 'other' }))).not.toContain('eez_approach');
  });

  it('alerts on entering the contiguous zone, graded by who is entering', () => {
    let lon = 79.7;
    while (lon > 79.0 && classifyZone(9.65, lon).zone !== 'contiguous') lon -= 0.01;
    expect(classifyZone(9.65, lon).zone).toBe('contiguous');
    const far = { lat: 15, lon: 62 };
    const unknown = evaluateVessel(vessel({ lat: 9.65, lon, flag: 'Unknown', category: 'other' }), vessel({ ...far, flag: 'Unknown', category: 'other' }), ctx()).find((x) => x.ruleId === 'contiguous_entry');
    expect(unknown?.severity).toBe('high');
    expect(rules(vessel({ lat: 9.65, lon, flag: 'India' }), vessel({ ...far, flag: 'India' }))).not.toContain('contiguous_entry');
  });

  it('flags unidentified vessels in the territorial sea as critical', () => {
    const f = evaluateVessel(vessel({ lat: 9.65, lon: 79.18, flag: 'Unknown', category: 'other', sog: 8 }), vessel({ lat: 15, lon: 62, flag: 'Unknown', category: 'other' }), ctx()).find((x) => x.ruleId === 'territorial_sea');
    expect(f?.severity).toBe('critical');
  });

  it('flags foreign vessels entering the 12 nm territorial sea, higher for fishing boats', () => {
    const prev = vessel({ lat: 15, lon: 62 });
    const merchant = evaluateVessel(vessel({ lat: 9.65, lon: 79.18, sog: 10 }), prev, ctx()).find((x) => x.ruleId === 'territorial_sea');
    expect(merchant?.severity).toBe('medium');
    const trawler = evaluateVessel(vessel({ lat: 9.65, lon: 79.18, sog: 6, category: 'fishing', flag: 'Sri Lanka' }), prev, ctx()).find((x) => x.ruleId === 'territorial_sea');
    expect(trawler?.severity).toBe('high');
    expect(rules(vessel({ lat: 9.65, lon: 79.18, flag: 'India' }), prev)).not.toContain('territorial_sea');
  });

  it('detects loitering from the trail', () => {
    const trail = Array.from({ length: 8 }, () => [15, 72] as [number, number]);
    expect(rules(vessel({ sog: 0.5, trail }), undefined)).toContain('loitering');
    expect(rules(vessel({ sog: 0.5, trail, flag: 'India' }), undefined)).not.toContain('loitering'); // Indian vessels at anchor are normal
  });

  it('detects implausible position jumps', () => {
    const prev = vessel({ lat: 10, lon: 72, lastSeen: 0 });
    const cur = vessel({ lat: 10, lon: 80, lastSeen: 120_000 });
    expect(rules(cur, prev)).toContain('position_jump');
  });

  it('fires geofence rule on entry', () => {
    const geofences = [{ id: 'g', name: 'Port', lat: 15, lon: 72, radiusNm: 20, createdBy: 'a' }];
    expect(rules(vessel({ lat: 15, lon: 72 }), vessel({ lat: 18, lon: 72 }), ctx({ geofences }))).toContain('geofence');
  });

  it('flags AIS gaps, higher inside the EEZ', () => {
    const silent = vessel({ lastSeen: 0 });
    const out = evaluateGaps([silent], ctx({ now: 40 * 60_000 }));
    expect(out[0]?.finding.severity).toBe('high');
    expect(evaluateGaps([silent], ctx({ now: 5 * 60_000 }))).toHaveLength(0);
  });
});

describe('Deduper', () => {
  it('suppresses repeats inside the cooldown and releases afterwards', () => {
    const d = new Deduper(1000);
    expect(d.allow('1', 'eez_entry', 0)).toBe(true);
    expect(d.allow('1', 'eez_entry', 500)).toBe(false);
    expect(d.allow('1', 'ais_gap', 500)).toBe(true);
    expect(d.allow('1', 'eez_entry', 1500)).toBe(true);
  });
});

describe('Hub', () => {
  it('ignores duplicate and out-of-order reports and builds trails', () => {
    const hub = new Hub();
    expect(hub.ingest({ mmsi: '419000001', lat: 10, lon: 75, ts: 2000 })).not.toBeNull();
    expect(hub.ingest({ mmsi: '419000001', lat: 10.1, lon: 75, ts: 2000 })).toBeNull();
    expect(hub.ingest({ mmsi: '419000001', lat: 10.1, lon: 75, ts: 1000 })).toBeNull();
    hub.ingest({ mmsi: '419000001', lat: 10.2, lon: 75, ts: 3000 });
    expect(hub.vessels.get('419000001')?.trail).toHaveLength(1);
  });

  it('evicts the stalest vessel at capacity', () => {
    const hub = new Hub(2);
    hub.ingest({ mmsi: '419000001', lat: 10, lon: 75, ts: 1000 });
    hub.ingest({ mmsi: '419000002', lat: 10, lon: 75, ts: 5000 });
    hub.ingest({ mmsi: '419000003', lat: 10, lon: 75, ts: 6000 });
    expect(hub.vessels.has('419000001')).toBe(false);
    expect(hub.vessels.size).toBe(2);
  });

  it('runs the full demo scenario and raises the scripted alerts', () => {
    const hub = new Hub();
    const sim = new Simulator();
    for (let i = 0; i < 90; i++) {
      for (const r of sim.tick()) hub.ingest(r, sim.now);
      hub.sweepGaps(sim.now);
    }
    const seen = new Set(hub.alerts.map((a) => a.ruleId));
    for (const r of ['eez_approach', 'eez_entry', 'contiguous_entry', 'high_risk_zone', 'indian_critical_zone', 'indian_foreign_waters', 'territorial_sea', 'ais_gap', 'loitering', 'position_jump'] as const) {
      expect(seen.has(r), `expected ${r} alert`).toBe(true);
    }
    expect(hub.snapshot().vessels.every((v) => v.trail.length === 0)).toBe(true);
  });

  it('alert lifecycle writes the audit log', () => {
    const hub = new Hub();
    hub.ingest({ mmsi: '636000001', lat: 13, lon: 48, ts: 1000 }, 1000);
    const a = hub.alerts[0];
    expect(a).toBeDefined();
    expect(hub.updateAlert(a!.id, 'acknowledged', 'analyst', 'checked')?.status).toBe('acknowledged');
    expect(hub.audit[0]?.action).toBe('alert.acknowledged');
    expect(hub.updateAlert('nope', 'resolved', 'x')).toBeNull();
  });
});
