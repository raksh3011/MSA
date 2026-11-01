import { describe, expect, it } from 'vitest';
import { csvCell } from '../../src/api/csv';
import { RateLimiter } from '../../src/api/ratelimit';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../../src/core/auth';
import { parseAisMessage } from '../../src/worker/ais';

describe('auth', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('signs and verifies tokens, rejecting tampering, wrong secret and expiry', async () => {
    const t = await signToken({ sub: 'admin', role: 'admin' }, 'secret', 60, 0);
    expect((await verifyToken(t, 'secret', 1000))?.sub).toBe('admin');
    expect(await verifyToken(t, 'other', 1000)).toBeNull();
    expect(await verifyToken(t, 'secret', 61_000)).toBeNull();
    expect(await verifyToken(t.slice(0, -2) + 'xx', 'secret', 1000)).toBeNull();
    expect(await verifyToken('a.b', 'secret')).toBeNull();
  });
});

describe('helpers', () => {
  it('neutralises CSV formula injection and quotes special characters', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(undefined)).toBe('');
  });

  it('rate limiter blocks after the limit and resets after the window', () => {
    const r = new RateLimiter(2, 1000);
    expect([r.allow('k', 0), r.allow('k', 1), r.allow('k', 2)]).toEqual([true, true, false]);
    expect(r.allow('k', 1500)).toBe(true);
  });

  it('parses aisstream messages defensively', () => {
    const pos = parseAisMessage(
      JSON.stringify({
        MessageType: 'PositionReport',
        MetaData: { MMSI: 419000001, ShipName: 'TEST ', time_utc: '2026-10-30 06:00:00.123 +0000 UTC' },
        Message: { PositionReport: { Latitude: 10, Longitude: 75, Sog: 5, Cog: 90, TrueHeading: 511 } },
      }),
    );
    expect(pos).toMatchObject({ kind: 'position', report: { mmsi: '419000001', lat: 10, heading: undefined } });
    const st = parseAisMessage(
      JSON.stringify({ MessageType: 'ShipStaticData', MetaData: { MMSI: 419000001 }, Message: { ShipStaticData: { Name: 'X', Type: 70 } } }),
    );
    expect(st).toMatchObject({ kind: 'static', shipType: 70 });
    expect(parseAisMessage('not json')).toBeNull();
    expect(parseAisMessage('{"MetaData":{"MMSI":1}}')).toBeNull();
  });
});
