import { describe, expect, it } from 'vitest';
import { daysBefore, rangeSeconds, rollingDays, todayBounds } from './periods.js';

const utc = (iso: string) => Date.parse(iso) / 1000;

describe('rollingDays', () => {
  it('ends today and counts today as the first day', () => {
    expect(rollingDays('week', 20260919)).toEqual({ fromDay: 20260913, toDay: 20260919 });
    expect(rollingDays('month', 20260919)).toEqual({ fromDay: 20260821, toDay: 20260919 });
    expect(rollingDays('year', 20260919)).toEqual({ fromDay: 20250920, toDay: 20260919 });
    expect(rollingDays('all', 20260919)).toBeUndefined();
  });

  it('steps across DST changes by calendar day', () => {
    expect(daysBefore(20260330, 1)).toBe(20260329);
    expect(daysBefore(20261026, 1)).toBe(20261025);
    expect(daysBefore(20260301, 1)).toBe(20260228);
  });
});

describe('rangeSeconds', () => {
  it('returns rolling windows and "all" from the first data point', () => {
    const now = utc('2026-09-19T12:00:00Z');
    expect(rangeSeconds('24h', now, 0)).toEqual({ from: now - 86_400, to: now });
    expect(rangeSeconds('all', now, now - 1000)).toEqual({ from: now - 1000, to: now });
  });
});

describe('todayBounds', () => {
  it('uses the Berlin day', () => {
    expect(todayBounds(utc('2026-09-18T22:30:00Z'))).toEqual({
      start: utc('2026-09-18T22:00:00Z'),
      end: utc('2026-09-19T22:00:00Z'),
    });
  });
});
