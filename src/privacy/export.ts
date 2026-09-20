import type { AppDatabase } from '../db/client.js';

/**
 * Everything stored about one player, for a GDPR access request (T7.2). IP addresses are never
 * stored; the export lists how many were seen, when and from which countries – the keyed hashes
 * themselves are useless to the player and are left out.
 */
export function exportUser(database: AppDatabase, userId: number, now: number) {
  const { sqlite } = database;
  const all = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params);
  const one = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).get(...params);
  const user = one(
    `SELECT id, uid, dbid, first_seen AS firstSeen, last_seen AS lastSeen, platform, version,
            country, server_groups AS serverGroups, anonymized_at AS anonymizedAt
     FROM users WHERE id = ?`,
    userId,
  ) as { uid: string; serverGroups: string | null } | undefined;
  if (!user) return undefined;
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  return {
    exportedAt: iso(now),
    note: 'Zeiten sind UTC-Sekunden. IP-Adressen werden nicht gespeichert, nur nicht umkehrbare Prüfsummen; diese sind hier nicht enthalten.',
    user: {
      ...user,
      serverGroups: user.serverGroups ? (JSON.parse(user.serverGroups) as unknown) : [],
    },
    nicknames: all(
      'SELECT nick, first_seen AS firstSeen, last_seen AS lastSeen FROM nicknames WHERE user_id = ? ORDER BY first_seen',
      userId,
    ),
    totals:
      one(
        `SELECT online_s AS onlineS, active_s AS activeS, sessions, longest_session_s AS longestSessionS,
              first_seen AS firstSeen, last_seen AS lastSeen
       FROM user_totals WHERE user_id = ?`,
        userId,
      ) ?? null,
    sessions: all(
      `SELECT join_at AS joinAt, leave_at AS leaveAt, duration, source FROM sessions
       WHERE user_id = ? ORDER BY join_at`,
      userId,
    ),
    dailyStats: all(
      `SELECT day, online_s AS onlineS, active_s AS activeS, idle_s AS idleS, afk_s AS afkS,
              unknown_s AS unknownS, sessions
       FROM user_daily_stats WHERE user_id = ? ORDER BY day`,
      userId,
    ),
    connections: {
      /** Distinct IP addresses (as hashes) seen within the retention period. */
      addresses: (
        one('SELECT count(*) AS n FROM ip_seen WHERE user_id = ?', userId) as { n: number }
      ).n,
      byCountry: all(
        `SELECT country, sum(seen_count) AS connections, min(first_seen) AS firstSeen,
                max(last_seen) AS lastSeen
         FROM ip_seen WHERE user_id = ? GROUP BY country ORDER BY lastSeen DESC`,
        userId,
      ),
    },
    notes: all(
      `SELECT id, author_name AS author, body, created_at AS createdAt, updated_at AS updatedAt,
              deleted_at AS deletedAt
       FROM player_notes WHERE user_id = ? ORDER BY created_at`,
      userId,
    ),
    noteRevisions: all(
      `SELECT r.note_id AS noteId, r.body, r.editor_name AS editor, r.replaced_at AS replacedAt
       FROM player_note_revisions r JOIN player_notes n ON n.id = r.note_id
       WHERE n.user_id = ? ORDER BY r.replaced_at`,
      userId,
    ),
    tags: all(
      `SELECT t.name, ut.added_by AS addedBy, ut.added_at AS addedAt
       FROM user_tags ut JOIN tags t ON t.id = ut.tag_id WHERE ut.user_id = ?`,
      userId,
    ),
    linkedAccounts: all(
      `SELECT u.uid, m.added_at AS addedAt, m.added_by AS addedBy
       FROM person_members me JOIN person_members m ON m.person_id = me.person_id
       JOIN users u ON u.id = m.user_id
       WHERE me.user_id = ? AND m.user_id <> ?`,
      userId,
      userId,
    ),
    hints: all(
      `SELECT kind, level, status, first_detected AS firstDetected, last_detected AS lastDetected
       FROM flags WHERE user_id = ? OR related_user_id = ?`,
      userId,
      userId,
    ),
    bans: all(
      `SELECT id, created_at AS createdAt, duration_s AS durationS, reason, invoker_name AS invoker,
              removed_at AS removedAt, ip_hash IS NOT NULL OR ip_pattern = 1 AS ipRule
       FROM bans WHERE user_id = ? OR uid = ?`,
      userId,
      user.uid,
    ),
    serverGroupChanges: all(
      `SELECT at, action, group_name AS groupName, invoker_name AS invoker
       FROM group_changes WHERE user_id = ? ORDER BY at`,
      userId,
    ),
    rank: {
      state:
        one('SELECT rank_id AS rankId, pending FROM rank_state WHERE user_id = ?', userId) ?? null,
      override:
        one(
          'SELECT frozen_rank_id AS frozenRankId, bonus_s AS bonusS, excluded, note FROM rank_overrides WHERE user_id = ?',
          userId,
        ) ?? null,
      history: all(
        `SELECT h.at, (SELECT name FROM ranks WHERE id = h.from_rank_id) AS fromRank,
                (SELECT name FROM ranks WHERE id = h.to_rank_id) AS toRank, h.outcome
         FROM rank_history h WHERE h.user_id = ? ORDER BY h.at`,
        userId,
      ),
    },
    moderation: all(
      `SELECT at, actor_name AS actor, action, details FROM audit_log
       WHERE target_type = 'user' AND target_id = ? AND action LIKE 'moderation.%' ORDER BY at`,
      String(userId),
    ),
  };
}
