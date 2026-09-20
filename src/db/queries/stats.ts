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
  /** Number of linked UIDs counted in this entry (1 = not linked, T5.3). */
  accounts: number;
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

/** How the values of several linked UIDs combine: times add up, the longest session is the max. */
const COMBINE: Record<LeaderboardMetric, string> = {
  online: 'sum',
  active: 'sum',
  longestSession: 'max',
};

/**
 * Regroups a per-user result (`user_id`, `value`) by person (T5.3): linked UIDs count as their
 * person's primary user, unlinked users as themselves. Aggregating per user first keeps the join
 * to a few thousand rows instead of every daily row.
 */
function bySubject(metric: LeaderboardMetric, perUser: string): string {
  return `SELECT COALESCE(p.primary_user_id, x.user_id) AS subject,
                 ${COMBINE[metric]}(x.value) AS value
          FROM (${perUser}) x
          LEFT JOIN person_members pm ON pm.user_id = x.user_id
          LEFT JOIN persons p ON p.id = pm.person_id
          GROUP BY subject
          HAVING value > 0`;
}

/**
 * Players who are not shown: anonymized ones (GDPR, T7.2) and the placeholders the log import
 * creates for database ids TeamSpeak has already deleted (T8.3). Their playtime stays in the
 * server statistics, only they themselves are out of lists, search, leaderboards and ranks.
 */
export const HIDDEN_USERS = `SELECT id FROM users
  WHERE anonymized_at IS NOT NULL OR uid LIKE 'unknown-dbid-%'`;
const VISIBLE = `user_id NOT IN (${HIDDEN_USERS})`;
/** Same condition where the row is a `users` row aliased `u`. */
export const VISIBLE_USER = `u.anonymized_at IS NULL AND u.uid NOT LIKE 'unknown-dbid-%'`;

const totalsPerUser = (metric: LeaderboardMetric) =>
  `SELECT user_id, ${TOTALS_COLUMN[metric]} AS value FROM user_totals
   WHERE ${TOTALS_COLUMN[metric]} > 0 AND ${VISIBLE}`;

const daysPerUser = (metric: LeaderboardMetric) =>
  `SELECT user_id, ${DAILY_EXPRESSION[metric]} AS value FROM user_daily_stats
   WHERE day BETWEEN ? AND ? AND ${VISIBLE} GROUP BY user_id`;

const ACCOUNTS_SUBQUERY = `max(1, (SELECT count(*) FROM person_members m
  JOIN person_members me ON me.person_id = m.person_id WHERE me.user_id = u.id))`;

/** Entries for one page of subjects, with nickname and number of linked accounts. */
function rankedEntries(ranked: string): string {
  return `WITH ranked AS (${ranked} ORDER BY value DESC, subject LIMIT ? OFFSET ?)
     SELECT u.id AS userId, u.uid, ${NICKNAME_SUBQUERY} AS nickname, r.value,
            ${ACCOUNTS_SUBQUERY} AS accounts
     FROM ranked r JOIN users u ON u.id = r.subject
     ORDER BY r.value DESC, r.subject`;
}

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
    accounts: (row.accounts as number | undefined) ?? 1,
  }));
}

/** All-time leaderboard from `user_totals`, one entry per person (T5.3). */
export function leaderboardAllTime(
  sqlite: Database.Database,
  metric: LeaderboardMetric,
  page: Page,
): LeaderboardEntry[] {
  const rows = prepared(sqlite, rankedEntries(bySubject(metric, totalsPerUser(metric)))).all(
    page.limit,
    page.offset,
  ) as Row[];
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
  const rows = prepared(sqlite, rankedEntries(bySubject(metric, daysPerUser(metric)))).all(
    fromDay,
    toDay,
    page.limit,
    page.offset,
  ) as Row[];
  return toEntries(rows, page.offset);
}

