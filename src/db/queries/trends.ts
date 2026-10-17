/**
 * Figures for trend comparisons. Like the other statistics they only read the aggregate tables
 * (`user_daily_stats`, `server_hourly`) and `users` for bounded day ranges.
 */
import type Database from 'better-sqlite3';
import { berlinDayStart, nextDay } from '../../domain/time.js';
import { bySubject, daysPerUser, type LeaderboardMetric, personIds, prepared } from './stats.js';

export interface ServerPeriodFigures {
  /** Different players online (linked accounts count once). */
  players: number;
  /** Accounts seen for the first time. */
  newPlayers: number;
  onlineS: number;
  activeS: number;
  unknownS: number;
  sessions: number;
  /** Average number of users online at the same time. */
  avgOnline: number;
  peakOnline: number;
}

export interface PersonPeriodFigures {
  onlineS: number;
  activeS: number;
  unknownS: number;
  sessions: number;
  /** Days with any online time. */
  daysOnline: number;
}

/** `[start, end)` in UTC seconds of the Berlin days `[fromDay, toDay]`. */
function bounds(fromDay: number, toDay: number): { start: number; end: number } {
  return { start: berlinDayStart(fromDay), end: berlinDayStart(nextDay(toDay)) };
}

/** Server-wide figures of the Berlin days `[fromDay, toDay]` (inclusive). */
export function serverPeriodFigures(
  sqlite: Database.Database,
  fromDay: number,
  toDay: number,
): ServerPeriodFigures {
  const daily = prepared(
    sqlite,
    `SELECT count(DISTINCT COALESCE(p.primary_user_id, d.user_id)) AS players,
            coalesce(sum(d.online_s), 0) AS onlineS, coalesce(sum(d.active_s), 0) AS activeS,
            coalesce(sum(d.unknown_s), 0) AS unknownS, coalesce(sum(d.sessions), 0) AS sessions
     FROM user_daily_stats d
     LEFT JOIN person_members pm ON pm.user_id = d.user_id
     LEFT JOIN persons p ON p.id = pm.person_id
     WHERE d.day BETWEEN ? AND ? AND d.online_s > 0`,
  ).get(fromDay, toDay) as Omit<ServerPeriodFigures, 'newPlayers' | 'avgOnline' | 'peakOnline'>;
  const { start, end } = bounds(fromDay, toDay);
  const hourly = prepared(
    sqlite,
    `SELECT coalesce(sum(online_s), 0) AS onlineS, coalesce(max(max_online), 0) AS peak
     FROM server_hourly WHERE hour >= ? AND hour < ?`,
  ).get(start, end) as { onlineS: number; peak: number };
  const newPlayers = prepared(
    sqlite,
    `SELECT count(*) FROM users WHERE first_seen >= ? AND first_seen < ?`,
  )
    .pluck()
    .get(start, end) as number;
  return {
    ...daily,
    newPlayers,
    avgOnline: hourly.onlineS / (end - start),
    peakOnline: hourly.peak,
  };
}

/** Figures of the person `userId` belongs to (all linked accounts) for `[fromDay, toDay]`. */
export function personPeriodFigures(
  sqlite: Database.Database,
  userId: number,
  fromDay: number,
  toDay: number,
): PersonPeriodFigures {
  return prepared(
    sqlite,
    `SELECT coalesce(sum(online_s), 0) AS onlineS, coalesce(sum(active_s), 0) AS activeS,
            coalesce(sum(unknown_s), 0) AS unknownS, coalesce(sum(sessions), 0) AS sessions,
            count(DISTINCT CASE WHEN online_s > 0 THEN day END) AS daysOnline
     FROM user_daily_stats
     WHERE user_id IN (SELECT value FROM json_each(?)) AND day BETWEEN ? AND ?`,
  ).get(JSON.stringify(personIds(sqlite, userId)), fromDay, toDay) as PersonPeriodFigures;
}

/**
 * Leaderboard ranks of `subjects` (primary user ids, as in the leaderboard entries) for the days
 * `[fromDay, toDay]`; subjects without time in that period are missing from the map.
 */
export function leaderboardRanksForDays(
  sqlite: Database.Database,
  metric: LeaderboardMetric,
  fromDay: number,
  toDay: number,
  subjects: number[],
): Map<number, number> {
  if (subjects.length === 0) return new Map();
  const rows = prepared(
    sqlite,
    `SELECT subject, rank FROM (
       SELECT subject, row_number() OVER (ORDER BY value DESC, subject) AS rank
       FROM (${bySubject(metric, daysPerUser(metric))}))
     WHERE subject IN (SELECT value FROM json_each(?))`,
  )
    .raw()
    .all(fromDay, toDay, JSON.stringify(subjects)) as [number, number][];
  return new Map(rows);
}
