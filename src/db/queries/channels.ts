/**
 * Channel statistics (T7.4). Reads `activity_segments`, so the window is limited by
 * `SEGMENT_RETENTION_MONTHS`: older segments are deleted and their channel time with them.
 */
import type Database from 'better-sqlite3';

/** Longest segment we expect; lets the queries use the index on `start_at` (see `windowFilter`). */
const MAX_SEGMENT_S = 86_400;

export interface ChannelUsage {
  /** `null` once the channel was deleted and the segments lost their reference. */
  channelId: number | null;
  name: string | null;
  seconds: number;
  /** Distinct persons, linked UIDs counted once (T5.3). */
  users: number;
  visits: number;
  lastUsed: number;
  /** Whether the channel was still in the channel list at the end of the window. */
  present: boolean;
}

export interface ChannelUsageResult {
  items: ChannelUsage[];
  /** Number of channels with time in the window, even if more than `limit`. */
  total: number;
  /** Time in all of them, so the share of a channel stays honest when the list is cut off. */
  totalSeconds: number;
}

/**
 * `start_at >= from - MAX_SEGMENT_S` keeps the index on `start_at` usable and still catches
 * segments that began before the window; their time is clipped to it. Open segments count as
 * well – otherwise a channel someone is sitting in right now would look unused; their `end_at`
 * is up to `SEGMENT_FLUSH_INTERVAL_S` behind.
 */
const WINDOW = `s.start_at >= ? - ${String(MAX_SEGMENT_S)} AND s.start_at < ? AND s.end_at > ?`;

/** Per channel and user first, so the join to persons sees one row per pair, not per segment. */
const PER_USER = `SELECT s.channel_id AS cid, s.user_id AS user_id,
         sum(min(s.end_at, ?) - max(s.start_at, ?)) AS seconds,
         count(*) AS visits, max(s.end_at) AS last_used
  FROM activity_segments s
  WHERE ${WINDOW}
  GROUP BY s.channel_id, s.user_id`;

type Row = Record<string, unknown>;

function args(from: number, to: number): number[] {
  // Two for the clipping in PER_USER, three for WINDOW.
  return [to, from, from, to, from];
}

export function channelUsage(
  sqlite: Database.Database,
  options: { from: number; to: number; limit: number; presentSince: number },
): ChannelUsageResult {
  const rows = sqlite
    .prepare(
      `WITH per_user AS (${PER_USER})
       SELECT pu.cid AS channelId, c.name, sum(pu.seconds) AS seconds,
              count(DISTINCT COALESCE(p.primary_user_id, pu.user_id)) AS users,
              sum(pu.visits) AS visits, max(pu.last_used) AS lastUsed,
              c.last_seen >= ? AS present
       FROM per_user pu
       LEFT JOIN person_members pm ON pm.user_id = pu.user_id
       LEFT JOIN persons p ON p.id = pm.person_id
       LEFT JOIN channels c ON c.id = pu.cid
       GROUP BY pu.cid
       HAVING seconds > 0
       ORDER BY seconds DESC, channelId`,
    )
    .all(...args(options.from, options.to), options.presentSince) as Row[];
  return {
    items: rows.slice(0, options.limit).map((row) => ({
      channelId: (row.channelId as number | null) ?? null,
      name: (row.name as string | null) ?? null,
      seconds: row.seconds as number,
      users: row.users as number,
      visits: row.visits as number,
      lastUsed: row.lastUsed as number,
      present: row.present === 1,
    })),
    total: rows.length,
    totalSeconds: rows.reduce((sum, row) => sum + (row.seconds as number), 0),
  };
}

export interface UnusedChannel {
  channelId: number;
  name: string;
  /** Last time the channel appeared in the channel list. */
  lastSeen: number;
}

/**
 * Channels that still exist (seen in the channel list since `presentSince`) but had nobody in
 * them since `since`. Deleted channels are left out – they are not a question any more.
 */
export function unusedChannels(
  sqlite: Database.Database,
  options: { since: number; now: number; presentSince: number },
): UnusedChannel[] {
  const rows = sqlite
    .prepare(
      `SELECT c.id AS channelId, c.name, c.last_seen AS lastSeen
       FROM channels c
       WHERE c.last_seen >= ?
         AND c.id NOT IN (
           SELECT s.channel_id FROM activity_segments s
           WHERE s.channel_id IS NOT NULL AND ${WINDOW}
         )
       ORDER BY c.name, c.id`,
    )
    .all(options.presentSince, options.since, options.now, options.since) as Row[];
  return rows.map((row) => ({
    channelId: row.channelId as number,
    name: row.name as string,
    lastSeen: row.lastSeen as number,
  }));
}
