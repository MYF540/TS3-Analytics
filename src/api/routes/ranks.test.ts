import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { listRanks, recordNickname, upsertUser } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { loadRankSettings } from '../../ranks/settings.js';
import { saveGroupWatch } from '../../watcher/group-settings.js';
import type { ApiContext } from '../context.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const H = 3600;
let database: AppDatabase;
let context: ApiContext;
let app: FastifyInstance;
let admin: string;
const run = vi.fn();

const settings = {
  countMode: 'online',
  excludedGroupIds: [],
  dryRun: true,
  intervalMinutes: 10,
  promotionMessage: { enabled: true, text: 'Neuer Rang: {rank}' },
};

beforeEach(async () => {
  run.mockReset();
  database = createTestDatabase();
  saveGroupWatch(database.db, { knownGroups: [{ id: 10, name: 'Rang 1' }] }, 0);
  const id = upsertUser(database.db, { uid: 'a=', seenAt: 1 });
  recordNickname(database.db, id, 'Alice', 1);
  database.sqlite
    .prepare(
      `INSERT INTO user_daily_stats (user_id, day, online_s, active_s, idle_s, afk_s, unknown_s,
         sessions, longest_session_s) VALUES (?, 20260901, ?, 0, 0, 0, 0, 1, 0)`,
    )
    .run(id, 60 * H);
  context = createTestContext(database, { ranks: { run } });
  admin = sessionCookie(context, 'admin');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

function send(method: 'PUT' | 'POST', url: string, payload?: object) {
  return app.inject({ method, url, headers: { cookie: admin }, ...(payload ? { payload } : {}) });
}

describe('rank configuration API', () => {
  it('saves the ladder sorted by required time together with the settings', async () => {
    const res = await send('PUT', '/api/ranks', {
      ranks: [
        { name: 'Stammgast', requiredS: 50 * H, serverGroupId: 11 },
        { name: 'Neuling', requiredS: H, serverGroupId: 10 },
      ],
      settings: { ...settings, dryRun: false },
    });
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json<{ ranks: { name: string; sortOrder: number }[] }>()
        .ranks.map((r) => [r.name, r.sortOrder]),
    ).toEqual([
      ['Neuling', 1],
      ['Stammgast', 2],
    ]);
    expect(loadRankSettings(database.db).dryRun).toBe(false);
    const get = await app.inject({ url: '/api/ranks', headers: { cookie: admin } });
    expect(get.json()).toMatchObject({
      knownGroups: [{ id: 10, name: 'Rang 1' }],
      lastRun: null,
      settings: { promotionMessage: { text: 'Neuer Rang: {rank}' } },
    });
  });

  it('rejects duplicate groups and equal times', async () => {
    const dup = await send('PUT', '/api/ranks', {
      ranks: [
        { name: 'A', requiredS: H, serverGroupId: 10 },
        { name: 'B', requiredS: 2 * H, serverGroupId: 10 },
      ],
      settings,
    });
    expect(dup.json()).toMatchObject({ error: { code: 'DUPLICATE_GROUP' } });
    const equal = await send('PUT', '/api/ranks', {
      ranks: [
        { name: 'A', requiredS: H, serverGroupId: 10 },
        { name: 'B', requiredS: H, serverGroupId: 11 },
      ],
      settings,
    });
    expect(equal.json()).toMatchObject({ error: { code: 'NOT_ASCENDING' } });
  });

  it('previews a draft without saving it', async () => {
    const res = await send('POST', '/api/ranks/preview', {
      ranks: [
        { name: 'Neuling', requiredS: H, serverGroupId: 10 },
        { name: 'Stammgast', requiredS: 50 * H, serverGroupId: 11 },
      ],
      settings,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      counts: { up: 1, down: 0, skipped: 0 },
      changes: [{ nickname: 'Alice', rankingS: 60 * H, fromRankId: null, direction: 'up' }],
    });
    expect(listRanks(database.sqlite)).toEqual([]);
    expect(loadRankSettings(database.db).promotionMessage.text).not.toBe('Neuer Rang: {rank}');
  });

  it('runs the job on request and lists the history', async () => {
    run.mockResolvedValue({
      full: true,
      dryRun: true,
      checked: 1,
      changed: 1,
      commands: 0,
      pending: 0,
      failed: 0,
    });
    const res = await send('POST', '/api/ranks/run');
    expect(res.json()).toMatchObject({ skipped: null, checked: 1 });
    expect(run).toHaveBeenCalledWith({ full: true });

    const [rank] = (
      await send('PUT', '/api/ranks', {
        ranks: [{ name: 'Neuling', requiredS: H, serverGroupId: 10 }],
        settings,
      })
    ).json<{ ranks: { id: number }[] }>().ranks;
    database.sqlite
      .prepare(
        `INSERT INTO rank_history (at, user_id, from_rank_id, to_rank_id, ranking_s, dry_run, outcome)
         VALUES (5, 1, NULL, ?, 216000, 1, 'dry_run')`,
      )
      .run(rank?.id);
    const history = await app.inject({ url: '/api/ranks/history', headers: { cookie: admin } });
    expect(history.json()).toMatchObject({
      total: 1,
      items: [{ nickname: 'Alice', toRankId: rank?.id, dryRun: true, outcome: 'dry_run' }],
    });
  });

  it('is admin-only', async () => {
    const res = await app.inject({
      url: '/api/ranks',
      headers: { cookie: sessionCookie(context, 'moderator') },
    });
    expect(res.statusCode).toBe(403);
  });
});
