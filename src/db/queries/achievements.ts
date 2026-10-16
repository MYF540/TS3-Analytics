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

export interface RecentAchievement {
  userId: number;
  nickname: string | null;
  achievementId: string;
  tier: number;
  earnedAt: number;
}

interface PersonTier {
  subject: number;
  achievementId: string;
  tier: number;
  earnedAt: number;
  backfilled: boolean;
}

/**
 * Every reached tier once per person. Read in one pass and grouped in memory: the table is small
 * (a few rows per player), and grouping in SQL over a join to `persons` cost several times more.
 */
function tiersPerPerson(sqlite: Database.Database): PersonTier[] {
  const primaries = new Map(
    sqlite
      .prepare(
        `SELECT m.user_id, p.primary_user_id FROM person_members m
         JOIN persons p ON p.id = m.person_id`,
      )
      .raw()
      .all() as [number, number][],
  );
  const rows = sqlite
    .prepare(
      `SELECT user_id, achievement_id, tier, earned_at, backfilled FROM achievements_earned
       WHERE user_id NOT IN (${HIDDEN_USERS})`,
    )
    .raw()
    .iterate() as IterableIterator<[number, string, number, number, number]>;
  const byKey = new Map<string, PersonTier>();
  for (const [userId, achievementId, tier, earnedAt, backfilled] of rows) {
    const subject = primaries.get(userId) ?? userId;
    const key = `${String(subject)}:${achievementId}:${String(tier)}`;
    const known = byKey.get(key);
    if (!known) {
      byKey.set(key, { subject, achievementId, tier, earnedAt, backfilled: backfilled === 1 });
    } else {
      known.earnedAt = Math.min(known.earnedAt, earnedAt);
      known.backfilled &&= backfilled === 1;
    }
  }
  return [...byKey.values()];
}

function nicknames(
  sqlite: Database.Database,
  userIds: Iterable<number>,
): Map<number, string | null> {
  const statement = sqlite
    .prepare(
      `SELECT nick FROM nicknames WHERE user_id = ? ORDER BY last_seen DESC, id DESC LIMIT 1`,
    )
    .pluck();
  const result = new Map<number, string | null>();
  for (const id of userIds) {
    if (!result.has(id)) result.set(id, (statement.get(id) as string | undefined) ?? null);
  }
  return result;
}

/**
 * Holders and the latest arrival of every achievement, the number of persons at all, and the
 * latest tiers reached during normal runs. Backfilled tiers are left out of `recent`: after the
 * first run they would all carry old dates and push the really new ones off the list.
 */
export function achievementOverview(
  sqlite: Database.Database,
  achievementIds: readonly string[],
  recentLimit: number,
): { persons: number; achievements: AchievementSummary[]; recent: RecentAchievement[] } {
  const persons = sqlite
    .prepare(
      `SELECT count(DISTINCT COALESCE(p.primary_user_id, t.user_id)) FROM user_totals t
       LEFT JOIN person_members pm ON pm.user_id = t.user_id
       LEFT JOIN persons p ON p.id = pm.person_id
       WHERE t.online_s > 0 AND t.user_id NOT IN (${HIDDEN_USERS})`,
    )
    .pluck()
    .get() as number;

  const wanted = new Set(achievementIds);
  const tiers = tiersPerPerson(sqlite).filter((t) => wanted.has(t.achievementId));
  const newest = (a: PersonTier, b: PersonTier) =>
    b.earnedAt - a.earnedAt || b.tier - a.tier || a.subject - b.subject;

  const byId = new Map<string, { holders: number[]; latest: PersonTier | undefined }>();
  for (const t of tiers) {
    let item = byId.get(t.achievementId);
    if (!item) {
      item = { holders: [], latest: undefined };
      byId.set(t.achievementId, item);
    }
    while (item.holders.length < t.tier) item.holders.push(0);
    item.holders[t.tier - 1] = (item.holders[t.tier - 1] ?? 0) + 1;
    if (!item.latest || newest(t, item.latest) < 0) item.latest = t;
  }
  const recent = tiers
    .filter((t) => !t.backfilled)
    .sort((a, b) => newest(a, b) || a.achievementId.localeCompare(b.achievementId))
    .slice(0, recentLimit);

  const names = nicknames(sqlite, [
    ...[...byId.values()].flatMap((i) => (i.latest ? [i.latest.subject] : [])),
    ...recent.map((r) => r.subject),
  ]);
  return {
    persons,
    achievements: [...byId.entries()].map(([achievementId, item]) => ({
      achievementId,
      holders: item.holders,
      latest: item.latest
        ? {
            userId: item.latest.subject,
            nickname: names.get(item.latest.subject) ?? null,
            tier: item.latest.tier,
            earnedAt: item.latest.earnedAt,
          }
        : null,
    })),
    recent: recent.map((r) => ({
      userId: r.subject,
      nickname: names.get(r.subject) ?? null,
      achievementId: r.achievementId,
      tier: r.tier,
      earnedAt: r.earnedAt,
    })),
  };
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
