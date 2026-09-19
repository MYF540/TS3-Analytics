import { z } from 'zod';
import type { AppDatabase } from '../db/client.js';
import { getSetting, setSetting, type DbExecutor } from '../db/repositories/index.js';
import { detectFlags, type ActiveBan, type FlagCandidate, type SeenIp } from '../domain/flags.js';

export const FLAGS_LAST_RUN_KEY = 'flags.lastRun';

export interface FlagDetectionResult {
  /** Pairs found in this run. */
  detected: number;
  /** Pairs found for the first time. */
  created: number;
  /** The new pairs themselves (for alerts). */
  newFlags: FlagCandidate[];
  /** First run ever: everything is new, so nothing is alerted. */
  initial: boolean;
}

/** Start of the last detection run; flags with an older `last_detected` no longer apply. */
export function flagsLastRun(db: DbExecutor): number | undefined {
  return getSetting(db, FLAGS_LAST_RUN_KEY, z.number().int());
}

/**
 * Runs `detectFlags` over all stored IP hashes and active bans and stores the result. Existing
 * pairs keep their status (a pair marked as ignored is never reopened), only kind, level,
 * evidence and `last_detected` are refreshed.
 */
export function runFlagDetection(database: AppDatabase, now: number): FlagDetectionResult {
  const { sqlite } = database;
  const seen = sqlite
    .prepare(
      `SELECT user_id AS userId, hex(ip_hash) AS ipHash, hex(subnet_hash) AS subnetHash,
              last_seen AS lastSeen
       FROM ip_seen`,
    )
    .all() as SeenIp[];
  const bans = sqlite
    .prepare(
      `SELECT id AS banId, user_id AS userId, hex(ip_hash) AS ipHash,
              hex(subnet_hash) AS subnetHash
       FROM bans WHERE removed_at IS NULL`,
    )
    .all() as { banId: number; userId: number | null; ipHash: string; subnetHash: string }[];
  // hex(NULL) is '' in SQLite.
  const active: ActiveBan[] = bans.map((b) => ({
    ...b,
    ipHash: b.ipHash || null,
    subnetHash: b.subnetHash || null,
  }));

  const candidates = detectFlags(seen, active);
  const exists = sqlite.prepare('SELECT 1 FROM flags WHERE pair_key = ?').pluck();
  const upsert = sqlite.prepare(`
    INSERT INTO flags (pair_key, kind, level, user_id, related_user_id, ban_id, evidence,
      first_detected, last_detected)
    VALUES (@pairKey, @kind, @level, @userId, @relatedUserId, @banId, @evidence, @now, @now)
    ON CONFLICT (pair_key) DO UPDATE SET
      kind = excluded.kind, level = excluded.level, user_id = excluded.user_id,
      related_user_id = excluded.related_user_id, ban_id = excluded.ban_id,
      evidence = excluded.evidence, last_detected = excluded.last_detected`);

  const initial = flagsLastRun(database.db) === undefined;
  return sqlite.transaction(() => {
    const newFlags: FlagCandidate[] = [];
    for (const flag of candidates) {
      if (!exists.get(flag.pairKey)) newFlags.push(flag);
      upsert.run({
        pairKey: flag.pairKey,
        kind: flag.kind,
        level: flag.level,
        userId: flag.userId,
        relatedUserId: flag.relatedUserId,
        banId: flag.banId,
        evidence: JSON.stringify(flag.evidence),
        now,
      });
    }
    setSetting(database.db, FLAGS_LAST_RUN_KEY, now, now);
    return { detected: candidates.length, created: newFlags.length, newFlags, initial };
  })();
}
