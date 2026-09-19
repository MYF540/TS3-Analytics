/**
 * Read queries for statistics, leaderboards and search. They only read aggregate tables
 * (`user_totals`, `user_daily_stats`, `server_hourly`) for long periods; raw tables are only used
 * for bounded per-user lookups or short recent windows. Measured by `pnpm bench` (docs/performance.md).
 */
import type Database from 'better-sqlite3';
import { berlinDay, berlinDayStart, berlinOffset, HOUR_S, nextDay } from '../../domain/time.js';

export type LeaderboardMetric = 'online' | 'active' | 'longestSession';

export interface LeaderboardEntry {
  rank: number;
  userId: number;
  uid: string;
  nickname: string | null;
  value: number;
}

export interface Page {
  limit: number;
  offset: number;
}

const TOTALS_COLUMN: Record<LeaderboardMetric, string> = {
  online: 'online_s',
  active: 'active_s',
  longestSession: 'longest_session_s',
};

const DAILY_EXPRESSION: Record<LeaderboardMetric, string> = {
  online: 'sum(online_s)',
  active: 'sum(active_s)',
  longestSession: 'max(longest_session_s)',
};

const NICKNAME_SUBQUERY = `(SELECT n.nick FROM nicknames n WHERE n.user_id = u.id
  ORDER BY n.last_seen DESC, n.id DESC LIMIT 1)`;

type Row = Record<string, unknown>;

function statementCache(sqlite: Database.Database) {
  const cache = new Map<string, Database.Statement>();
  return (sql: string): Database.Statement => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = sqlite.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };
}

const caches = new WeakMap<Database.Database, ReturnType<typeof statementCache>>();

function prepared(sqlite: Database.Database, sql: string): Database.Statement {
  let cache = caches.get(sqlite);
  if (!cache) {
    cache = statementCache(sqlite);
    caches.set(sqlite, cache);
  }
  return cache(sql);
}

function toEntries(rows: Row[], offset: number): LeaderboardEntry[] {
  return rows.map((row, i) => ({
    rank: offset + i + 1,
    userId: row.userId as number,
    uid: row.uid as string,
    nickname: (row.nickname as string | null) ?? null,
    value: row.value as number,
  }));
}

/** All-time leaderboard from `user_totals`. */
export function leaderboardAllTime(
  sqlite: Database.Database,
  metric: LeaderboardMetric,
  page: Page,
): LeaderboardEntry[] {
  const column = TOTALS_COLUMN[metric];
  const rows = prepared(
    sqlite,
    `SELECT u.id AS userId, u.uid, ${NICKNAME_SUBQUERY} AS nickname, t.${column} AS value
     FROM user_totals t JOIN users u ON u.id = t.user_id
     WHERE t.${column} > 0
     ORDER BY t.${column} DESC, t.user_id
     LIMIT ? OFFSET ?`,
  ).all(page.limit, page.offset) as Row[];
  return toEntries(rows, page.offset);
}

/** Leaderboard over Berlin days `[fromDay, toDay]` (inclusive) from `user_daily_stats`. */
export function leaderboardForDays(
  sqlite: Database.Database,
  metric: LeaderboardMetric,
  fromDay: number,
  toDay: number,
  page: Page,
): LeaderboardEntry[] {
  const rows = prepared(
    sqlite,
    `WITH ranked AS (
       SELECT user_id, ${DAILY_EXPRESSION[metric]} AS value
       FROM user_daily_stats
       WHERE day BETWEEN ? AND ?
       GROUP BY user_id
       HAVING value > 0
       ORDER BY value DESC, user_id
       LIMIT ? OFFSET ?
     )
     SELECT u.id AS userId, u.uid, ${NICKNAME_SUBQUERY} AS nickname, r.value
     FROM ranked r JOIN users u ON u.id = r.user_id
     ORDER BY r.value DESC, r.user_id`,
  ).all(fromDay, toDay, page.limit, page.offset) as Row[];
  return toEntries(rows, page.offset);
}

export interface UserDetail {
  user: Row;
  totals: Row | undefined;
  nicknames: Row[];
  recentSessions: Row[];
  daily: Row[];
  topChannels: Row[];
}

