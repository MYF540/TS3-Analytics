/**
 * Retention and churn (T13.1): pure functions over the days a person was online. The daily job
 * (`src/loyalty/job.ts`) feeds them and stores the result; the page only reads stored rows.
 *
 * A person is "active" on a day with any online time (imported sessions count: for retention it
 * only matters whether somebody was there). Months are calendar months in Europe/Berlin (YYYYMM).
 */
import { dayNumber } from './time.js';

/** Days after the first visit at which the return is checked. */
export const RETURN_AFTER_DAYS = [7, 30, 90] as const;

/** A pause of at least this many days makes the next visit a return. */
export const RETURNING_GAP_DAYS = 90;

/** Not seen for this many days: counted as lost in the month of the last visit. */
export const LOST_AFTER_DAYS = 30;

/** "Regulars": online time in this many days up to the last visit. */
export const RECENT_WINDOW_DAYS = 90;

export interface PersonActivity {
  subject: number;
  /** Ascending Berlin days (YYYYMMDD) with online time. */
  days: readonly number[];
  /** Online seconds per entry of `days`. */
  seconds: readonly number[];
}

export const monthOf = (day: number): number => Math.floor(day / 100);

function nextMonth(month: number): number {
  return month % 100 === 12 ? (Math.floor(month / 100) + 1) * 100 + 1 : month + 1;
}

export interface CohortRow {
  /** YYYYMM of the first visit. */
  month: number;
  size: number;
  /** Per entry of `RETURN_AFTER_DAYS`: persons whose first visit is long enough ago … */
  eligible: number[];
  /** … and how many of them were online again on that day after the first visit or later. */
  returned: number[];
}

/** Persons by month of their first visit, and how many came back after 7, 30 and 90 days. */
export function cohorts(persons: Iterable<PersonActivity>, today: number): CohortRow[] {
  const todayN = dayNumber(today);
  const rows = new Map<number, CohortRow>();
  for (const person of persons) {
    const first = person.days[0];
    const last = person.days.at(-1);
    if (first === undefined || last === undefined) continue;
    const month = monthOf(first);
    let row = rows.get(month);
    if (!row) {
      row = {
        month,
        size: 0,
        eligible: RETURN_AFTER_DAYS.map(() => 0),
        returned: RETURN_AFTER_DAYS.map(() => 0),
      };
      rows.set(month, row);
    }
    row.size += 1;
    const firstN = dayNumber(first);
    const lastN = dayNumber(last);
    RETURN_AFTER_DAYS.forEach((n, i) => {
      if (todayN - firstN < n) return;
      row.eligible[i] = (row.eligible[i] ?? 0) + 1;
      // The last day is the latest visit; enough to know whether any visit is that late.
      if (lastN - firstN >= n) row.returned[i] = (row.returned[i] ?? 0) + 1;
    });
  }
  return [...rows.values()].sort((a, b) => a.month - b.month);
}

export interface MonthRow {
  month: number;
  /** Persons online in this month. */
  active: number;
  /** Of these, persons whose first visit was in this month. */
  new: number;
  /** Of these, persons back after a pause of at least `RETURNING_GAP_DAYS`. */
  returning: number;
  /** Persons whose last visit was in this month and who have not been seen for 30 days. */
  lost: number;
}

/** Active, new, returning and lost persons per month, from the first month up to `today`. */
export function monthlyBalance(persons: Iterable<PersonActivity>, today: number): MonthRow[] {
  const todayN = dayNumber(today);
  const rows = new Map<number, MonthRow>();
  const row = (month: number) => {
    let r = rows.get(month);
    if (!r) {
      r = { month, active: 0, new: 0, returning: 0, lost: 0 };
      rows.set(month, r);
    }
    return r;
  };
  for (const person of persons) {
    const { days } = person;
    const first = days[0];
    const last = days.at(-1);
    if (first === undefined || last === undefined) continue;
    row(monthOf(first)).new += 1;
    let previousMonth: number | undefined;
    let previousN: number | undefined;
    let returnedIn: number | undefined;
    for (const day of days) {
      const month = monthOf(day);
      const n = dayNumber(day);
      if (month !== previousMonth) {
        row(month).active += 1;
        previousMonth = month;
      }
      if (
        previousN !== undefined &&
        n - previousN - 1 >= RETURNING_GAP_DAYS &&
        returnedIn !== month
      ) {
        row(month).returning += 1;
        returnedIn = month;
      }
      previousN = n;
    }
    if (todayN - dayNumber(last) >= LOST_AFTER_DAYS) row(monthOf(last)).lost += 1;
  }
  if (rows.size === 0) return [];
  // Months without anybody still belong on the chart.
  const months = [...rows.keys()];
  let month = Math.min(...months);
  const end = Math.max(monthOf(today), ...months);
  const result: MonthRow[] = [];
  while (month <= end) {
    result.push(rows.get(month) ?? { month, active: 0, new: 0, returning: 0, lost: 0 });
    month = nextMonth(month);
  }
  return result;
}

export interface PersonSummary {
  subject: number;
  firstDay: number;
  lastDay: number;
  /** Online seconds in the `RECENT_WINDOW_DAYS` days up to and including the last visit. */
  recentS: number;
  totalS: number;
}

export function personSummary(person: PersonActivity): PersonSummary | undefined {
  const first = person.days[0];
  const last = person.days.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const lastN = dayNumber(last);
  let recentS = 0;
  let totalS = 0;
  person.days.forEach((day, i) => {
    const seconds = person.seconds[i] ?? 0;
    totalS += seconds;
    if (lastN - dayNumber(day) < RECENT_WINDOW_DAYS) recentS += seconds;
  });
  return { subject: person.subject, firstDay: first, lastDay: last, recentS, totalS };
}

/** Combines the days of the accounts of one person (linked UIDs) into one activity. */
export function mergeActivity(
  subject: number,
  accounts: readonly PersonActivity[],
): PersonActivity {
  if (accounts.length === 1 && accounts[0]) return { ...accounts[0], subject };
  const byDay = new Map<number, number>();
  for (const account of accounts) {
    account.days.forEach((day, i) => {
      byDay.set(day, (byDay.get(day) ?? 0) + (account.seconds[i] ?? 0));
    });
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  return { subject, days, seconds: days.map((day) => byDay.get(day) ?? 0) };
}
