import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAutomationLog } from '../../automation/log.js';
import { moduleStates } from '../../automation/registry.js';
import { moduleBase, saveModuleSettings } from '../../automation/settings.js';
import type { AppDatabase } from '../../db/client.js';
import { recordNickname, upsertUser } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const NOW = 1_789_800_000;

let database: AppDatabase;
let app: FastifyInstance;
let admin: string;
let moderator: string;

beforeEach(async () => {
  database = createTestDatabase();
  const context = createTestContext(database);
  admin = sessionCookie(context, 'admin');
  moderator = sessionCookie(context, 'moderator');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

const get = (url: string, cookie = admin) =>
  app.inject({ method: 'GET', url, headers: { cookie } });

describe('automation routes', () => {
  it('are for admins only', async () => {
    expect((await get('/api/automation', moderator)).statusCode).toBe(403);
    expect((await get('/api/automation/log', moderator)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/automation' })).statusCode).toBe(401);
  });

  it('give the overview with the retention period', async () => {
    const response = await get('/api/automation');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ retentionDays: 90 });
  });

  it('list the log page by page, filtered by module', async () => {
    const userId = upsertUser(database.db, { uid: 'uid-a', seenAt: NOW });
    recordNickname(database.db, userId, 'Alice', NOW);
    for (let i = 0; i < 3; i++) {
      writeAutomationLog(database.db, {
        at: NOW + i,
        module: i === 0 ? 'spam' : 'nickname',
        action: 'kick',
        userId,
        detail: `Eintrag ${String(i)}`,
        result: i === 2 ? 'dry' : 'done',
      });
    }

    const page = (await get('/api/automation/log?pageSize=2')).json<{
      items: unknown[];
      total: number;
    }>();
    expect(page.total).toBe(3);
    expect(page.items[0]).toEqual({
      id: 3,
      at: NOW + 2,
      module: 'nickname',
      action: 'kick',
      userId,
      nickname: 'Alice',
      detail: 'Eintrag 2',
      result: 'dry',
    });
    expect(page.items).toHaveLength(2);

    const spam = (await get('/api/automation/log?module=spam')).json<{ total: number }>();
    expect(spam.total).toBe(1);
    expect((await get('/api/automation/log?module=unbekannt')).statusCode).toBe(400);
  });
});

describe('moduleStates', () => {
  it('reports a module as off and in test mode until something else was saved', () => {
    const modules = [{ id: 'nickname', schema: moduleBase }] as const;
    expect(moduleStates(database.db, modules)).toEqual([
      { id: 'nickname', enabled: false, dryRun: true },
    ]);
    saveModuleSettings(database.db, 'nickname', { enabled: true, dryRun: false }, NOW);
    expect(moduleStates(database.db, modules)).toEqual([
      { id: 'nickname', enabled: true, dryRun: false },
    ]);
  });
});
