import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { linkUsers, upsertUser } from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import { berlinDayStart } from '../domain/time.js';
import { loadLoyaltyState, runLoyaltyJob } from './job.js';

const H = 3600;
const NOW = berlinDayStart(20261016) + 12 * H;

let database: AppDatabase;

beforeEach(() => {
  database = createTestDatabase();
});

afterEach(() => {
  database.close();
});

function player(uid: string): number {
  return upsertUser(database.db, { uid, seenAt: berlinDayStart(20260101) });
}

function online(userId: number, day: number, seconds = H): void {
  database.sqlite
    .prepare(`INSERT INTO user_daily_stats (user_id, day, online_s) VALUES (?, ?, ?)`)
    .run(userId, day, seconds);
}

const players = () =>
  database.sqlite
    .prepare(
      `SELECT user_id AS userId, first_day AS firstDay, last_day AS lastDay, recent_s AS recentS,
              total_s AS totalS FROM loyalty_players ORDER BY user_id`,
    )
    .all();

describe('runLoyaltyJob', () => {
  it('fills the cache tables and replaces them on the next run', () => {
    const a = player('a');
    const b = player('b');
    online(a, 20260105, 2 * H);
    online(a, 20260301);
    online(b, 20261001);
    // Days without online time do not count as a visit.
    online(b, 20261010, 0);

    const state = runLoyaltyJob(database, NOW);
    expect(state).toMatchObject({ computedAt: NOW, persons: 2 });
    expect(loadLoyaltyState(database.db)).toMatchObject({ computedAt: NOW, persons: 2 });
    expect(players()).toEqual([
      { userId: a, firstDay: 20260105, lastDay: 20260301, recentS: 3 * H, totalS: 3 * H },
      { userId: b, firstDay: 20261001, lastDay: 20261001, recentS: H, totalS: H },
    ]);
    const cohorts = database.sqlite
      .prepare(`SELECT month, size, returned_30 AS r30 FROM loyalty_cohorts ORDER BY month`)
      .all();
    expect(cohorts).toEqual([
      { month: 202601, size: 1, r30: 1 },
      { month: 202610, size: 1, r30: 0 },
    ]);
    const months = database.sqlite.prepare(`SELECT count(*) AS n FROM loyalty_months`).get();
    expect(months).toEqual({ n: 10 });

    database.sqlite.prepare(`DELETE FROM user_daily_stats WHERE user_id = ?`).run(a);
    runLoyaltyJob(database, NOW + 86_400);
    expect(players()).toHaveLength(1);
  });

  it('counts linked accounts as one person and leaves hidden players out', () => {
    const main = player('main');
    const alt = player('alt');
    const hidden = player('unknown-dbid-7');
    online(main, 20260105);
    online(alt, 20260105);
    online(alt, 20260210);
    online(hidden, 20260105);
    linkUsers(database.sqlite, main, alt, 'admin', NOW);

    runLoyaltyJob(database, NOW);
    expect(players()).toEqual([
      { userId: main, firstDay: 20260105, lastDay: 20260210, recentS: 3 * H, totalS: 3 * H },
    ]);
  });
});
