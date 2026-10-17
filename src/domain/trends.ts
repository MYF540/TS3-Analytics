/**
 * Trends: compares a figure of a recent period with the same figure of an earlier period (pure).
 * Days are Berlin calendar days (YYYYMMDD). Periods end yesterday, because today is not over
 * yet and would always look like a drop.
 */
import { daysBefore } from './periods.js';
import { berlinDayStart } from './time.js';

export const TREND_COMPARISONS = ['week', 'month', 'year'] as const;
/**
 * `week`: last 7 days vs. the 7 days before; `month`: last 30 days vs. the 30 days before;
 * `year`: last 30 days vs. the same 30 calendar days one year earlier.
 */
export type TrendComparison = (typeof TREND_COMPARISONS)[number];

export type TrendDirection = 'up' | 'flat' | 'down';

/** Changes smaller than this (in percent of the earlier value) count as "flat". */
export const FLAT_THRESHOLD_PCT = 5;

export interface DayRange {
  fromDay: number;
  toDay: number;
}

export interface Trend {
  current: number;
  previous: number;
  /** `current - previous`. */
  change: number;
  /** Relative change in percent; null when the earlier value is 0. */
  changePct: number | null;
  direction: TrendDirection;
}

/** The same calendar day one year earlier; 29 February becomes 28 February. */
export function sameDayLastYear(day: number): number {
  const year = Math.floor(day / 10000) - 1;
  const month = Math.floor(day / 100) % 100;
  const dayOfMonth = day % 100;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const clamped = month === 2 && dayOfMonth === 29 && !leap ? 28 : dayOfMonth;
  return year * 10000 + month * 100 + clamped;
}

/** The current and the earlier period of a comparison, both ending before `today`. */
export function comparisonWindows(
  comparison: TrendComparison,
  today: number,
): { current: DayRange; previous: DayRange } {
  const length = comparison === 'week' ? 7 : 30;
  const toDay = daysBefore(today, 1);
  const current = { fromDay: daysBefore(toDay, length - 1), toDay };
  if (comparison === 'year') {
    return {
      current,
      previous: { fromDay: sameDayLastYear(current.fromDay), toDay: sameDayLastYear(toDay) },
    };
  }
  const previousTo = daysBefore(current.fromDay, 1);
  return { current, previous: { fromDay: daysBefore(previousTo, length - 1), toDay: previousTo } };
}

/** Number of days in `range` (inclusive). */
export function dayCount(range: DayRange): number {
  return Math.round((berlinDayStart(range.toDay) - berlinDayStart(range.fromDay)) / 86_400) + 1;
}

/** The period of the same length right before `range` (for leaderboards). */
export function precedingRange(range: DayRange): DayRange {
  const length = dayCount(range);
  const toDay = daysBefore(range.fromDay, 1);
  return { fromDay: daysBefore(toDay, length - 1), toDay };
}

/** Direction of a change from `previous` to `current`, with a dead band of `flatPct` percent. */
export function trend(current: number, previous: number, flatPct = FLAT_THRESHOLD_PCT): Trend {
  const change = current - previous;
  const changePct = previous === 0 ? null : (change / Math.abs(previous)) * 100;
  let direction: TrendDirection;
  if (change === 0) direction = 'flat';
  else if (changePct === null) direction = change > 0 ? 'up' : 'down';
  else if (Math.abs(changePct) < flatPct) direction = 'flat';
  else direction = change > 0 ? 'up' : 'down';
  return { current, previous, change, changePct, direction };
}

/**
 * Activity states (active/idle/AFK) only exist for times the watcher recorded itself; imported
 * sessions count as "unknown". A comparison of active time is only fair when both periods were
 * mostly measured, otherwise imported periods would look like a collapse of activity.
 */
export const MIN_ACTIVITY_COVERAGE = 0.9;

export function activityCovered(onlineS: number, unknownS: number): boolean {
  if (onlineS <= 0) return true;
  return 1 - unknownS / onlineS >= MIN_ACTIVITY_COVERAGE;
}

/** Ratio that is 0 instead of NaN for an empty denominator. */
export function perUnit(value: number, count: number): number {
  return count > 0 ? value / count : 0;
}

/** Rank movement in a leaderboard: positive = moved up. Null when not ranked before. */
export function rankChange(currentRank: number, previousRank: number | undefined): number | null {
  return previousRank === undefined ? null : previousRank - currentRank;
}
