/**
 * Reads earned achievements (T13.4). Rows belong to single accounts; every query here combines
 * them per person (its primary account), so linked accounts show one set of badges.
 */
import type Database from 'better-sqlite3';
import { HIDDEN_USERS } from './stats.js';

const NICKNAME = (alias: string) => `(SELECT n.nick FROM nicknames n WHERE n.user_id = ${alias}
  ORDER BY n.last_seen DESC, n.id DESC LIMIT 1)`;

/** Earned rows of visible accounts with the person they count for (`subject`). */
const EARNED = `SELECT COALESCE(p.primary_user_id, a.user_id) AS subject, a.achievement_id,
    a.tier, a.earned_at, a.backfilled
  FROM achievements_earned a
  LEFT JOIN person_members pm ON pm.user_id = a.user_id
  LEFT JOIN persons p ON p.id = pm.person_id
  WHERE a.user_id NOT IN (${HIDDEN_USERS})`;

/** Per person and tier only the first time it was reached (two accounts may both hold it). */
const EARNED_PER_PERSON = `SELECT subject, achievement_id, tier, min(earned_at) AS earned_at,
    min(backfilled) AS backfilled
  FROM (${EARNED}) GROUP BY subject, achievement_id, tier`;

export interface EarnedTier {
  achievementId: string;
  tier: number;
  earnedAt: number;
  backfilled: boolean;
}

/** Everything the person with these accounts has reached. */
export function personAchievements(
  sqlite: Database.Database,
  userIds: readonly number[],
): EarnedTier[] {
  const rows = sqlite
    .prepare(
      `SELECT achievement_id AS achievementId, tier, min(earned_at) AS earnedAt,
              min(backfilled) AS backfilled
       FROM achievements_earned WHERE user_id IN (SELECT value FROM json_each(?))
       GROUP BY achievement_id, tier ORDER BY achievement_id, tier`,
    )
    .all(JSON.stringify(userIds)) as {
    achievementId: string;
    tier: number;
    earnedAt: number;
    backfilled: number;
  }[];
  return rows.map((r) => ({ ...r, backfilled: r.backfilled === 1 }));
}

export interface AchievementSummary {
  achievementId: string;
  /** Persons per tier (index 0 = tier 1). */
  holders: number[];
  /** Most recent person to reach any tier. */
  latest: { userId: number; nickname: string | null; tier: number; earnedAt: number } | null;
}

/** Holders and the latest arrival of every achievement, plus the number of persons at all. */
export function achievementSummary(sqlite: Database.Database): {
  persons: number;
  achievements: AchievementSummary[];
} {
  const persons = sqlite
    .prepare(
      `SELECT count(DISTINCT COALESCE(p.primary_user_id, t.user_id)) FROM user_totals t
       LEFT JOIN person_members pm ON pm.user_id = t.user_id
       LEFT JOIN persons p ON p.id = pm.person_id
       WHERE t.online_s > 0 AND t.user_id NOT IN (${HIDDEN_USERS})`,
    )
    .pluck()
    .get() as number;

  const counts = sqlite
    .prepare(
      `SELECT achievement_id AS id, tier, count(*) AS n FROM (${EARNED_PER_PERSON})
       GROUP BY achievement_id, tier`,
    )
    .all() as { id: string; tier: number; n: number }[];

  const latest = sqlite
    .prepare(
      `SELECT achievement_id AS id, subject AS userId, ${NICKNAME('subject')} AS nickname, tier,
              earned_at AS earnedAt
       FROM (SELECT *, row_number() OVER (
               PARTITION BY achievement_id ORDER BY earned_at DESC, tier DESC, subject) AS pos
             FROM (${EARNED_PER_PERSON}))
       WHERE pos = 1`,
    )
    .all() as {
    id: string;
    userId: number;
    nickname: string | null;
    tier: number;
    earnedAt: number;
  }[];

  const byId = new Map<string, AchievementSummary>();
  const entry = (id: string) => {
    let item = byId.get(id);
    if (!item) {
      item = { achievementId: id, holders: [], latest: null };
      byId.set(id, item);
    }
    return item;
  };
  for (const c of counts) {
    const item = entry(c.id);
    while (item.holders.length < c.tier) item.holders.push(0);
    item.holders[c.tier - 1] = c.n;
  }
  for (const { id, ...rest } of latest) entry(id).latest = rest;
  return { persons, achievements: [...byId.values()] };
}

export interface RecentAchievement {
  userId: number;
  nickname: string | null;
  achievementId: string;
  tier: number;
  earnedAt: number;
}

/**
 * The latest tiers reached during normal runs. Backfilled ones are left out: after the first run
 * they would all carry old dates and push the really new ones off the list.
 */
export function recentAchievements(
  sqlite: Database.Database,
  achievementIds: readonly string[],
  limit: number,
): RecentAchievement[] {
  return sqlite
    .prepare(
      `SELECT subject AS userId, ${NICKNAME('subject')} AS nickname,
              achievement_id AS achievementId, tier, earned_at AS earnedAt
       FROM (${EARNED_PER_PERSON})
       WHERE backfilled = 0 AND achievement_id IN (SELECT value FROM json_each(?))
       ORDER BY earned_at DESC, subject, achievement_id, tier DESC LIMIT ?`,
    )
    .all(JSON.stringify(achievementIds), limit) as RecentAchievement[];
}

export interface AchievementHolder {
  userId: number;
  nickname: string | null;
  /** Highest tier the person holds. */
  tier: number;
  /** When that tier was reached. */
  earnedAt: number;
}

/** Persons holding an achievement, highest tier first, earliest first within a tier. */
export function achievementHolders(
  sqlite: Database.Database,
  achievementId: string,
  page: { limit: number; offset: number },
): { total: number; holders: AchievementHolder[] } {
  const best = `SELECT subject, max(tier) AS tier FROM (${EARNED_PER_PERSON})
    WHERE achievement_id = ? GROUP BY subject`;
  const total = sqlite
    .prepare(`SELECT count(*) FROM (${best})`)
    .pluck()
    .get(achievementId) as number;
  const holders = sqlite
    .prepare(
      `SELECT b.subject AS userId, ${NICKNAME('b.subject')} AS nickname, b.tier,
              e.earned_at AS earnedAt
       FROM (${best}) b
       JOIN (${EARNED_PER_PERSON}) e
         ON e.subject = b.subject AND e.achievement_id = ? AND e.tier = b.tier
       ORDER BY b.tier DESC, e.earned_at, b.subject
       LIMIT ? OFFSET ?`,
    )
    .all(achievementId, achievementId, page.limit, page.offset) as AchievementHolder[];
  return { total, holders };
}
