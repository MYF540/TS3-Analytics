import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../api/server.js';
import { createTestContext, sessionCookie } from '../api/testing.js';
import type { AppDatabase } from '../db/client.js';
import {
  linkUsers,
  recordNickname,
  replaceRanks,
  setRankOverride,
  setSetting,
  upsertUser,
  type Rank,
} from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import { LEGACY_CUTOFF_KEY, planOptions, planRanks, rankingTimes } from './planner.js';
import { loadRankSettings, saveRankSettings } from './settings.js';

const H = 3600;
let database: AppDatabase;
let ladder: Rank[];

function user(uid: string, groups?: number[]): number {
  const id = upsertUser(database.db, { uid, seenAt: 1, serverGroups: groups });
  recordNickname(database.db, id, uid.replace('=', ''), 1);
  return id;
}

/** Daily aggregate row: live online time, imported part and active part. */
function day(userId: number, dayNumber: number, onlineS: number, unknownS = 0, activeS = 0) {
  database.sqlite
    .prepare(
      `INSERT INTO user_daily_stats (user_id, day, online_s, active_s, idle_s, afk_s, unknown_s,
         sessions, longest_session_s)
       VALUES (?, ?, ?, ?, 0, 0, ?, 1, ?)`,
    )
    .run(userId, dayNumber, onlineS, activeS, unknownS, onlineS);
}

beforeEach(() => {
  database = createTestDatabase();
  ladder = replaceRanks(
    database.sqlite,
    [
      { name: 'Neuling', requiredS: H, serverGroupId: 10 },
      { name: 'Stammgast', requiredS: 50 * H, serverGroupId: 11 },
    ],
    1,
  );
});

afterEach(() => {
  database.close();
});

describe('rankingTimes', () => {
  it('ignores imported time and counts only days since the cutoff', () => {
    const a = user('a=');
    day(a, 20260101, 10 * H, 4 * H, 2 * H);
    day(a, 20260301, 5 * H, 0, 5 * H);
    expect(rankingTimes(database.sqlite, 'online', { cutoffDay: 0 }).get(a)).toBe(11 * H);
    expect(rankingTimes(database.sqlite, 'active', { cutoffDay: 0 }).get(a)).toBe(7 * H);
    expect(rankingTimes(database.sqlite, 'online', { cutoffDay: 20260201 }).get(a)).toBe(5 * H);
    // Time taken over from the old ranking system counts on top (T8.9).
    database.sqlite.prepare(`UPDATE users SET legacy_seconds = ? WHERE id = ?`).run(100 * H, a);
    expect(rankingTimes(database.sqlite, 'online', { cutoffDay: 20260201 }).get(a)).toBe(105 * H);
    expect(rankingTimes(database.sqlite, 'online', { cutoffDay: 20260201 }, [a]).get(a)).toBe(
      105 * H,
    );
  });

  it('reads the legacy cutoff setting', () => {
    expect(planOptions(database.db)).toEqual({ cutoffDay: 0 });
    setSetting(database.db, LEGACY_CUTOFF_KEY, Date.UTC(2026, 1, 1, 12) / 1000, 1);
    expect(planOptions(database.db)).toEqual({ cutoffDay: 20260201 });
  });
});

describe('planRanks', () => {
  it('combines linked accounts and their overrides, and skips excluded groups', () => {
    const main = user('main=');
    const alt = user('alt=');
    const admin = user('admin=', [6]);
    const lazy = user('lazy=');
    day(main, 20260101, 30 * H);
    day(alt, 20260101, 25 * H);
    day(admin, 20260101, 100 * H);
    day(lazy, 20260101, 30 * 60);
    linkUsers(database.sqlite, main, alt, 'mod', 1);
    setRankOverride(
      database.sqlite,
      { userId: lazy, frozenRankId: null, bonusS: H, excluded: false, note: null },
      'admin',
      1,
    );
    saveRankSettings(database.db, { excludedGroupIds: [6] }, 1);

    const { entries } = planRanks(database.sqlite, loadRankSettings(database.db), { cutoffDay: 0 });
    const byUser = new Map(entries.map((e) => [e.primaryUserId, e]));
    expect(byUser.get(main)).toMatchObject({
      userIds: [main, alt],
      rankingS: 55 * H,
      decision: { kind: 'rank', rankId: ladder[1]?.id },
    });
    expect(byUser.has(alt)).toBe(false);
    expect(byUser.get(admin)?.decision).toEqual({ kind: 'skip', reason: 'excluded_group' });
    expect(byUser.get(lazy)?.decision).toMatchObject({
      rankId: ladder[0]?.id,
      effectiveS: 1.5 * H,
    });

    const only = planRanks(database.sqlite, loadRankSettings(database.db), { cutoffDay: 0 }, [alt]);
    expect(only.entries.map((e) => e.primaryUserId)).toEqual([main]);
  });
});

describe('GET /api/ranks/preview', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('lists promotions and demotions compared with the last decisions', async () => {
    const up = user('up=');
    const down = user('down=');
    const same = user('same=');
    const tiny = user('tiny=');
    day(up, 20260101, 60 * H);
    day(down, 20260101, 2 * H);
    day(same, 20260101, 2 * H);
    day(tiny, 20260101, 60);
    const state = database.sqlite.prepare(
      'INSERT INTO rank_state (user_id, rank_id, pending, decided_at) VALUES (?, ?, 0, 1)',
    );
    state.run(up, ladder[0]?.id);
    state.run(down, ladder[1]?.id);
    state.run(same, ladder[0]?.id);

    const context = createTestContext(database);
    app = await buildServer(context);
    const res = await app.inject({
      url: '/api/ranks/preview',
      headers: { cookie: sessionCookie(context, 'admin') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      dryRun: true,
      counts: { up: 1, down: 1, skipped: 0 },
      changes: [
        {
          userId: up,
          nickname: 'up',
          accounts: 1,
          rankingS: 60 * H,
          fromRankId: ladder[0]?.id,
          toRankId: ladder[1]?.id,
          fromRankName: 'Neuling',
          toRankName: 'Stammgast',
          direction: 'up',
          frozen: false,
        },
        expect.objectContaining({ userId: down, direction: 'down', toRankId: ladder[0]?.id }),
      ],
    });
    const moderator = await app.inject({
      url: '/api/ranks/preview',
      headers: { cookie: sessionCookie(context, 'moderator') },
    });
    expect(moderator.statusCode).toBe(403);
  });
});
