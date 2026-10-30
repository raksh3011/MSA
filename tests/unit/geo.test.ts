import { describe, expect, it } from 'vitest';
import { checkBoundary } from '../../src/core/boundary';
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

describe('boundary safety', () => {
  it('rejects invalid coordinates', () => {
    expect(checkBoundary(200, 0)).toBeNull();
  });
  it('is safe deep in Indian waters', () => {
    expect(checkBoundary(15, 72)?.level).toBe('safe');
  });
  it('reports crossed on the far side of the line', () => {
    expect(checkBoundary(22.0, 63.5)?.level).toBe('crossed');
  });
  it('warns when close to the boundary on the Indian side', () => {
    const s = checkBoundary(22.0, 65.3);
    expect(s?.indianSide).toBe(true);
    expect(['caution', 'danger']).toContain(s?.level);
  });
});
