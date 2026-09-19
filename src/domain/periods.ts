/** Time ranges used by the API (pure). Days are Berlin calendar days (YYYYMMDD). */
import { berlinDay, berlinDayStart, nextDay } from './time.js';

export const LEADERBOARD_PERIODS = ['all', 'week', 'month', 'year', 'custom'] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

export const TIME_RANGES = ['24h', '7d', '30d', '1y', 'all'] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

const ROLLING_DAYS: Record<Exclude<LeaderboardPeriod, 'all' | 'custom'>, number> = {
  week: 7,
  month: 30,
  year: 365,
};

/** Berlin day `n` days before `day`. */
export function daysBefore(day: number, n: number): number {
  // Noon avoids DST edge cases when stepping back whole days.
  return berlinDay(berlinDayStart(day) + 12 * 3600 - n * 86_400);
}

/**
 * Rolling day range ending today (inclusive): week = last 7 days, month = 30, year = 365.
 * Returns undefined for `all` (use the all-time aggregates instead).
 */
export function rollingDays(
  period: LeaderboardPeriod,
  today: number,
): { fromDay: number; toDay: number } | undefined {
  if (period === 'all' || period === 'custom') return undefined;
  return { fromDay: daysBefore(today, ROLLING_DAYS[period] - 1), toDay: today };
}

/** `[from, to)` in UTC seconds for a dashboard range ending now; `all` starts at `firstData`. */
export function rangeSeconds(
  range: TimeRange,
  now: number,
  firstData: number,
): { from: number; to: number } {
  const span: Record<Exclude<TimeRange, 'all'>, number> = {
    '24h': 86_400,
    '7d': 7 * 86_400,
    '30d': 30 * 86_400,
    '1y': 365 * 86_400,
  };
  const from = range === 'all' ? Math.min(firstData, now) : now - span[range];
  return { from, to: now };
}

/** Start of the current Berlin day and of the next one (UTC seconds). */
export function todayBounds(now: number): { start: number; end: number } {
  const today = berlinDay(now);
  return { start: berlinDayStart(today), end: berlinDayStart(nextDay(today)) };
}
