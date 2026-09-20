/**
 * Compares the two sources of historical playtime per player (T8.10): the time reconstructed
 * from the old server logs and the value the old ranking system had stored.
 *
 * They measure different things, so they never match exactly – the logs know every connection
 * but only as far back as the files reach, while the ranking script only counted while it was
 * running. Large differences point at gaps in one of the two, and the admin decides which value
 * counts for the ranks.
 */
import type Database from 'better-sqlite3';

export interface ImportComparisonItem {
  userId: number;
  nickname: string | null;
  /** Placeholder without a UID (T8.3); there is nothing from the ranking system for it. */
  placeholder: boolean;
  /** Online time of the imported sessions, seconds. */
  logS: number;
  /** Ranking time taken over from the old system, seconds. */
  legacyS: number;
  /** `logS - legacyS`; negative means the ranking system had more. */
  diffS: number;
}

export interface ImportComparison {
  items: ImportComparisonItem[];
  total: number;
  /** Players whose two values are within the tolerance. */
  matching: number;
}

const NICKNAME = `(SELECT n.nick FROM nicknames n WHERE n.user_id = u.id
  ORDER BY n.last_seen DESC, n.id DESC LIMIT 1)`;

/**
 * Players that have at least one of the two values, biggest difference first.
 * `toleranceS` decides what still counts as matching.
 */
export function compareImportedTimes(
  sqlite: Database.Database,
  options: {
    limit: number;
    offset: number;
    toleranceS: number;
    /** Only players both sources know – everything else cannot be compared, only listed. */
    bothSources: boolean;
  },
): ImportComparison {
  const rows = sqlite
    .prepare(
      `WITH log AS (
         SELECT user_id, sum(duration) AS seconds FROM sessions
         WHERE source = 'import' AND duration IS NOT NULL
         GROUP BY user_id
       )
       SELECT u.id AS userId, ${NICKNAME} AS nickname,
              u.uid LIKE 'unknown-dbid-%' AS placeholder,
              coalesce(log.seconds, 0) AS logS, u.legacy_seconds AS legacyS
       FROM users u LEFT JOIN log ON log.user_id = u.id
       WHERE u.anonymized_at IS NULL AND ${
         options.bothSources
           ? 'log.seconds > 0 AND u.legacy_seconds > 0'
           : '(log.seconds > 0 OR u.legacy_seconds > 0)'
       }`,
    )
    .all() as {
    userId: number;
    nickname: string | null;
    placeholder: number;
    logS: number;
    legacyS: number;
  }[];

  const items = rows
    .map((row) => ({
      userId: row.userId,
      nickname: row.nickname,
      placeholder: row.placeholder === 1,
      logS: row.logS,
      legacyS: row.legacyS,
      diffS: row.logS - row.legacyS,
    }))
    .sort((a, b) => Math.abs(b.diffS) - Math.abs(a.diffS) || a.userId - b.userId);

  return {
    items: items.slice(options.offset, options.offset + options.limit),
    total: items.length,
    matching: items.filter((item) => Math.abs(item.diffS) <= options.toleranceS).length,
  };
}

/** The imported log time of one player, the value an admin can take over as ranking time. */
export function importedLogSeconds(sqlite: Database.Database, userId: number): number {
  const seconds = sqlite
    .prepare(
      `SELECT coalesce(sum(duration), 0) FROM sessions
       WHERE user_id = ? AND source = 'import' AND duration IS NOT NULL`,
    )
    .pluck()
    .get(userId) as number;
  return seconds;
}
