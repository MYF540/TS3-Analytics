/**
 * Reads the retention cache (T13.1) written by `src/loyalty/job.ts`. Everything here is a plain
 * read of small tables; the expensive part runs once a day in the job.
 */
import type Database from 'better-sqlite3';
import { HIDDEN_USERS } from './stats.js';

export interface LoyaltyCohort {
  month: number;
  size: number;
  /** Per return check (7, 30, 90 days): persons whose first visit is long enough ago. */
  eligible: number[];
  /** Of those, persons online again on that day or later. */
  returned: number[];
}

export interface LoyaltyMonth {
  month: number;
  active: number;
  newcomers: number;
  returners: number;
  lost: number;
}

export function loyaltyCohorts(sqlite: Database.Database): LoyaltyCohort[] {
  const rows = sqlite
    .prepare(
      `SELECT month, size, eligible_7, returned_7, eligible_30, returned_30, eligible_90,
              returned_90 FROM loyalty_cohorts ORDER BY month`,
    )
    .raw()
    .all() as number[][];
  return rows.map(([month = 0, size = 0, e7 = 0, r7 = 0, e30 = 0, r30 = 0, e90 = 0, r90 = 0]) => ({
    month,
    size,
    eligible: [e7, e30, e90],
    returned: [r7, r30, r90],
  }));
}

export function loyaltyMonths(sqlite: Database.Database): LoyaltyMonth[] {
  return sqlite
    .prepare(`SELECT month, active, newcomers, returners, lost FROM loyalty_months ORDER BY month`)
    .all() as LoyaltyMonth[];
}

export interface MissingRegular {
  userId: number;
  nickname: string | null;
  lastDay: number;
  recentS: number;
  totalS: number;
  rank: string | null;
}

/**
 * Persons with at least `minRecentS` online in the 90 days before their last visit whose last
 * visit was on `lastDayBefore` or earlier. Most recently missing first.
 */
export function missingRegulars(
  sqlite: Database.Database,
  filter: { minRecentS: number; lastDayBefore: number; limit: number; offset: number },
): { total: number; items: MissingRegular[] } {
  const where = `p.last_day <= @lastDay AND p.recent_s >= @minRecentS
    AND p.user_id NOT IN (${HIDDEN_USERS})`;
  const params = { lastDay: filter.lastDayBefore, minRecentS: filter.minRecentS };
  const total = sqlite
    .prepare(`SELECT count(*) FROM loyalty_players p WHERE ${where}`)
    .pluck()
    .get(params) as number;
  const items = sqlite
    .prepare(
      `SELECT p.user_id AS userId,
              (SELECT n.nick FROM nicknames n WHERE n.user_id = p.user_id
               ORDER BY n.last_seen DESC, n.id DESC LIMIT 1) AS nickname,
              p.last_day AS lastDay, p.recent_s AS recentS, p.total_s AS totalS,
              r.name AS rank
       FROM loyalty_players p
       LEFT JOIN rank_state s ON s.user_id = p.user_id
       LEFT JOIN ranks r ON r.id = s.rank_id
       WHERE ${where}
       ORDER BY p.last_day DESC, p.recent_s DESC, p.user_id
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: filter.limit, offset: filter.offset }) as MissingRegular[];
  return { total, items };
}
