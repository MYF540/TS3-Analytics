import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSupportSettings } from '../../automation/modules/support.js';
import type { AppDatabase } from '../../db/client.js';
import { upsertChannels } from '../../db/repositories/index.js';
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
  upsertChannels(database.db, [{ id: 20, name: 'Support', seenAt: NOW }]);
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
  app.inject({ method: 'PUT', url: '/api/automation/support', headers: { cookie }, payload });

const valid = { enabled: true, channelId: 20, supporterGroupIds: [6] };

describe('support channel routes', () => {
  it('start switched off with the channels to choose from', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/automation/support',
      headers: { cookie: admin },
    });
    expect(response.json()).toMatchObject({
      settings: {
        enabled: false,
        dryRun: true,
        channelId: null,
        supporterGroupIds: [],
        notify: 'poke',
        cooldownS: 60,
        autoOpen: { enabled: false, closedMaxClients: 0 },
      },
      channels: [{ id: 20, name: 'Support' }],
    });
  });

  it('save the settings with defaults for everything left out, and audit it', async () => {
    const response = await put(valid);
    expect(response.statusCode).toBe(200);
    expect(loadSupportSettings(database.db)).toMatchObject({
      ...valid,
      dryRun: true,
      supporterMessage: '{name} wartet im Support.',
    });
    expect(
      database.sqlite.prepare('SELECT action, details FROM audit_log ORDER BY id DESC').get(),
    ).toEqual({
      action: 'automation.support',
      details: JSON.stringify({
        enabled: true,
        dryRun: true,
        channelId: 20,
        supporterGroupIds: [6],
        autoOpen: false,
      }),
    });
  });

  it('refuse to switch on without channel or team', async () => {
    for (const payload of [
      { enabled: true, supporterGroupIds: [6] },
      { enabled: true, channelId: 20 },
    ]) {
      const response = await put(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'SUPPORT_INCOMPLETE' } });
    }
    // Switched off, an incomplete draft may be saved.
    expect((await put({ enabled: false, channelId: 20 })).statusCode).toBe(200);
  });

  it('refuse the same name for open and closed', async () => {
    const response = await put({
      ...valid,
      autoOpen: { enabled: true, openName: 'Support', closedName: 'Support' },
    });
    expect(response.json()).toMatchObject({ error: { code: 'SUPPORT_SAME_NAME' } });
  });

  it('are for admins only', async () => {
    expect((await put(valid, moderator)).statusCode).toBe(403);
    expect(loadSupportSettings(database.db).enabled).toBe(false);
  });
});
