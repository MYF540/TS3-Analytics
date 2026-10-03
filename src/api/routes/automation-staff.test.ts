import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadStaffSettings } from '../../automation/modules/staff.js';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

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

const put = (payload: Record<string, unknown>, cookie = admin) =>
  app.inject({ method: 'PUT', url: '/api/automation/staff', headers: { cookie }, payload });

const valid = {
  enabled: true,
  channelId: 20,
  groups: [{ groupId: 6 }, { groupId: 7, title: 'Mods' }],
};

describe('staff list routes', () => {
  it('start switched off with a usable template', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/automation/staff',
      headers: { cookie: admin },
    });
    expect(response.json()).toMatchObject({
      settings: {
        enabled: false,
        dryRun: true,
        channelId: null,
        groups: [],
        groupLine: '[b]{group}[/b]',
        memberLine: '{name} – {status}',
        clickable: true,
      },
    });
  });

  it('save the groups in their order and audit it', async () => {
    expect((await put(valid)).statusCode).toBe(200);
    expect(loadStaffSettings(database.db).groups).toEqual([
      { groupId: 6, title: '' },
      { groupId: 7, title: 'Mods' },
    ]);
    expect(
      database.sqlite.prepare('SELECT action, details FROM audit_log ORDER BY id DESC').get(),
    ).toEqual({
      action: 'automation.staff',
      details: JSON.stringify({ enabled: true, dryRun: true, channelId: 20, groupIds: [6, 7] }),
    });
  });

  it('refuse a group listed twice and an incomplete list that is switched on', async () => {
    const twice = await put({ ...valid, groups: [{ groupId: 6 }, { groupId: 6 }] });
    expect(twice.json()).toMatchObject({ error: { code: 'STAFF_DUPLICATE_GROUP' } });
    const empty = await put({ enabled: true, channelId: 20 });
    expect(empty.json()).toMatchObject({ error: { code: 'STAFF_INCOMPLETE' } });
    expect((await put({ enabled: false })).statusCode).toBe(200);
  });

  it('are for admins only', async () => {
    expect((await put(valid, moderator)).statusCode).toBe(403);
  });
});
