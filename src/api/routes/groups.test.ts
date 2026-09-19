import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import { loadGroupWatch, saveGroupWatch } from '../../watcher/group-settings.js';
import type { ApiContext } from '../context.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

let database: AppDatabase;
let context: ApiContext;
let app: FastifyInstance;
let admin: string;

beforeEach(async () => {
  database = createTestDatabase();
  saveGroupWatch(database.db, { knownGroups: [{ id: 6, name: 'Server Admin' }] }, 0);
  const insert = database.sqlite.prepare(
    `INSERT INTO group_changes (at, log_pos, action, dbid, nickname, group_id, group_name,
       invoker_name, invoker_dbid, protected) VALUES (?, ?, ?, 17, 'Bob', ?, ?, 'Admin', 2, ?)`,
  );
  insert.run(100, 100_000_000, 'added', 6, 'Server Admin', 1);
  insert.run(200, 200_000_000, 'removed', 8, 'Guest', 0);
  context = createTestContext(database);
  admin = sessionCookie(context, 'admin');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

describe('group routes', () => {
  it('saves protected groups and keeps the known list', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/groups',
      headers: { cookie: admin },
      payload: { protectedGroupIds: [6, 6, 3] },
    });
    expect(res.json()).toEqual({
      protectedGroupIds: [3, 6],
      knownGroups: [{ id: 6, name: 'Server Admin' }],
    });
    expect(loadGroupWatch(database.db).protectedGroupIds).toEqual([3, 6]);
  });

  it('lists group changes newest first, optionally protected only', async () => {
    const moderator = sessionCookie(context, 'moderator');
    const all = await app.inject({ url: '/api/group-changes', headers: { cookie: moderator } });
    expect(all.json<{ items: { groupName: string; protected: boolean }[] }>().items).toEqual([
      expect.objectContaining({ groupName: 'Guest', action: 'removed', protected: false }),
      expect.objectContaining({ groupName: 'Server Admin', action: 'added', protected: true }),
    ]);
    const only = await app.inject({
      url: '/api/group-changes?protectedOnly=true',
      headers: { cookie: moderator },
    });
    expect(only.json<{ total: number }>().total).toBe(1);
    const viewer = sessionCookie(context, 'viewer');
    expect(
      (await app.inject({ url: '/api/group-changes', headers: { cookie: viewer } })).statusCode,
    ).toBe(403);
  });
});
