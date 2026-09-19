import { describe, expect, it } from 'vitest';
import {
  berlinDay,
  berlinDayStart,
  berlinOffset,
  hourStart,
  nextDay,
  parseDay,
  splitByDay,
} from './time.js';

const utc = (iso: string) => Date.parse(iso) / 1000;

describe('berlinOffset', () => {
  it('is +1h in winter and +2h in summer', () => {
    expect(berlinOffset(utc('2026-01-15T12:00:00Z'))).toBe(3600);
    expect(berlinOffset(utc('2026-07-15T12:00:00Z'))).toBe(7200);
  });

  it('switches exactly at 01:00 UTC on DST days', () => {
    expect(berlinOffset(utc('2026-03-29T00:59:59Z'))).toBe(3600);
    expect(berlinOffset(utc('2026-03-29T01:00:00Z'))).toBe(7200);
    expect(berlinOffset(utc('2026-10-25T00:59:59Z'))).toBe(7200);
    expect(berlinOffset(utc('2026-10-25T01:00:00Z'))).toBe(3600);
  });
});

describe('berlinDay', () => {
  it('uses the Berlin calendar date', () => {
    expect(berlinDay(utc('2026-09-18T21:59:59Z'))).toBe(20260918);
    expect(berlinDay(utc('2026-09-18T22:00:00Z'))).toBe(20260919); // 00:00 CEST
    expect(berlinDay(utc('2026-01-01T22:59:59Z'))).toBe(20260101);
    expect(berlinDay(utc('2026-01-01T23:00:00Z'))).toBe(20260102); // 00:00 CET
  });
});

describe('berlinDayStart / nextDay', () => {
  it('returns Berlin midnight in UTC', () => {
    expect(berlinDayStart(20260919)).toBe(utc('2026-09-18T22:00:00Z'));
    expect(berlinDayStart(20260102)).toBe(utc('2026-01-01T23:00:00Z'));
  });

  it('handles month and year boundaries', () => {
    expect(nextDay(20260228)).toBe(20260301);
    expect(nextDay(20281231)).toBe(20290101);
    expect(nextDay(20280228)).toBe(20280229);
  });

  it('has 23 hours on the spring and 25 hours on the autumn DST day', () => {
    expect(berlinDayStart(20260330) - berlinDayStart(20260329)).toBe(23 * 3600);
    expect(berlinDayStart(20261026) - berlinDayStart(20261025)).toBe(25 * 3600);
    expect(berlinDayStart(20260920) - berlinDayStart(20260919)).toBe(24 * 3600);
  });
});

describe('splitByDay', () => {
  it('keeps an interval within one day intact', () => {
    const start = utc('2026-09-19T08:00:00Z');
    expect(splitByDay(start, start + 3600)).toEqual([{ day: 20260919, seconds: 3600 }]);
  });

  it('splits at Berlin midnight', () => {
    // 23:30–00:30 CEST
    expect(splitByDay(utc('2026-09-18T21:30:00Z'), utc('2026-09-18T22:30:00Z'))).toEqual([
      { day: 20260918, seconds: 1800 },
      { day: 20260919, seconds: 1800 },
    ]);
  });

  it('covers multi-day intervals including DST days', () => {
    const pieces = splitByDay(berlinDayStart(20261024), berlinDayStart(20261027));
    expect(pieces).toEqual([
      { day: 20261024, seconds: 24 * 3600 },
      { day: 20261025, seconds: 25 * 3600 },
      { day: 20261026, seconds: 24 * 3600 },
    ]);
  });

  it('returns nothing for empty intervals', () => {
    expect(splitByDay(100, 100)).toEqual([]);
    expect(splitByDay(100, 50)).toEqual([]);
  });
});

describe('parseDay', () => {
  it('accepts valid dates and rejects invalid ones', () => {
    expect(parseDay('2026-09-19')).toBe(20260919);
    expect(parseDay('2028-02-29')).toBe(20280229);
    expect(parseDay('2026-02-29')).toBeUndefined();
    expect(parseDay('2026-13-01')).toBeUndefined();
    expect(parseDay('19.09.2026')).toBeUndefined();
  });
});

describe('hourStart', () => {
  it('floors to the UTC hour', () => {
    expect(hourStart(utc('2026-09-19T08:59:59Z'))).toBe(utc('2026-09-19T08:00:00Z'));
    expect(hourStart(utc('2026-09-19T08:00:00Z'))).toBe(utc('2026-09-19T08:00:00Z'));
  });
});
