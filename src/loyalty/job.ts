/**
 * Loyalty job (T13.1). Once a day it reads the days every person was online, computes cohorts,
 * the monthly balance and one summary row per person (`src/domain/loyalty.ts`) and replaces the
 * cache tables in one transaction. The loyalty page only reads those tables.
 */
import { z } from 'zod';
import type { AppDatabase } from '../db/client.js';
import { getSetting, setSetting, type DbExecutor } from '../db/repositories/index.js';
import { HIDDEN_USERS } from '../db/queries/stats.js';
import {
  cohorts,
  mergeActivity,
  monthlyBalance,
  personSummary,
  type PersonActivity,
} from '../domain/loyalty.js';
import { berlinDay } from '../domain/time.js';
import { primaryMap } from '../achievements/facts.js';

export const LOYALTY_STATE_KEY = 'loyalty.state';

export const loyaltyStateSchema = z.object({
  computedAt: z.number().int(),
  persons: z.number().int(),
  seconds: z.number(),
});

export type LoyaltyState = z.infer<typeof loyaltyStateSchema>;

export function loadLoyaltyState(db: DbExecutor): LoyaltyState | undefined {
  return getSetting(db, LOYALTY_STATE_KEY, loyaltyStateSchema);
}

/** Days with online time per person; linked accounts are merged into their primary account. */
function activities(database: AppDatabase): PersonActivity[] {
  const primaries = primaryMap(database.sqlite);
  const rows = database.sqlite
    .prepare(
      `SELECT user_id, day, online_s FROM user_daily_stats
       WHERE online_s > 0 AND user_id NOT IN (${HIDDEN_USERS})
       ORDER BY user_id, day`,
    )
    .raw()
    .iterate() as IterableIterator<[number, number, number]>;
  const accounts = new Map<number, PersonActivity[]>();
  let current: { subject: number; days: number[]; seconds: number[] } | undefined;
  let currentUser: number | undefined;
  for (const [userId, day, onlineS] of rows) {
    if (userId !== currentUser) {
      currentUser = userId;
      const subject = primaries.get(userId) ?? userId;
      current = { subject, days: [], seconds: [] };
      const list = accounts.get(subject);
      if (list) list.push(current);
      else accounts.set(subject, [current]);
    }
    current?.days.push(day);
    current?.seconds.push(onlineS);
  }
  return [...accounts.entries()].map(([subject, list]) => mergeActivity(subject, list));
}

export function runLoyaltyJob(database: AppDatabase, now: number): LoyaltyState {
  const started = performance.now();
  const today = berlinDay(now);
  const persons = activities(database);
  const cohortRows = cohorts(persons, today);
  const monthRows = monthlyBalance(persons, today);
  const summaries = persons.flatMap((p) => personSummary(p) ?? []);
  const { sqlite } = database;

  const state: LoyaltyState = {
    computedAt: now,
    persons: summaries.length,
    seconds: 0,
  };
  sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM loyalty_cohorts`).run();
    sqlite.prepare(`DELETE FROM loyalty_months`).run();
    sqlite.prepare(`DELETE FROM loyalty_players`).run();
    const cohort = sqlite.prepare(
      `INSERT INTO loyalty_cohorts (month, size, eligible_7, returned_7, eligible_30, returned_30,
         eligible_90, returned_90) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of cohortRows) {
      cohort.run(
        r.month,
        r.size,
        r.eligible[0] ?? 0,
        r.returned[0] ?? 0,
        r.eligible[1] ?? 0,
        r.returned[1] ?? 0,
        r.eligible[2] ?? 0,
        r.returned[2] ?? 0,
      );
    }
    const month = sqlite.prepare(
      `INSERT INTO loyalty_months (month, active, newcomers, returners, lost) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of monthRows) month.run(r.month, r.active, r.new, r.returning, r.lost);
    const player = sqlite.prepare(
      `INSERT INTO loyalty_players (user_id, first_day, last_day, recent_s, total_s)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const s of summaries) player.run(s.subject, s.firstDay, s.lastDay, s.recentS, s.totalS);
    state.seconds = Math.round(performance.now() - started) / 1000;
    setSetting(database.db, LOYALTY_STATE_KEY, state, now);
  })();
  return state;
}
