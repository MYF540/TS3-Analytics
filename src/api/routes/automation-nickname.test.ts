import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadNicknameSettings } from '../../automation/modules/nickname.js';
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
  app.inject({ method: 'PUT', url: '/api/automation/nickname', headers: { cookie }, payload });

const valid = {
  enabled: true,
  dryRun: true,
  exemptGroupIds: [6],
  patterns: [{ pattern: 'admin', regex: false }],
  lookalikes: true,
  action: 'kick',
  message: 'Bitte anderen Namen wählen.',
};

describe('nickname checker routes', () => {
  it('start switched off, in test mode and without patterns', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/automation/nickname',
      headers: { cookie: admin },
    });
    expect(response.json()).toEqual({
      settings: {
        enabled: false,
        dryRun: true,
        exemptGroupIds: [],
        patterns: [],
        lookalikes: true,
        action: 'kick',
        message: 'Dieser Nickname ist hier nicht erlaubt.',
        english: { enabled: false, message: 'This nickname is not allowed here.' },
      },
      groups: [],
    });
  });

  it('save the settings, write the audit log and show up in the overview', async () => {
    const response = await put(valid);
    expect(response.statusCode).toBe(200);
    expect(loadNicknameSettings(database.db)).toEqual({
      ...valid,
      english: { enabled: false, message: 'This nickname is not allowed here.' },
    });
    expect(
      database.sqlite.prepare('SELECT action, details FROM audit_log ORDER BY id DESC').get(),
    ).toEqual({
      action: 'automation.nickname',
      details: JSON.stringify({ enabled: true, dryRun: true, action: 'kick', patterns: 1 }),
    });
    const overview = await app.inject({
      method: 'GET',
      url: '/api/automation',
      headers: { cookie: admin },
    });
    expect(overview.json<{ modules: unknown[] }>().modules).toContainEqual({
      id: 'nickname',
      enabled: true,
      dryRun: true,
    });
  });

  it('are for admins only', async () => {
    expect((await put(valid, moderator)).statusCode).toBe(403);
    expect(loadNicknameSettings(database.db).enabled).toBe(false);
  });

  it('reject patterns that cannot be used and say which', async () => {
    const response = await put({
      ...valid,
      patterns: [
        { pattern: 'admin' },
        { pattern: '[a-', regex: true },
        { pattern: '(a+)+', regex: true },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'INVALID_PATTERN',
        details: [
          { index: 1, problem: 'invalid' },
          { index: 2, problem: 'slow' },
        ],
      },
    });
    expect(loadNicknameSettings(database.db).patterns).toEqual([]);
  });

  it('try a nickname against unsaved patterns', async () => {
    const test = (nickname: string) =>
      app.inject({
        method: 'POST',
        url: '/api/automation/nickname/test',
        headers: { cookie: admin },
        payload: {
          nickname,
          lookalikes: true,
          patterns: [{ pattern: 'owner' }, { pattern: 'admin' }],
        },
      });
    expect((await test('4dm1n')).json()).toEqual({ match: 1 });
    expect((await test('Alice')).json()).toEqual({ match: null });
  });
});
