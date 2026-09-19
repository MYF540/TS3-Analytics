/**
 * Maintains the aggregate tables (`user_daily_stats`, `user_totals`, `server_hourly`).
 *
 * - Incremental: `finalizeSession` / `finalizeSegment` close a session or segment and fold its
 *   contribution into the aggregates in the same transaction. A second close matches nothing,
 *   so nothing is ever counted twice.
 * - Rebuild: `rebuildAggregates` recomputes everything from closed sessions and segments.
 *
 * Both paths use the pure rules from `domain/aggregation.ts`, so they produce identical results.
 * Open sessions/segments are not part of the aggregates until they are closed.
 */
import type Database from 'better-sqlite3';
import {
  aggregateHours,
  emptyDelta,
  mergeDelta,
  segmentDailyDeltas,
  sessionDailyDeltas,
  type ClosedSegmentInput,
  type ClosedSessionInput,
  type DailyDelta,
  type HourStats,
  type SessionSpan,
} from '../domain/aggregation.js';
import { berlinDayStart, HOUR_S, hourStart, nextDay } from '../domain/time.js';
import type { AppDatabase } from './client.js';
import { closeSegment, type ActivitySegment } from './repositories/segments.js';
import { closeSession, type ClosedSession } from './repositories/sessions.js';

interface Statements {
  addDaily: Database.Statement;
  addTotals: Database.Statement;
  deleteHours: Database.Statement;
  insertHour: Database.Statement;
  sessionsOverlapping: Database.Statement;
}

const statementCache = new WeakMap<Database.Database, Statements>();

function statements(sqlite: Database.Database): Statements {
  let cached = statementCache.get(sqlite);
  if (!cached) {
    cached = {
      addDaily: sqlite.prepare(`
        INSERT INTO user_daily_stats
          (user_id, day, online_s, active_s, idle_s, afk_s, unknown_s, sessions, longest_session_s)
        VALUES
          (@userId, @day, @onlineS, @activeS, @idleS, @afkS, @unknownS, @sessions, @longestSessionS)
        ON CONFLICT (user_id, day) DO UPDATE SET
          online_s = online_s + excluded.online_s,
          active_s = active_s + excluded.active_s,
          idle_s = idle_s + excluded.idle_s,
          afk_s = afk_s + excluded.afk_s,
          unknown_s = unknown_s + excluded.unknown_s,
          sessions = sessions + excluded.sessions,
          longest_session_s = max(longest_session_s, excluded.longest_session_s)`),
      addTotals: sqlite.prepare(`
        INSERT INTO user_totals
          (user_id, online_s, active_s, sessions, longest_session_s, first_seen, last_seen)
        VALUES (@userId, @onlineS, @activeS, @sessions, @longestSessionS, @firstSeen, @lastSeen)
        ON CONFLICT (user_id) DO UPDATE SET
          online_s = online_s + excluded.online_s,
          active_s = active_s + excluded.active_s,
          sessions = sessions + excluded.sessions,
          longest_session_s = max(longest_session_s, excluded.longest_session_s),
          first_seen = min(first_seen, excluded.first_seen),
          last_seen = max(last_seen, excluded.last_seen)`),
      deleteHours: sqlite.prepare(`DELETE FROM server_hourly WHERE hour >= ? AND hour < ?`),
      insertHour: sqlite.prepare(`
        INSERT INTO server_hourly (hour, online_s, max_online, unique_users)
        VALUES (@hour, @onlineS, @maxOnline, @uniqueUsers)`),
      sessionsOverlapping: sqlite.prepare(`
        SELECT user_id AS userId, join_at AS joinAt, leave_at AS leaveAt
        FROM sessions
        WHERE leave_at IS NOT NULL AND leave_at > ? AND join_at < ?
        ORDER BY join_at`),
    };
    statementCache.set(sqlite, cached);
  }
  return cached;
}

function addDaily(sqlite: Database.Database, userId: number, deltas: DailyDelta[]): void {
  const { addDaily: stmt } = statements(sqlite);
  for (const delta of deltas) stmt.run({ userId, ...delta });
}

/** Recomputes `server_hourly` for the hours in `[from, to)` from closed sessions. */
function recomputeHours(sqlite: Database.Database, from: number, to: number): number {
  const stmts = statements(sqlite);
  const spans = stmts.sessionsOverlapping.all(from, to) as SessionSpan[];
  const hours = [...aggregateHours(spans, from, to)];
  stmts.deleteHours.run(from, to);
  for (const hour of hours) stmts.insertHour.run(hour);
  return hours.length;
}

