import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, Deduper, evaluateGaps, evaluateVessel, type RuleContext } from '../../src/core/engine';
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
    expect(rules(vessel({ category: 'naval', lat: 17.2, lon: 70.5 }), vessel({ lat: 17.2, lon: 62 }))).not.toContain('eez_entry');
  });

  it('escalates to critical for a fast vessel of a flag of interest', () => {
    const policy = { ...DEFAULT_POLICY, flagsOfInterest: ['Liberia'] };
    const f = evaluateVessel(vessel({ sog: 30, lat: 17.2, lon: 70.5 }), vessel({ lat: 17.2, lon: 62 }), ctx({ policy }));
    expect(f.find((x) => x.ruleId === 'eez_entry')?.severity).toBe('critical');
  });

  it('flags high speed inside the EEZ only once', () => {
    const fast = vessel({ sog: 30 });
    expect(rules(fast, undefined)).toContain('high_speed_in_eez');
    expect(rules(fast, fast)).not.toContain('high_speed_in_eez');
  });

  it('flags entry into a high-risk zone, with severity following the zone level', () => {
    const aden = evaluateVessel(vessel({ lat: 13, lon: 48 }), vessel({ lat: 20, lon: 48 }), ctx()).find((x) => x.ruleId === 'high_risk_zone');
    expect(aden?.severity).toBe('high');
    const somali = evaluateVessel(vessel({ lat: 0, lon: 50 }), vessel({ lat: 20, lon: 48 }), ctx()).find((x) => x.ruleId === 'high_risk_zone');
    expect(somali?.severity).toBe('medium');
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
    expect(rules(vessel({ sog: 0.5, trail, category: 'fishing' }), undefined)).not.toContain('loitering');
  });

  it('detects implausible position jumps', () => {
    const prev = vessel({ lat: 10, lon: 72, lastSeen: 0 });
    const cur = vessel({ lat: 10, lon: 80, lastSeen: 120_000 });
    expect(rules(cur, prev)).toContain('position_jump');
  });

  it('warns a fishing vessel approaching and crossing the boundary', () => {
    const near = vessel({ category: 'fishing', flag: 'India', lat: 22.0, lon: 67.05 });
    const far = vessel({ category: 'fishing', flag: 'India', lat: 20, lon: 70 });
    expect(rules(near, far)).toContain('fishing_boundary');
    const crossed = vessel({ category: 'fishing', flag: 'India', lat: 22.0, lon: 66.0 });
    const msg = evaluateVessel(crossed, near, ctx()).find((x) => x.ruleId === 'fishing_boundary');
    expect(msg?.message).toMatch(/crossed.*Pakistan/);
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
    for (let i = 0; i < 160; i++) {
      for (const r of sim.tick()) hub.ingest(r, sim.now);
      hub.sweepGaps(sim.now);
    }
    const seen = new Set(hub.alerts.map((a) => a.ruleId));
    for (const r of ['eez_entry', 'high_risk_zone', 'territorial_sea', 'ais_gap', 'loitering', 'position_jump', 'fishing_boundary'] as const) {
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