/** Everything the player page needs; `days` limits the daily series (most recent first cut). */
export function userDetail(
  sqlite: Database.Database,
  userId: number,
  sinceDay: number,
): UserDetail | undefined {
  const user = prepared(sqlite, `SELECT * FROM users WHERE id = ?`).get(userId) as Row | undefined;
  if (!user) return undefined;
  return {
    user,
    totals: prepared(sqlite, `SELECT * FROM user_totals WHERE user_id = ?`).get(userId) as
      Row | undefined,
    nicknames: prepared(
      sqlite,
      `SELECT nick, first_seen AS firstSeen, last_seen AS lastSeen FROM nicknames
       WHERE user_id = ? ORDER BY last_seen DESC`,
    ).all(userId) as Row[],
    recentSessions: prepared(
      sqlite,
      `SELECT id, join_at AS joinAt, leave_at AS leaveAt, duration, source FROM sessions
       WHERE user_id = ? ORDER BY join_at DESC LIMIT 20`,
    ).all(userId) as Row[],
    daily: prepared(
      sqlite,
      `SELECT day, online_s AS onlineS, active_s AS activeS, idle_s AS idleS, afk_s AS afkS,
              unknown_s AS unknownS, sessions
       FROM user_daily_stats WHERE user_id = ? AND day >= ? ORDER BY day`,
    ).all(userId, sinceDay) as Row[],
    topChannels: prepared(
      sqlite,
      `SELECT s.channel_id AS channelId, c.name, sum(s.end_at - s.start_at) AS seconds
       FROM activity_segments s LEFT JOIN channels c ON c.id = s.channel_id
       WHERE s.user_id = ? AND s.is_open = 0
       GROUP BY s.channel_id ORDER BY seconds DESC LIMIT 10`,
    ).all(userId) as Row[],
  };
}

export interface Overview {
  onlineNow: number;
  peakInRange: number;
  peakAllTime: number;
  usersTotal: number;
  usersNew: number;
}

/** Key figures for the dashboard; `[from, to)` in UTC seconds selects the "range" figures. */
export function overview(sqlite: Database.Database, from: number, to: number): Overview {
  const one = (sql: string, ...params: unknown[]) =>
    (prepared(sqlite, sql)
      .pluck()
      .get(...params) as number | null) ?? 0;
  return {
    onlineNow: one(`SELECT count(*) FROM sessions WHERE leave_at IS NULL`),
    peakInRange: one(
      `SELECT max(max_online) FROM server_hourly WHERE hour >= ? AND hour < ?`,
      from,
      to,
    ),
    peakAllTime: one(`SELECT max(max_online) FROM server_hourly`),
    usersTotal: one(`SELECT count(*) FROM users`),
    usersNew: one(`SELECT count(*) FROM users WHERE first_seen >= ? AND first_seen < ?`, from, to),
  };
}

export interface SeriesPoint {
  /** Bucket start (UTC seconds). */
  t: number;
  avgOnline: number;
  maxOnline: number;
}

/** Bucket sizes in seconds; the smallest one yielding at most `maxPoints` points is used. */
const BUCKETS = [60, 300, 900, HOUR_S, 3 * HOUR_S, 6 * HOUR_S, 86_400, 7 * 86_400] as const;

export function pickBucket(from: number, to: number, maxPoints = 1000): number {
  const span = Math.max(1, to - from);
  return BUCKETS.find((b) => span / b <= maxPoints) ?? 7 * 86_400;
}

/** Berlin Monday (YYYYMMDD) of the week containing `day`. */
function weekOf(day: number): number {
  const start = berlinDayStart(day);
  const weekday = (new Date((start + 12 * HOUR_S) * 1000).getUTCDay() + 6) % 7; // Mon = 0
  return berlinDay(start + 12 * HOUR_S - weekday * 86_400);
}

/**
 * Online history for `[from, to)`, downsampled to at most ~1000 points. Minute buckets come from
 * `server_minutely`, everything coarser from `server_hourly`; day and week buckets follow Berlin
 * calendar days.
 */
