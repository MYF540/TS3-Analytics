import { describe, expect, it } from 'vitest';
import {
  cohorts,
  mergeActivity,
  monthlyBalance,
  personSummary,
  RETURNING_GAP_DAYS,
  type PersonActivity,
} from './loyalty.js';
import { berlinDay, berlinDayStart } from './time.js';

const H = 3600;

/** The day `n` days after `day`. */
function plus(day: number, n: number): number {
  return berlinDay(berlinDayStart(day) + n * 86_400 + 12 * H);
}

function person(subject: number, days: number[], seconds = H): PersonActivity {
  return { subject, days, seconds: days.map(() => seconds) };
}

describe('cohorts', () => {
  it('groups persons by month of their first visit', () => {
    const rows = cohorts(
      [
        person(1, [20260105]),
        person(2, [20260120, 20260301]),
        person(3, [20260210]),
        person(4, []),
      ],
      20261016,
    );
    expect(rows.map((r) => [r.month, r.size])).toEqual([
      [202601, 2],
      [202602, 1],
    ]);
  });

  it('counts a return exactly on day N, not one day before', () => {
    const first = 20260101;
    const rows = cohorts(
      [person(1, [first, plus(first, 6)]), person(2, [first, plus(first, 7)])],
      20261016,
    );
    expect(rows[0]).toMatchObject({ size: 2, eligible: [2, 2, 2], returned: [1, 0, 0] });
    const later = cohorts([person(1, [first, plus(first, 90)])], 20261016);
    expect(later[0]?.returned).toEqual([1, 1, 1]);
  });

  it('only counts persons whose first visit is long enough ago', () => {
    const today = 20261016;
    const rows = cohorts([person(1, [plus(today, -10)]), person(2, [plus(today, -40)])], today);
    const october = rows.find((r) => r.month === 202610);
    const september = rows.find((r) => r.month === 202609);
    expect(october).toMatchObject({ size: 1, eligible: [1, 0, 0], returned: [0, 0, 0] });
    expect(september).toMatchObject({ size: 1, eligible: [1, 1, 0] });
  });

  it('is empty without persons and skips persons without days', () => {
    expect(cohorts([], 20261016)).toEqual([]);
    expect(cohorts([person(1, [])], 20261016)).toEqual([]);
  });

  it('counts linked accounts as one person', () => {
    // The second account carries the return after 30 days.
    const merged = mergeActivity(1, [person(1, [20260101]), person(5, [20260101, 20260205])]);
    expect(merged).toEqual({ subject: 1, days: [20260101, 20260205], seconds: [2 * H, H] });
    const rows = cohorts([merged], 20261016);
    expect(rows[0]).toMatchObject({ size: 1, returned: [1, 1, 0] });
  });

  it('uses calendar days across the summer time switch', () => {
    // 2026-03-29 is the switch to summer time.
    const rows = cohorts([person(1, [20260322, 20260329])], 20261016);
    expect(rows[0]?.returned).toEqual([1, 0, 0]);
  });
});

describe('monthlyBalance', () => {
  it('counts active, new, returning and lost persons per month', () => {
    const today = 20261016;
    const rows = monthlyBalance(
      [
        // New in January, active again in February, then gone.
        person(1, [20260110, 20260205]),
        // New in January, back in April and again in October, each after a long pause.
        person(2, [20260115, plus(20260115, RETURNING_GAP_DAYS + 1), 20261010]),
        // New in October, still around.
        person(3, [20261001]),
      ],
      today,
    );
    const by = (month: number) => rows.find((r) => r.month === month);
    expect(by(202601)).toEqual({ month: 202601, active: 2, new: 2, returning: 0, lost: 0 });
    expect(by(202602)).toEqual({ month: 202602, active: 1, new: 0, returning: 0, lost: 1 });
    // Months in between are there, even when nobody was online.
    expect(by(202603)).toEqual({ month: 202603, active: 0, new: 0, returning: 0, lost: 0 });
    expect(by(202604)).toMatchObject({ active: 1, returning: 1 });
    expect(by(202610)).toEqual({ month: 202610, active: 2, new: 1, returning: 1, lost: 0 });
    expect(rows.at(-1)?.month).toBe(202610);
  });

  it('does not call somebody lost before 30 days without a visit', () => {
    const rows = monthlyBalance([person(1, [20260920])], 20261019);
    expect(rows.find((r) => r.month === 202609)?.lost).toBe(0);
    const later = monthlyBalance([person(1, [20260920])], 20261020);
    expect(later.find((r) => r.month === 202609)?.lost).toBe(1);
  });

  it('counts a pause of 89 days not as a return', () => {
    const rows = monthlyBalance([person(1, [20260101, plus(20260101, 90)])], 20261016);
    expect(rows.every((r) => r.returning === 0)).toBe(true);
  });

  it('runs across the turn of the year', () => {
    const rows = monthlyBalance([person(1, [20251215, 20260105])], 20260110);
    expect(rows.map((r) => r.month)).toEqual([202512, 202601]);
  });

  it('is empty without data', () => {
    expect(monthlyBalance([], 20261016)).toEqual([]);
  });
});

describe('personSummary', () => {
  it('sums the time of the 90 days up to the last visit', () => {
    const last = 20261001;
    const summary = personSummary({
      subject: 7,
      days: [plus(last, -90), plus(last, -89), last],
      seconds: [H, 2 * H, 3 * H],
    });
    expect(summary).toEqual({
      subject: 7,
      firstDay: plus(last, -90),
      lastDay: last,
      recentS: 5 * H,
      totalS: 6 * H,
    });
    expect(personSummary(person(1, []))).toBeUndefined();
  });
});
