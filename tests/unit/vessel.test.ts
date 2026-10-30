import { describe, expect, it } from 'vitest';
import { categoryFromShipType, flagFromMmsi, normalizeReport } from '../../src/core/vessel';

describe('vessel normalisation', () => {
  it('maps AIS ship types to categories (naval code is not swallowed by fishing range)', () => {
    expect(categoryFromShipType(35)).toBe('naval');
    expect(categoryFromShipType(30)).toBe('fishing');
    expect(categoryFromShipType(72)).toBe('cargo');
    expect(categoryFromShipType(84)).toBe('tanker');
    expect(categoryFromShipType(65)).toBe('passenger');
    expect(categoryFromShipType(undefined)).toBe('other');
  });

  it('infers the flag from the MMSI MID', () => {
    expect(flagFromMmsi('419123456')).toBe('India');
    expect(flagFromMmsi('636092001')).toBe('Liberia');
    expect(flagFromMmsi('999000000')).toBe('Unknown');
  });

  it('accepts a valid report', () => {
    const v = normalizeReport({ mmsi: '419000001', lat: 10, lon: 75, sog: 12, shipType: 70, name: ' MV Test ' }, 1000);
    expect(v).toMatchObject({ name: 'MV Test', category: 'cargo', flag: 'India', sog: 12, lastSeen: 1000 });
  });

  it.each([
    ['bad mmsi', { mmsi: '123', lat: 10, lon: 75 }],
    ['null island', { mmsi: '419000001', lat: 0, lon: 0 }],
    ['out of range', { mmsi: '419000001', lat: 95, lon: 75 }],
    ['not-available speed', { mmsi: '419000001', lat: 10, lon: 75, sog: 102.3 }],
    ['NaN lat', { mmsi: '419000001', lat: NaN, lon: 75 }],
  ])('rejects %s', (_n, r) => {
    expect(normalizeReport(r)).toBeNull();
  });

  it('strips non-printable characters from names', () => {
    expect(normalizeReport({ mmsi: '419000001', lat: 10, lon: 75, name: 'A\u0000BéC' })?.name).toBe('ABC');
  });
});
