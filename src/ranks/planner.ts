import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getSetting, listRanks, type DbExecutor, type Rank } from '../db/repositories/index.js';
import { berlinDay } from '../domain/time.js';
import { decideRank, mergeOverrides, type RankDecision } from '../domain/ranks.js';
import type { RankSettings } from './settings.js';

export interface RankPlanEntry {
  /** The person's primary user (or the user itself when not linked). */
  primaryUserId: number;
  /** All linked users; the rank group is set on each of them. */
  userIds: number[];
  rankingS: number;
  /** Rank the job last decided for this person (`rank_state`), null = none. */
  currentRankId: number | null;
  /** Whether a decision exists at all (a new user has none yet). */
  known: boolean;
  decision: RankDecision;
}

export interface RankPlanOptions {
  /** Days (Berlin, YYYYMMDD) before this are covered by the legacy ranking time (Phase 8). */
  cutoffDay: number;
  /** Legacy ranking seconds per user (Phase 8); empty until the import exists. */
  legacyS?: ReadonlyMap<number, number>;
}

/**
 * Ranking time per user (AGENTS.md rule 12): live time from the daily aggregates since the cutoff,
 * without imported time (`unknown_s` holds imported sessions), plus legacy ranking time.
 */
export function rankingTimes(
  sqlite: Database.Database,
  mode: RankSettings['countMode'],
  options: RankPlanOptions,
): Map<number, number> {
  const expression = mode === 'active' ? 'sum(active_s)' : 'sum(online_s - unknown_s)';
  const rows = sqlite
    .prepare(
      `SELECT user_id AS userId, ${expression} AS seconds FROM user_daily_stats
       WHERE day >= ? GROUP BY user_id`,
    )
    .all(options.cutoffDay) as { userId: number; seconds: number }[];
  const times = new Map(rows.map((r) => [r.userId, Math.max(0, r.seconds)]));
  for (const [userId, seconds] of options.legacyS ?? []) {
    times.set(userId, (times.get(userId) ?? 0) + seconds);
  }
  return times;
}

function parseGroups(json: string | null): number[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
  } catch {
    return [];
  }
}

/**
 * Target rank for every person that has ranking time, an override or a previous decision.
 * `userIds` limits the plan to the persons of these users (incremental runs, T6.3).
 */
export function planRanks(
  sqlite: Database.Database,
  settings: RankSettings,
  options: RankPlanOptions,
  userIds?: readonly number[],
): { ladder: Rank[]; entries: RankPlanEntry[] } {
  const ladder = listRanks(sqlite);
  const times = rankingTimes(sqlite, settings.countMode, options);
  const overrides = sqlite
    .prepare(
      'SELECT user_id AS userId, frozen_rank_id AS frozenRankId, bonus_s AS bonusS, excluded FROM rank_overrides',
    )
    .all() as { userId: number; frozenRankId: number | null; bonusS: number; excluded: number }[];
  const states = new Map(
    (
      sqlite.prepare('SELECT user_id AS userId, rank_id AS rankId FROM rank_state').all() as {
        userId: number;
        rankId: number | null;
      }[]
    ).map((s) => [s.userId, s.rankId]),
  );
  const members = sqlite
    .prepare(
      `SELECT m.user_id AS userId, p.primary_user_id AS primaryUserId
       FROM person_members m JOIN persons p ON p.id = m.person_id`,
    )
    .all() as { userId: number; primaryUserId: number }[];
  const primaryOf = new Map(members.map((m) => [m.userId, m.primaryUserId]));
  const excludedGroups = new Set(settings.excludedGroupIds);
  // Only needed with excluded groups; one query instead of one per user.
  const groupsById = new Map(
    excludedGroups.size === 0
      ? []
      : (
          sqlite
            .prepare(
              'SELECT id, server_groups AS groups FROM users WHERE server_groups IS NOT NULL',
            )
            .all() as { id: number; groups: string }[]
        ).map((u) => [u.id, parseGroups(u.groups)]),
  );

  // Everyone relevant, grouped by person.
  const relevant = new Set<number>([
    ...times.keys(),
    ...overrides.map((o) => o.userId),
    ...states.keys(),
  ]);
  const persons = new Map<number, number[]>();
  for (const userId of relevant) {
    const primary = primaryOf.get(userId) ?? userId;
    const list = persons.get(primary) ?? [];
    list.push(userId);
    persons.set(primary, list);
  }
  // Linked accounts without time still belong to their person.
  for (const m of members) {
    const list = persons.get(m.primaryUserId);
    if (list && !list.includes(m.userId)) list.push(m.userId);
  }
  let selected = [...persons.entries()];
  if (userIds) {
    const wanted = new Set(userIds.map((id) => primaryOf.get(id) ?? id));
    selected = selected.filter(([primary]) => wanted.has(primary));
  }

  const entries: RankPlanEntry[] = selected.map(([primaryUserId, ids]) => {
    const sorted = [...ids].sort((a, b) => a - b);
    const rankingS = sorted.reduce((sum, id) => sum + (times.get(id) ?? 0), 0);
    const override = mergeOverrides(
      overrides
        .filter((o) => sorted.includes(o.userId))
        .map((o) => ({ ...o, excluded: o.excluded === 1 })),
      primaryUserId,
    );
    const inExcludedGroup =
      excludedGroups.size > 0 &&
      sorted.some((id) => (groupsById.get(id) ?? []).some((g) => excludedGroups.has(g)));
    const known = sorted.some((id) => states.has(id));
    return {
      primaryUserId,
      userIds: sorted,
      rankingS,
      currentRankId: states.get(primaryUserId) ?? states.get(sorted[0] ?? primaryUserId) ?? null,
      known,
      decision: decideRank(ladder, { rankingS, override, inExcludedGroup }),
    };
  });
  return { ladder, entries };
}

export const LEGACY_CUTOFF_KEY = 'legacy.cutoff';

/** Cutoff between legacy and live ranking time (set by the legacy import, Phase 8). */
export function planOptions(db: DbExecutor): RankPlanOptions {
  const cutoff = getSetting(db, LEGACY_CUTOFF_KEY, z.number().int());
  return { cutoffDay: cutoff === undefined ? 0 : berlinDay(cutoff) };
}