/** Number of ranked entries for `leaderboardAllTime` (for pagination). */
export function countLeaderboardAllTime(
  sqlite: Database.Database,
  metric: LeaderboardMetric,
): number {
  return prepared(sqlite, `SELECT count(*) FROM (${bySubject(metric, totalsPerUser(metric))})`)
    .pluck()
    .get() as number;
}

/** Number of ranked entries for `leaderboardForDays` (for pagination). */
export function countLeaderboardForDays(
  sqlite: Database.Database,
  metric: LeaderboardMetric,
  fromDay: number,
  toDay: number,
): number {
  return prepared(sqlite, `SELECT count(*) FROM (${bySubject(metric, daysPerUser(metric))})`)
    .pluck()
    .get(fromDay, toDay) as number;
}

function personIds(sqlite: Database.Database, userId: number): number[] {
  const ids = prepared(
    sqlite,
    `SELECT m2.user_id FROM person_members m1
     JOIN person_members m2 ON m2.person_id = m1.person_id WHERE m1.user_id = ?`,
  )
    .pluck()
    .all(userId) as number[];
  return ids.length > 0 ? ids : [userId];
}

export interface UserDetail {
  user: Row;
  totals: Row | undefined;
  nicknames: Row[];
  recentSessions: Row[];
  daily: Row[];
  topChannels: Row[];
  /** Countries seen for this user (from IP data within the retention period). */
  countries: Row[];
  /** The currently open session, if the user is online. */
  openSession: Row | undefined;
}

/** Everything the player page needs; `days` limits the daily series (most recent first cut). */
export function userDetail(
  sqlite: Database.Database,
  userId: number,
  sinceDay: number,
): UserDetail | undefined {
  const user = prepared(sqlite, `SELECT * FROM users WHERE id = ?`).get(userId) as Row | undefined;
  if (!user) return undefined;
  // Figures of the whole person (T5.3); nicknames, sessions and countries stay per UID.
  const ids = JSON.stringify(personIds(sqlite, userId));
  return {
    user,
    totals: prepared(
      sqlite,
      `SELECT sum(online_s) AS online_s, sum(active_s) AS active_s, sum(sessions) AS sessions,
              max(longest_session_s) AS longest_session_s
       FROM user_totals WHERE user_id IN (SELECT value FROM json_each(?))
       HAVING count(*) > 0`,
    ).get(ids) as Row | undefined,
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
      `SELECT day, sum(online_s) AS onlineS, sum(active_s) AS activeS, sum(idle_s) AS idleS,
              sum(afk_s) AS afkS, sum(unknown_s) AS unknownS, sum(sessions) AS sessions
       FROM user_daily_stats WHERE user_id IN (SELECT value FROM json_each(?)) AND day >= ?
       GROUP BY day ORDER BY day`,
    ).all(ids, sinceDay) as Row[],
    topChannels: prepared(
      sqlite,
      `SELECT s.channel_id AS channelId, c.name, sum(s.end_at - s.start_at) AS seconds
       FROM activity_segments s LEFT JOIN channels c ON c.id = s.channel_id
       WHERE s.user_id IN (SELECT value FROM json_each(?)) AND s.is_open = 0
       GROUP BY s.channel_id ORDER BY seconds DESC LIMIT 10`,
    ).all(ids) as Row[],
    countries: prepared(
      sqlite,
      `SELECT country, max(last_seen) AS lastSeen, sum(seen_count) AS connections
       FROM ip_seen WHERE user_id = ? AND country IS NOT NULL
       GROUP BY country ORDER BY lastSeen DESC`,
    ).all(userId) as Row[],
    openSession: prepared(
      sqlite,
      `SELECT id, join_at AS joinAt FROM sessions
       WHERE user_id IN (SELECT value FROM json_each(?)) AND leave_at IS NULL
       ORDER BY join_at LIMIT 1`,
    ).get(ids) as Row | undefined,
  };
}

export interface Overview {
  onlineNow: number;
  /** Highest concurrent count today (Berlin day), including live minute values. */
  peakToday: number;
  peakInRange: number;
  peakAllTime: number;
  usersTotal: number;
  usersNew: number;
}