export function onlineSeries(sqlite: Database.Database, from: number, to: number): SeriesPoint[] {
  const bucket = pickBucket(from, to);
  if (bucket < HOUR_S) {
    return prepared(
      sqlite,
      `SELECT (ts / ?) * ? AS t, avg(online) AS avgOnline, max(online) AS maxOnline
       FROM server_minutely WHERE ts >= ? AND ts < ? GROUP BY ts / ? ORDER BY t`,
    ).all(bucket, bucket, from, to, bucket) as SeriesPoint[];
  }
  const rows = prepared(
    sqlite,
    `SELECT hour, online_s, max_online FROM server_hourly WHERE hour >= ? AND hour < ? ORDER BY hour`,
  )
    .raw()
    .all(from, to) as [number, number, number][];

  const keyOf =
    bucket === 86_400
      ? (hour: number) => berlinDayStart(berlinDay(hour))
      : bucket === 7 * 86_400
        ? (hour: number) => berlinDayStart(weekOf(berlinDay(hour)))
        : (hour: number) => hour - (hour % bucket);
  const bucketLength = (start: number) =>
    bucket === 86_400
      ? berlinDayStart(nextDay(berlinDay(start))) - start
      : bucket === 7 * 86_400
        ? 7 * 86_400
        : bucket;

  const points: SeriesPoint[] = [];
  let current: { t: number; onlineS: number; max: number } | undefined;
  for (const [hour, onlineS, maxOnline] of rows) {
    const t = keyOf(hour);
    if (current?.t !== t) {
      if (current) {
        points.push({
          t: current.t,
          avgOnline: current.onlineS / bucketLength(current.t),
          maxOnline: current.max,
        });
      }
      current = { t, onlineS: 0, max: 0 };
    }
    current.onlineS += onlineS;
    current.max = Math.max(current.max, maxOnline);
  }
  if (current) {
    points.push({
      t: current.t,
      avgOnline: current.onlineS / bucketLength(current.t),
      maxOnline: current.max,
    });
  }
  return points;
}

/**
 * Average online users per Berlin weekday (0 = Monday) × hour for `[from, to)`.
 * Hours without any session count as 0.
 */
export function weekdayHourHeatmap(
  sqlite: Database.Database,
  from: number,
  to: number,
): number[][] {
  const sums = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const counts = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const rows = prepared(
    sqlite,
    `SELECT hour, online_s FROM server_hourly WHERE hour >= ? AND hour < ?`,
  )
    .raw()
    .all(from, to) as [number, number][];
  const onlineByHour = new Map(rows);
  const first = Math.ceil(from / HOUR_S) * HOUR_S;
  for (let hour = first; hour < to; hour += HOUR_S) {
    const local = new Date((hour + berlinOffset(hour)) * 1000);
    const weekday = (local.getUTCDay() + 6) % 7;
    const h = local.getUTCHours();
    (sums[weekday] as number[])[h] =
      ((sums[weekday] as number[])[h] ?? 0) + (onlineByHour.get(hour) ?? 0) / HOUR_S;
    (counts[weekday] as number[])[h] = ((counts[weekday] as number[])[h] ?? 0) + 1;
  }
  return sums.map((row, d) => row.map((sum, h) => sum / Math.max(1, counts[d]?.[h] ?? 1)));
}

export interface SearchHit {
  userId: number;
  uid: string;
  nickname: string | null;
  lastSeen: number;
}

/**
 * Finds users by (part of a) nickname or UID prefix. Terms of three or more characters use the
 * trigram FTS index; shorter terms fall back to a prefix match.
 */
export function searchUsers(sqlite: Database.Database, term: string, limit = 20): SearchHit[] {
  const trimmed = term.trim();
  if (trimmed === '') return [];
  const escapedLike = trimmed.replace(/[\\%_]/g, (c) => `\\${c}`);
  const nickMatch =
    trimmed.length >= 3
      ? `SELECT user_id FROM nicknames WHERE id IN (
           SELECT rowid FROM nicknames_fts WHERE nicknames_fts MATCH @fts)`
      : `SELECT user_id FROM nicknames WHERE nick LIKE @prefix ESCAPE '\\'`;
  return prepared(
    sqlite,
    `SELECT u.id AS userId, u.uid, ${NICKNAME_SUBQUERY} AS nickname, u.last_seen AS lastSeen
     FROM users u
     WHERE u.id IN (${nickMatch})
        OR (u.uid >= @uid AND u.uid < @uidEnd)
     ORDER BY u.last_seen DESC
     LIMIT @limit`,
  ).all({
    fts: `"${trimmed.replace(/"/g, '""')}"`,
    prefix: `${escapedLike}%`,
    uid: trimmed,
    uidEnd: `${trimmed}￿`,
    limit,
  }) as SearchHit[];
}