function hourRange(start: number, end: number): [number, number] {
  return [hourStart(start), hourStart(Math.max(start, end - 1)) + HOUR_S];
}

/**
 * Closes a session and folds it into all aggregates (one transaction).
 * Returns the closed session, or `undefined` if it was not open.
 */
export function finalizeSession(
  database: AppDatabase,
  sessionId: number,
  leaveAt: number,
): ClosedSession | undefined {
  return database.sqlite.transaction(() => {
    const closed = closeSession(database.db, sessionId, leaveAt);
    if (!closed) return undefined;
    const { sqlite } = database;
    addDaily(sqlite, closed.userId, sessionDailyDeltas(closed));
    statements(sqlite).addTotals.run({
      userId: closed.userId,
      onlineS: closed.duration,
      activeS: 0,
      sessions: 1,
      longestSessionS: closed.duration,
      firstSeen: closed.joinAt,
      lastSeen: closed.leaveAt,
    });
    if (closed.leaveAt > closed.joinAt) {
      const [from, to] = hourRange(closed.joinAt, closed.leaveAt);
      recomputeHours(sqlite, from, to);
    }
    return closed;
  })();
}

/**
 * Closes an activity segment and folds it into the daily and total aggregates (one transaction).
 * Returns the closed segment, or `undefined` if it was not open.
 */
export function finalizeSegment(
  database: AppDatabase,
  segmentId: number,
  endAt: number,
): ActivitySegment | undefined {
  return database.sqlite.transaction(() => {
    const closed = closeSegment(database.db, segmentId, endAt);
    if (!closed) return undefined;
    const { sqlite } = database;
    addDaily(sqlite, closed.userId, segmentDailyDeltas(closed));
    statements(sqlite).addTotals.run({
      userId: closed.userId,
      onlineS: 0,
      activeS: closed.state === 'active' ? closed.endAt - closed.startAt : 0,
      sessions: 0,
      longestSessionS: 0,
      firstSeen: closed.startAt,
      lastSeen: closed.endAt,
    });
    return closed;
  })();
}

export interface RebuildOptions {
  /** First Berlin day (YYYYMMDD) to rebuild; default: beginning of the data. */
  fromDay?: number | undefined;
  /** Last Berlin day (YYYYMMDD, inclusive) to rebuild; default: end of the data. */
  toDay?: number | undefined;
  /** Called after each processed user, e.g. for progress output. */
  onProgress?: ((done: number, total: number) => void) | undefined;
}

export interface RebuildResult {
  users: number;
  dailyRows: number;
  hours: number;
}

const MIN_TS = -8_640_000_000_000;
const MAX_TS = 8_640_000_000_000;

/**
 * Recomputes all aggregates from closed sessions and segments, optionally limited to a day range.
 * Daily rows outside the range are kept; user totals are always recomputed in full for every
 * affected user. Each user is processed in its own transaction; server hours in one transaction.
 * Run it while the watcher is stopped for a consistent snapshot of `server_hourly`.
 */