/**
 * Key figures for the dashboard; `[from, to)` in UTC seconds selects the "range" figures,
 * `todayStart` is the start of the current Berlin day. Hourly aggregates only contain closed
 * sessions, so live values (open sessions, minute samples) are included for "now" and "today".
 */
export function overview(
  sqlite: Database.Database,
  from: number,
  to: number,
  todayStart: number,
): Overview {
  const one = (sql: string, ...params: unknown[]) =>
    (prepared(sqlite, sql)
      .pluck()
      .get(...params) as number | null) ?? 0;
  const onlineNow = one(`SELECT count(*) FROM sessions WHERE leave_at IS NULL`);
  return {
    onlineNow,
    peakToday: Math.max(
      onlineNow,
      one(`SELECT max(max_online) FROM server_hourly WHERE hour >= ?`, todayStart),
      one(`SELECT max(online) FROM server_minutely WHERE ts >= ?`, todayStart),
    ),
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
export function onlineSeries(
  sqlite: Database.Database,
  from: number,
  to: number,
): { resolution: number; points: SeriesPoint[] } {
  let bucket = pickBucket(from, to);
  if (bucket < HOUR_S) {
    // Minute samples only exist for the last 14 days (and since the watcher runs); for older or
    // not fully covered ranges fall back to hourly data.
    const firstMinute = prepared(sqlite, 'SELECT min(ts) FROM server_minutely').pluck().get() as
      number | null;
    if (firstMinute !== null && firstMinute <= from + bucket) {
      const points = prepared(
        sqlite,
        `SELECT (ts / ?) * ? AS t, avg(online) AS avgOnline, max(online) AS maxOnline
         FROM server_minutely WHERE ts >= ? AND ts < ? GROUP BY ts / ? ORDER BY t`,
      ).all(bucket, bucket, from, to, bucket) as SeriesPoint[];
      return { resolution: bucket, points };
    }
    bucket = HOUR_S;
  }
  // Bucket starts follow Berlin calendar days/weeks for day and week buckets.
  const startOf =
    bucket === 86_400
      ? (ts: number) => berlinDayStart(berlinDay(ts))
      : bucket === 7 * 86_400
        ? (ts: number) => berlinDayStart(weekOf(berlinDay(ts)))
        : (ts: number) => ts - (ts % bucket);
  const nextStart = (t: number): number => {
    if (bucket === 86_400) return berlinDayStart(nextDay(berlinDay(t)));
    if (bucket === 7 * 86_400) {
      let day = berlinDay(t);
      for (let i = 0; i < 7; i++) day = nextDay(day);
      return berlinDayStart(day);
    }
    return t + bucket;
  };

  const first = startOf(from);
  const rows = prepared(
    sqlite,
    `SELECT hour, online_s, max_online FROM server_hourly WHERE hour >= ? AND hour < ? ORDER BY hour`,
  )
    .raw()
    .all(first, to) as [number, number, number][];
  const sums = new Map<number, { onlineS: number; max: number }>();
  for (const [hour, onlineS, maxOnline] of rows) {
    const t = startOf(hour);
    const sum = sums.get(t) ?? { onlineS: 0, max: 0 };
    sum.onlineS += onlineS;
    sum.max = Math.max(sum.max, maxOnline);
    sums.set(t, sum);
  }

  // Hours without any session have no row: they are real zeros, not missing data.
  const points: SeriesPoint[] = [];
  for (let t = first; t < to;) {
    const next = nextStart(t);
    const sum = sums.get(t);
    points.push({
      t,
      avgOnline: sum ? sum.onlineS / (next - t) : 0,
      maxOnline: sum?.max ?? 0,
    });
    t = next;
  }
  return { resolution: bucket, points };
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
/** SQL condition on `u` (users) matching a search term, with its named parameters. */
function searchCondition(term: string): { sql: string; params: Record<string, string> } {
  const trimmed = term.trim();
  const escapedLike = trimmed.replace(/[\\%_]/g, (c) => `\\${c}`);
  const nickMatch =
    trimmed.length >= 3
      ? `SELECT user_id FROM nicknames WHERE id IN (
           SELECT rowid FROM nicknames_fts WHERE nicknames_fts MATCH @fts)`
      : `SELECT user_id FROM nicknames WHERE nick LIKE @prefix ESCAPE '\\'`;
  return {
    sql: `(u.id IN (${nickMatch}) OR (u.uid >= @uid AND u.uid < @uidEnd))`,
    params: {
      fts: `"${trimmed.replace(/"/g, '""')}"`,
      prefix: `${escapedLike}%`,
      uid: trimmed,
      uidEnd: `${trimmed}\uffff`,
    },
  };
}

export function searchUsers(sqlite: Database.Database, term: string, limit = 20): SearchHit[] {
  if (term.trim() === '') return [];
  const condition = searchCondition(term);
  return prepared(
    sqlite,
    `SELECT u.id AS userId, u.uid, ${NICKNAME_SUBQUERY} AS nickname, u.last_seen AS lastSeen
     FROM users u
     WHERE ${VISIBLE_USER} AND ${condition.sql}
     ORDER BY u.last_seen DESC
     LIMIT @limit`,
  ).all({ ...condition.params, limit }) as SearchHit[];
}

export const USER_SORTS = [
  'online',
  'active',
  'sessions',
  'lastSeen',
  'firstSeen',
  'nickname',
] as const;
export type UserSort = (typeof USER_SORTS)[number];

const USER_SORT_SQL: Record<UserSort, string> = {
  online: 'coalesce(t.online_s, 0)',
  active: 'coalesce(t.active_s, 0)',
  sessions: 'coalesce(t.sessions, 0)',
  lastSeen: 'u.last_seen',
  firstSeen: 'u.first_seen',
  nickname: `${NICKNAME_SUBQUERY} COLLATE NOCASE`,
};

export interface UserListOptions {
  search?: string | undefined;
  sort: UserSort;
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
  /** Hide users with less online time (casual users); 0 shows everyone. */
  minOnlineS: number;
}

export interface UserListItem {
  userId: number;
  uid: string;
  nickname: string | null;
  onlineS: number;
  activeS: number;
  sessions: number;
  firstSeen: number;
  lastSeen: number;
  country: string | null;
  online: boolean;
}

/** Paginated, sortable, searchable user list with the total number of matches. */
export function listUsers(
  sqlite: Database.Database,
  options: UserListOptions,
): { items: UserListItem[]; total: number } {
  const search = options.search?.trim() ? searchCondition(options.search) : undefined;
  const where = `${VISIBLE_USER} AND coalesce(t.online_s, 0) >= @minOnlineS${search ? ` AND ${search.sql}` : ''}`;
  const params = { ...search?.params, minOnlineS: options.minOnlineS };
  const from = `FROM users u LEFT JOIN user_totals t ON t.user_id = u.id WHERE ${where}`;
  const direction = options.order === 'asc' ? 'ASC' : 'DESC';
  const rows = prepared(
    sqlite,
    `SELECT u.id AS userId, u.uid, ${NICKNAME_SUBQUERY} AS nickname,
            coalesce(t.online_s, 0) AS onlineS, coalesce(t.active_s, 0) AS activeS,
            coalesce(t.sessions, 0) AS sessions, u.first_seen AS firstSeen,
            u.last_seen AS lastSeen, u.country,
            EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.leave_at IS NULL) AS online
     ${from}
     ORDER BY ${USER_SORT_SQL[options.sort]} ${direction}, u.id ${direction}
     LIMIT @limit OFFSET @offset`,
  ).all({ ...params, limit: options.limit, offset: options.offset }) as (Omit<
    UserListItem,
    'online'
  > & { online: number })[];
  const total = prepared(sqlite, `SELECT count(*) ${from}`).pluck().get(params) as number;
  return { items: rows.map((r) => ({ ...r, online: r.online === 1 })), total };
}
