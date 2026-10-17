import { describe, expect, it } from 'vitest';
import {
  activityCovered,
  comparisonWindows,
  dayCount,
  perUnit,
  precedingRange,
  rankChange,
  sameDayLastYear,
  trend,
} from './trends.js';

describe('trend', () => {
  it('rises, falls and stays flat within the dead band', () => {
    expect(trend(120, 100)).toEqual({
      current: 120,
      previous: 100,
      change: 20,
      changePct: 20,
      direction: 'up',
    });
    expect(trend(80, 100).direction).toBe('down');
    expect(trend(104, 100).direction).toBe('flat');
    expect(trend(96, 100).direction).toBe('flat');
    expect(trend(105, 100).direction).toBe('up');
  });

  it('has no percentage when there was nothing before', () => {
    expect(trend(5, 0)).toMatchObject({ change: 5, changePct: null, direction: 'up' });
    expect(trend(0, 0)).toMatchObject({ change: 0, changePct: null, direction: 'flat' });
  });

  it('accepts another dead band', () => {
    expect(trend(108, 100, 10).direction).toBe('flat');
  });
});

describe('comparisonWindows', () => {
  it('compares the last 7 days (without today) with the 7 days before', () => {
    expect(comparisonWindows('week', 20260919)).toEqual({
      current: { fromDay: 20260912, toDay: 20260918 },
      previous: { fromDay: 20260905, toDay: 20260911 },
    });
  });

  it('compares the last 30 days with the 30 days before, across month ends', () => {
    expect(comparisonWindows('month', 20260301)).toEqual({
      current: { fromDay: 20260130, toDay: 20260228 },
      previous: { fromDay: 20251231, toDay: 20260129 },
    });
  });

  it('compares with the same days of the previous year', () => {
    expect(comparisonWindows('year', 20260919)).toEqual({
      current: { fromDay: 20260820, toDay: 20260918 },
      previous: { fromDay: 20250820, toDay: 20250918 },
    });
  });

  it('crosses the DST switch without losing a day', () => {
    const { current } = comparisonWindows('week', 20261101);
    expect(current).toEqual({ fromDay: 20261025, toDay: 20261031 });
    expect(dayCount(current)).toBe(7);
  });
});

describe('sameDayLastYear', () => {
  it('maps 29 February to 28 February', () => {
    expect(sameDayLastYear(20280229)).toBe(20270228);
    expect(sameDayLastYear(20290301)).toBe(20280301);
  });
});

describe('precedingRange', () => {
  it('returns the period of the same length right before', () => {
    expect(precedingRange({ fromDay: 20260913, toDay: 20260919 })).toEqual({
      fromDay: 20260906,
      toDay: 20260912,
    });
    expect(precedingRange({ fromDay: 20260919, toDay: 20260919 })).toEqual({
      fromDay: 20260918,
      toDay: 20260918,
    });
  });
});

describe('helpers', () => {
  it('only compares activity when most of the time was measured', () => {
    expect(activityCovered(0, 0)).toBe(true);
    expect(activityCovered(1000, 50)).toBe(true);
    expect(activityCovered(1000, 200)).toBe(false);
  });

  it('divides without NaN', () => {
    expect(perUnit(10, 0)).toBe(0);
    expect(perUnit(10, 4)).toBe(2.5);
  });

  it('counts places gained as positive', () => {
    expect(rankChange(2, 5)).toBe(3);
    expect(rankChange(5, 2)).toBe(-3);
    expect(rankChange(1, undefined)).toBeNull();
  });
});
