import { describe, expect, it } from 'vitest';
import { checkBoundary, classifyZone } from '../../src/core/boundary';
import { BOUNDARIES, CONTIGUOUS_POLYS, EEZ_POLYS, FOREIGN_WATERS, INDIA_EEZ, TERRITORIAL_POLYS, TERRITORIAL_SEA } from '../../src/core/zones';
import { bearingDeg, destination, distanceNm, distanceToLineNm, isValidCoord, pointInPolygon } from '../../src/core/geo';

describe('geo', () => {
  it('computes great-circle distance (1 degree of latitude ~ 60 nm)', () => {
    expect(distanceNm([0, 0], [1, 0])).toBeCloseTo(60.04, 1);
    expect(distanceNm([10, 70], [10, 70])).toBe(0);
  });

  it('point-in-polygon distinguishes inside and outside', () => {
    const square: Array<[number, number]> = [[0, 0], [0, 10], [10, 10], [10, 0]];
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(15, 5, square)).toBe(false);
  });

  it('validates coordinates', () => {
    expect(isValidCoord(12, 77)).toBe(true);
    expect(isValidCoord(91, 0)).toBe(false);
    expect(isValidCoord(NaN, 0)).toBe(false);
  });

  it('distance to a line is zero on the line and positive off it', () => {
    const line: Array<[number, number]> = [[0, 0], [0, 10]];
    expect(distanceToLineNm(0, 5, line)).toBeCloseTo(0, 5);
    expect(distanceToLineNm(1, 5, line)).toBeCloseTo(60, 0);
  });

  it('destination and bearing are consistent', () => {
    const p = destination([10, 70], 90, 60);
    expect(bearingDeg([10, 70], p)).toBeCloseTo(90, 0);
    expect(distanceNm([10, 70], p)).toBeCloseTo(60, 1);
  });
});

describe('boundary safety (modelled zones)', () => {
  it('rejects invalid coordinates', () => {
    expect(checkBoundary(200, 0)).toBeNull();
  });
  it('is safe deep in Indian waters and classifies the zone', () => {
    const s = checkBoundary(15, 72);
    expect(s?.level).toBe('safe');
    expect(s?.zone).toBe('eez');
  });
  it('classifies territorial sea, foreign waters and open sea', () => {
    expect(classifyZone(9.65, 79.18).zone).toBe('territorial');
    expect(classifyZone(22.0, 66.0)).toEqual({ zone: 'foreign', country: 'Pakistan' });
    expect(classifyZone(13, 58).zone).toBe('high_seas');
  });
  it('reports crossed, naming the neighbouring state', () => {
    const s = checkBoundary(22.0, 66.0);
    expect(s?.level).toBe('crossed');
    expect(s?.country).toBe('Pakistan');
    expect(s?.indianSide).toBe(false);
  });
  it('warns when close to the boundary on the Indian side', () => {
    const s = checkBoundary(22.0, 67.05);
    expect(s?.indianSide).toBe(true);
    expect(['caution', 'danger']).toContain(s?.level);
  });
});

describe('zone data', () => {
  it('has real geometry for every layer', () => {
    expect(TERRITORIAL_POLYS.length).toBeGreaterThan(3);
    expect(CONTIGUOUS_POLYS.length).toBeGreaterThan(3);
    expect(EEZ_POLYS.length).toBeGreaterThan(1);
    expect(FOREIGN_WATERS.map((f) => f.name)).toEqual(expect.arrayContaining(['Pakistan', 'Sri Lanka', 'Bangladesh']));
    expect(BOUNDARIES.length).toBeGreaterThan(3);
  });
  it('nests territorial sea inside the EEZ', () => {
    expect(TERRITORIAL_SEA.contains(9.65, 79.18)).toBe(true);
    expect(INDIA_EEZ.contains(9.65, 79.18)).toBe(true);
  });
});
