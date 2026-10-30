import { describe, expect, it } from 'vitest';
import { Hub } from '../../src/core/hub';
import { boxesFor, inBox, INDIA_BOX, minGapMs, parseRegion } from '../../src/worker/regions';

describe('live-AIS regions', () => {
  it('defaults to India + chokepoints and accepts world / indian-ocean', () => {
    expect(parseRegion(undefined)).toBe('india');
    expect(parseRegion('bogus')).toBe('india');
    expect(parseRegion('world')).toBe('world');
    expect(parseRegion('indian-ocean')).toBe('indian-ocean');
    expect(boxesFor('india').length).toBe(3);
    expect(boxesFor('world')).toEqual([[[-90, -180], [90, 180]]]);
  });

  it('the India box covers the whole modelled EEZ area, including Andaman & Nicobar and Lakshadweep', () => {
    for (const [lat, lon] of [[10.5, 72.6], [11.7, 92.7], [6.8, 93.8], [22, 66], [20, 88]] as const) {
      expect(inBox(lat, lon, INDIA_BOX)).toBe(true);
    }
    expect(inBox(60, 24, INDIA_BOX)).toBe(false);
  });

  it('keeps full rate near India and thins the rest of the world', () => {
    expect(minGapMs(15, 72)).toBe(10_000);
    expect(minGapMs(51.5, 0)).toBe(60_000);
  });
});

describe('feed health', () => {
  it('is part of every snapshot and resets with the source', () => {
    const hub = new Hub();
    hub.feed = { connected: false, error: 'Api Key Is Not Valid' };
    expect(hub.snapshot().feed?.error).toBe('Api Key Is Not Valid');
    hub.resetFeed('digitraffic');
    expect(hub.snapshot().feed).toEqual({ connected: true });
  });
});

describe('sparse live coverage handling', () => {
  it('evicts vessels outside the focus area first', () => {
    const hub = new Hub(2);
    hub.focus = (v) => v.lat < 30; // "India-like" focus
    hub.ingest({ mmsi: '419000001', lat: 10, lon: 75, ts: 1000 }); // focus, oldest
    hub.ingest({ mmsi: '244000002', lat: 52, lon: 4, ts: 5000 }); // outside
    hub.ingest({ mmsi: '244000003', lat: 53, lon: 5, ts: 6000 }); // outside, forces eviction
    expect(hub.vessels.has('419000001')).toBe(true);
    expect(hub.vessels.has('244000002')).toBe(false);
  });

  it('does not raise AIS-gap alerts for terrestrial aisstream data', () => {
    const hub = new Hub();
    hub.source = 'aisstream';
    hub.ingest({ mmsi: '636000001', lat: 15, lon: 72, sog: 12, ts: 0 }, 0);
    expect(hub.sweepGaps(40 * 60_000)).toBe(0);
    hub.source = 'simulated';
    expect(hub.sweepGaps(40 * 60_000)).toBeGreaterThan(0);
  });
});
