/**
 * Achievement job (T13.3). Evaluates the catalog for the persons that were online since the last
 * run and stores newly reached tiers; achievements are never taken away.
 *
 * The first run – and every run after the catalog, the enabled achievements or the linked
 * accounts changed – checks every person and dates each tier as exactly as the history allows.
 * Those tiers are marked `backfilled`: they are shown, but never announced, so switching the
 * feature on does not greet the whole server at once. Tiers found by a normal run are dated to
 * the run (they were reached since the previous one).
 */
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { AppDatabase } from '../db/client.js';
import { getSetting } from '../db/repositories/index.js';
import { HIDDEN_USERS } from '../db/queries/stats.js';
import {
  ACHIEVEMENTS,
  CATALOG_VERSION,
  evaluateAchievements,
  type AchievementDefinition,
} from '../domain/achievements.js';
import { berlinDay } from '../domain/time.js';
import { LEGACY_CUTOFF_KEY } from '../ranks/planner.js';
import { FactsReader, pioneers, primaryMap, recordHours, type GlobalFacts } from './facts.js';
import {
  loadAchievementSettings,
  loadAchievementState,
  saveAchievementState,
  type AchievementState,
} from './settings.js';

export interface AwardedTier {
  /** Account the row was written for: the person's primary account. */
  userId: number;
  achievementId: string;
  tier: number;
  earnedAt: number;
  backfilled: boolean;
}

export interface AchievementJobResult {
  full: boolean;
  /** Persons evaluated. */
  checked: number;
  awarded: AwardedTier[];
}

/** Achievements that are switched on. */
export function enabledAchievements(disabled: readonly string[]): AchievementDefinition[] {
  return ACHIEVEMENTS.filter((a) => !disabled.includes(a.id));
}

function fingerprint(sqlite: Database.Database, disabled: readonly string[]): string {
  const persons = sqlite
    .prepare(
      `SELECT m.user_id, p.primary_user_id FROM person_members m JOIN persons p ON p.id = m.person_id
       ORDER BY m.user_id`,
    )
    .raw()
    .all();
  return JSON.stringify({ version: CATALOG_VERSION, disabled, persons });
}

/** Accounts that were online since `since` (or still are). */
function recentUsers(sqlite: Database.Database, since: number): number[] {
  return sqlite
    .prepare(
      `SELECT DISTINCT user_id FROM sessions WHERE leave_at IS NULL OR leave_at >= ?
       UNION SELECT id FROM users WHERE last_seen >= ?`,
    )
    .pluck()
    .all(since, since) as number[];
}

function visibleUsers(sqlite: Database.Database): Set<number> {
  return new Set(
    sqlite
      .prepare(`SELECT id FROM users WHERE id NOT IN (${HIDDEN_USERS})`)
      .pluck()
      .all() as number[],
  );
}

/** Groups accounts by person: primary account → all its accounts. */
function groupByPerson(
  userIds: Iterable<number>,
  primaries: Map<number, number>,
): Map<number, number[]> {
  const members = new Map<number, number[]>();
  for (const [userId, primary] of primaries) {
    const list = members.get(primary) ?? [];
    list.push(userId);
    members.set(primary, list);
  }
  const result = new Map<number, number[]>();
  for (const userId of userIds) {
    const primary = primaries.get(userId) ?? userId;
    if (!result.has(primary)) result.set(primary, members.get(primary) ?? [userId]);
  }
  return result;
}

export function globalFacts(sqlite: Database.Database, db: AppDatabase['db'], now: number) {
  const primaries = primaryMap(sqlite);
  const cutoff = getSetting(db, LEGACY_CUTOFF_KEY, z.number().int());
  const globals: GlobalFacts = {
    now,
    cutoff,
    cutoffDay: cutoff === undefined ? 0 : berlinDay(cutoff),
    recordHours: recordHours(sqlite),
    pioneers: pioneers(sqlite, primaries),
    topRankId: sqlite
      .prepare(`SELECT id FROM ranks ORDER BY sort_order DESC LIMIT 1`)
      .pluck()
      .get() as number | undefined,
  };
  return { primaries, globals };
}

export function runAchievementJob(database: AppDatabase, now: number): AchievementJobResult {
  const started = Date.now();
  const { sqlite, db } = database;
  const settings = loadAchievementSettings(db);
  const achievements = enabledAchievements(settings.disabled);
  const previous: AchievementState | undefined = loadAchievementState(db);
  const print = fingerprint(sqlite, settings.disabled);
  const full = previous?.fingerprint !== print;

  const { primaries, globals } = globalFacts(sqlite, db, now);
  const visible = visibleUsers(sqlite);
  const candidates =
    previous && !full
      ? recentUsers(sqlite, previous.lastRun).filter((id) => visible.has(id))
      : [...visible];
  const persons = groupByPerson(candidates, primaries);

  const reader = new FactsReader(sqlite, globals);
  const owned = sqlite
    .prepare(
      `SELECT achievement_id || ':' || tier FROM achievements_earned
       WHERE user_id IN (SELECT value FROM json_each(?))`,
    )
    .pluck();
  const awarded: AwardedTier[] = [];
  for (const [primary, userIds] of persons) {
    const ids = userIds.filter((id) => visible.has(id));
    if (ids.length === 0) continue;
    const facts = reader.read(primary, ids);
    if (!facts) continue;
    const have = new Set(owned.all(JSON.stringify(ids)) as string[]);
    for (const reached of evaluateAchievements(facts, achievements)) {
      if (have.has(`${reached.achievementId}:${String(reached.tier)}`)) continue;
      awarded.push({
        userId: primary,
        achievementId: reached.achievementId,
        tier: reached.tier,
        earnedAt: full ? Math.min(reached.at, now) : now,
        backfilled: full,
      });
    }
  }

  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO achievements_earned (user_id, achievement_id, tier, earned_at, backfilled)
     VALUES (?, ?, ?, ?, ?)`,
  );
  sqlite.transaction(() => {
    for (const a of awarded) {
      insert.run(a.userId, a.achievementId, a.tier, a.earnedAt, a.backfilled ? 1 : 0);
    }
    saveAchievementState(
      db,
      {
        lastRun: now,
        fingerprint: print,
        full,
        checked: persons.size,
        awarded: awarded.length,
        seconds: (Date.now() - started) / 1000,
      },
      now,
    );
  })();

  return { full, checked: persons.size, awarded };
}