export function rebuildAggregates(
  database: AppDatabase,
  options: RebuildOptions = {},
): RebuildResult {
  const { sqlite } = database;
  const fromTs = options.fromDay === undefined ? MIN_TS : berlinDayStart(options.fromDay);
  const toTs = options.toDay === undefined ? MAX_TS : berlinDayStart(nextDay(options.toDay));
  const fromDay = options.fromDay ?? 0;
  const toDay = options.toDay ?? 99_999_999;

  const userIds = (
    sqlite
      .prepare(
        `SELECT user_id FROM sessions WHERE leave_at IS NOT NULL AND join_at < ? AND leave_at >= ?
         UNION
         SELECT user_id FROM activity_segments WHERE is_open = 0 AND start_at < ? AND end_at >= ?
         UNION
         SELECT user_id FROM user_daily_stats WHERE day BETWEEN ? AND ?
         UNION
         SELECT user_id FROM user_totals WHERE ? = 0`,
      )
      .pluck()
      .all(
        toTs,
        fromTs,
        toTs,
        fromTs,
        fromDay,
        toDay,
        options.fromDay === undefined ? 0 : 1,
      ) as number[]
  ).sort((a, b) => a - b);

  const userSessions = sqlite.prepare(
    `SELECT join_at AS joinAt, leave_at AS leaveAt, source FROM sessions
     WHERE user_id = ? AND leave_at IS NOT NULL AND join_at < ? AND leave_at >= ?`,
  );
  const userSegments = sqlite.prepare(
    `SELECT start_at AS startAt, end_at AS endAt, state FROM activity_segments
     WHERE user_id = ? AND is_open = 0 AND start_at < ? AND end_at >= ?`,
  );
  const deleteDaily = sqlite.prepare(
    `DELETE FROM user_daily_stats WHERE user_id = ? AND day BETWEEN ? AND ?`,
  );
  const deleteTotals = sqlite.prepare(`DELETE FROM user_totals WHERE user_id = ?`);
  const insertTotals = sqlite.prepare(`
    INSERT INTO user_totals
      (user_id, online_s, active_s, sessions, longest_session_s, first_seen, last_seen)
    SELECT d.user_id, sum(d.online_s), sum(d.active_s), sum(d.sessions), max(d.longest_session_s),
           b.first_seen, b.last_seen
    FROM user_daily_stats d
    JOIN (
      SELECT min(first_seen) AS first_seen, max(last_seen) AS last_seen FROM (
        SELECT min(join_at) AS first_seen, max(leave_at) AS last_seen
          FROM sessions WHERE user_id = @userId AND leave_at IS NOT NULL
        UNION ALL
        SELECT min(start_at), max(end_at)
          FROM activity_segments WHERE user_id = @userId AND is_open = 0
      )
    ) b
    WHERE d.user_id = @userId AND b.first_seen IS NOT NULL
    GROUP BY d.user_id`);

  let dailyRows = 0;
  const rebuildUser = sqlite.transaction((userId: number) => {
    const days = new Map<number, DailyDelta>();
    const add = (delta: DailyDelta) => {
      if (delta.day < fromDay || delta.day > toDay) return;
      let target = days.get(delta.day);
      if (!target) {
        target = emptyDelta(delta.day);
        days.set(delta.day, target);
      }
      mergeDelta(target, delta);
    };
    for (const s of userSessions.all(userId, toTs, fromTs) as ClosedSessionInput[]) {
      sessionDailyDeltas(s).forEach(add);
    }
    for (const s of userSegments.all(userId, toTs, fromTs) as ClosedSegmentInput[]) {
      segmentDailyDeltas(s).forEach(add);
    }
    deleteDaily.run(userId, fromDay, toDay);
    addDaily(sqlite, userId, [...days.values()]);
    dailyRows += days.size;
    deleteTotals.run(userId);
    insertTotals.run({ userId });
  });

  userIds.forEach((userId, index) => {
    rebuildUser(userId);
    options.onProgress?.(index + 1, userIds.length);
  });

  const hours = sqlite.transaction(() => {
    const bounds = sqlite
      .prepare(
        `SELECT min(join_at) AS first, max(leave_at) AS last FROM sessions
         WHERE leave_at IS NOT NULL AND leave_at > ? AND join_at < ?`,
      )
      .get(fromTs, toTs) as { first: number | null; last: number | null };
    const from = options.fromDay === undefined ? hourStart(bounds.first ?? 0) : fromTs;
    const to = options.toDay === undefined ? hourStart(bounds.last ?? 0) + HOUR_S : toTs;
    if (options.fromDay === undefined && options.toDay === undefined) {
      sqlite.prepare(`DELETE FROM server_hourly`).run();
    }
    if (bounds.first === null) {
      statements(sqlite).deleteHours.run(fromTs, toTs);
      return 0;
    }
    return recomputeHoursStreaming(sqlite, from, to);
  })();

  return { users: userIds.length, dailyRows, hours };
}

/** Like `recomputeHours`, but streams sessions so the full history never sits in memory. */
function recomputeHoursStreaming(sqlite: Database.Database, from: number, to: number): number {
  const stmts = statements(sqlite);
  const spans = stmts.sessionsOverlapping.iterate(from, to) as IterableIterator<SessionSpan>;
  // better-sqlite3 cannot write while a statement is iterating, so collect the (small) result.
  const hours: HourStats[] = [...aggregateHours(spans, from, to)];
  stmts.deleteHours.run(from, to);
  for (const hour of hours) stmts.insertHour.run(hour);
  return hours.length;
}
