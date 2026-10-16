/**
 * Gathers the facts the achievement engine needs for one person (T13.2). Everything is read per
 * person through the `user_id` indexes, so an incremental run over the players of the last
 * minutes stays cheap; the global parts (records, pioneers, top rank) are read once per run.
 */
import type Database from 'better-sqlite3';
import { HIDDEN_USERS } from '../db/queries/stats.js';
import type { DayFact, PersonFacts, SessionFact } from '../domain/achievements.js';

/** Pionier: the first persons ever seen on the server. */
export const PIONEER_COUNT = 100;

/** Records in the first days of the data say nothing – every hour is a record then. */
export const RECORD_WARMUP_S = 30 * 86_400;

export interface GlobalFacts {
  now: number;
  /** Days (YYYYMMDD) before this are covered by legacy ranking time; 0 = no cutoff. */
  cutoffDay: number;
  /** Legacy cutoff (UTC seconds), if set. */
  cutoff: number | undefined;
  recordHours: number[];
  pioneers: Set<number>;
  topRankId: number | undefined;
}

/** Maps every linked account to its primary account; everybody else maps to themselves. */
export function primaryMap(sqlite: Database.Database): Map<number, number> {
  const rows = sqlite
    .prepare(
      `SELECT m.user_id, p.primary_user_id FROM person_members m
       JOIN persons p ON p.id = m.person_id`,
    )
    .raw()
    .all() as [number, number][];
  return new Map(rows);
}

/** Hours in which the server reached a new all-time high of concurrent users. */
export function recordHours(sqlite: Database.Database): number[] {
  const rows = sqlite
    .prepare(`SELECT hour, max_online FROM server_hourly ORDER BY hour`)
    .raw()
    .iterate() as IterableIterator<[number, number]>;
  const result: number[] = [];
  let best = 0;
  let first: number | undefined;
  for (const [hour, maxOnline] of rows) {
    first ??= hour;
    if (maxOnline > best) {
      if (hour >= first + RECORD_WARMUP_S) result.push(hour);
      best = maxOnline;
    }
  }
  return result;
}

/** Primary accounts of the first `PIONEER_COUNT` persons by first visit. */
export function pioneers(sqlite: Database.Database, primaries: Map<number, number>): Set<number> {
  const rows = sqlite
    .prepare(`SELECT id FROM users WHERE id NOT IN (${HIDDEN_USERS}) ORDER BY first_seen, id`)
    .pluck()
    .iterate() as IterableIterator<number>;
  const result = new Set<number>();
  for (const id of rows) {
    result.add(primaries.get(id) ?? id);
    if (result.size >= PIONEER_COUNT) break;
  }
  return result;
}

const MOBILE_PLATFORMS = `('Android', 'iOS')`;

/** Prepared statements of one run; `?` lists of accounts are JSON arrays. */
export class FactsReader {
  private readonly user;
  private readonly days;
  private readonly sessions;
  private readonly channels;
  private readonly nicknames;
  private readonly contacts;
  private readonly topRank;
  private readonly privateChannel;
  private readonly sponsor;

  constructor(
    sqlite: Database.Database,
    private readonly globals: GlobalFacts,
  ) {
    const members = `SELECT value FROM json_each(?)`;
    this.user = sqlite.prepare(
      `SELECT min(first_seen) AS firstSeen, sum(legacy_seconds) AS legacyS,
              max(CASE WHEN platform IN ${MOBILE_PLATFORMS} THEN last_seen END) AS mobileAt
       FROM users WHERE id IN (${members})`,
    );
    this.days = sqlite.prepare(
      `SELECT day, sum(online_s) AS onlineS,
              sum(CASE WHEN day >= ? THEN online_s - unknown_s ELSE 0 END) AS rankS,
              sum(active_s) AS activeS, sum(afk_s) AS afkS, sum(sessions) AS sessions,
              max(longest_session_s) AS longestSessionS
       FROM user_daily_stats WHERE user_id IN (${members})
       GROUP BY day ORDER BY day`,
    );
    this.sessions = sqlite.prepare(
      `SELECT join_at AS joinAt, coalesce(leave_at, ?) AS leaveAt FROM sessions
       WHERE user_id IN (${members}) ORDER BY join_at`,
    );
    this.channels = sqlite
      .prepare(
        `SELECT min(start_at) AS at FROM activity_segments
         WHERE user_id IN (${members}) AND channel_id IS NOT NULL
         GROUP BY channel_id ORDER BY at`,
      )
      .pluck();
    this.nicknames = sqlite
      .prepare(
        `SELECT min(first_seen) AS at FROM nicknames WHERE user_id IN (${members})
         GROUP BY nick ORDER BY at`,
      )
      .pluck();
    this.contacts = sqlite
      .prepare(
        `SELECT seconds FROM network_edges WHERE range = 'all' AND (user_a = ? OR user_b = ?)`,
      )
      .pluck();
    this.topRank = sqlite
      .prepare(
        `SELECT min(decided_at) FROM rank_state WHERE rank_id = ? AND user_id IN (${members})`,
      )
      .pluck();
    this.privateChannel = sqlite
      .prepare(
        `SELECT min(created_at) FROM managed_channels
         WHERE module = 'private' AND owner_user_id IN (${members})`,
      )
      .pluck();
    this.sponsor = sqlite
      .prepare(`SELECT min(at) FROM proxy_vouches WHERE sponsor_user_id IN (${members})`)
      .pluck();
  }

  /** Facts of the person with primary account `primary` and all accounts `userIds`. */
  read(primary: number, userIds: readonly number[]): PersonFacts | undefined {
    const { now, cutoff, cutoffDay, topRankId } = this.globals;
    const ids = JSON.stringify(userIds);
    const user = this.user.get(ids) as
      { firstSeen: number | null; legacyS: number | null; mobileAt: number | null } | undefined;
    if (user?.firstSeen == null) return undefined;
    return {
      now,
      firstSeen: user.firstSeen,
      legacyS: user.legacyS ?? 0,
      legacyAt: cutoff ?? user.firstSeen,
      days: this.days.all(cutoffDay, ids) as DayFact[],
      sessions: this.sessions.all(now, ids) as SessionFact[],
      channelFirstSeen: this.channels.all(ids) as number[],
      nicknameFirstSeen: this.nicknames.all(ids) as number[],
      contactSeconds: this.contacts.all(primary, primary) as number[],
      pioneer: this.globals.pioneers.has(primary),
      topRankAt:
        topRankId === undefined ? null : (this.topRank.get(topRankId, ids) as number | null),
      recordHours: this.globals.recordHours,
      privateChannelAt: this.privateChannel.get(ids) as number | null,
      sponsorAt: this.sponsor.get(ids) as number | null,
      mobileAt: user.mobileAt,
    };
  }
}
