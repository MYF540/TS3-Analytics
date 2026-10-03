import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSpamSettings } from '../../automation/modules/spam.js';
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
  app.inject({ method: 'PUT', url: '/api/automation/spam', headers: { cookie }, payload });

describe('spam control routes', () => {
  it('start with every kind off and sensible thresholds', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/automation/spam',
      headers: { cookie: admin },
    });
    expect(response.json()).toMatchObject({
      settings: {
        enabled: false,
        dryRun: true,
        channelSwitch: { enabled: false, windowS: 10, warnAt: 6, kickAt: 10, banAt: 0 },
        reconnect: { enabled: false, warnAt: 0, kickAt: 0, banAt: 8, banDurationS: 600 },
      },
    });
  });

  it('save one kind and keep the defaults of the others', async () => {
    const response = await put({
      enabled: true,
      channelSwitch: { enabled: true, windowS: 20, warnAt: 4, kickAt: 8, banAt: 12 },
    });
    expect(response.statusCode).toBe(200);
    const settings = loadSpamSettings(database.db);
    expect(settings.channelSwitch).toMatchObject({ enabled: true, windowS: 20, banAt: 12 });
    expect(settings.nickname).toMatchObject({ enabled: false, windowS: 600 });
    expect(
      database.sqlite.prepare('SELECT action, details FROM audit_log ORDER BY id DESC').get(),
    ).toEqual({
      action: 'automation.spam',
      details: JSON.stringify({ enabled: true, dryRun: true, kinds: ['channelSwitch'] }),
    });
  });

  it('refuse thresholds that do not rise and a kind without any step', async () => {
    const response = await put({
      channelSwitch: { enabled: true, warnAt: 5, kickAt: 5, banAt: 0 },
      lobby: { enabled: true, warnAt: 0, kickAt: 0, banAt: 0 },
      nickname: { enabled: false, warnAt: 0, kickAt: 0, banAt: 0 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'SPAM_INVALID_THRESHOLDS', details: ['channelSwitch', 'lobby'] },
    });
  });

  it('are for admins only', async () => {
    expect((await put({ enabled: true }, moderator)).statusCode).toBe(403);
  });
});
