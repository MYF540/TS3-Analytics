import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db/client.js';
import { getPersonOfUser, unlinkUser } from '../db/repositories/index.js';

export class AnonymizeError extends Error {
  constructor(readonly code: 'USER_NOT_FOUND' | 'ALREADY_ANONYMIZED' | 'USER_ONLINE') {
    super(code);
    this.name = 'AnonymizeError';
  }
}

export interface AnonymizeResult {
  nicknames: number;
  ipSeen: number;
  notes: number;
  flags: number;
}

/**
 * GDPR anonymization (T7.2, decision 20.09.2026): removes everything that identifies the player
 * – UID (replaced by a random id), nicknames, IP hashes, client data, notes, tags, hints, links,
 * rank data – and the personal parts of mirrored bans and group changes. Sessions, activity and
 * the aggregates stay as anonymous playtime; anonymized players are hidden from lists.
 *
 * If the same UID connects again, the tracker creates a new player. A ban on the server is not
 * lifted; the next ban-list sync would mirror its UID again, so lift it on the server if needed.
 */
export function anonymizeUser(
  database: AppDatabase,
  userId: number,
  now: number,
  isOnline: boolean,
): AnonymizeResult {
  const { sqlite } = database;
  const user = sqlite
    .prepare('SELECT uid, dbid, anonymized_at AS anonymizedAt FROM users WHERE id = ?')
    .get(userId) as { uid: string; dbid: number | null; anonymizedAt: number | null } | undefined;
  if (!user) throw new AnonymizeError('USER_NOT_FOUND');
  if (user.anonymizedAt !== null) throw new AnonymizeError('ALREADY_ANONYMIZED');
  // An open session would keep writing under the old identity.
  if (isOnline) throw new AnonymizeError('USER_ONLINE');

  return sqlite.transaction(() => {
    if (getPersonOfUser(sqlite, userId)) unlinkUser(sqlite, userId);
    const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params).changes;
    const result: AnonymizeResult = {
      nicknames: run('DELETE FROM nicknames WHERE user_id = ?', userId),
      ipSeen: run('DELETE FROM ip_seen WHERE user_id = ?', userId),
      notes: run('DELETE FROM player_notes WHERE user_id = ?', userId),
      flags: run('DELETE FROM flags WHERE user_id = ? OR related_user_id = ?', userId, userId),
    };
    run('DELETE FROM user_tags WHERE user_id = ?', userId);
    run('DELETE FROM rank_overrides WHERE user_id = ?', userId);
    run('DELETE FROM rank_state WHERE user_id = ?', userId);
    run('DELETE FROM rank_history WHERE user_id = ?', userId);
    run(
      `UPDATE bans SET user_id = NULL, uid = NULL, last_nickname = NULL, ip_hash = NULL,
         subnet_hash = NULL
       WHERE user_id = ? OR uid = ?`,
      userId,
      user.uid,
    );
    run(
      'UPDATE group_changes SET user_id = NULL, nickname = NULL WHERE user_id = ? OR dbid = ?',
      userId,
      user.dbid ?? -1,
    );
    run(
      `UPDATE users SET uid = ?, dbid = NULL, platform = NULL, version = NULL, country = NULL,
         server_groups = NULL, anonymized_at = ?
       WHERE id = ?`,
      `anonymized:${randomUUID()}`,
      now,
      userId,
    );
    return result;
  })();
}
