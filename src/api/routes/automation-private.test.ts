import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrivateSettings } from '../../automation/modules/private.js';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

let database: AppDatabase;
let app: FastifyInstance;
let admin: string;
let moderator: string;
let online: boolean;

beforeEach(async () => {
  online = true;
  database = createTestDatabase();
  const context = createTestContext(database, {
    channelGroups: () =>
      online
        ? Promise.resolve([
            { id: 5, name: 'Channel Admin', type: 1 },
            { id: 1, name: 'Vorlage', type: 0 },
          ])
        : Promise.reject(new Error('not connected')),
  });
  admin = sessionCookie(context, 'admin');
  moderator = sessionCookie(context, 'moderator');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

const put = (payload: Record<string, unknown>, cookie = admin) =>
  app.inject({ method: 'PUT', url: '/api/automation/private', headers: { cookie }, payload });
const get = () =>
  app.inject({ method: 'GET', url: '/api/automation/private', headers: { cookie: admin } });

const lobby = { id: 'main', lobbyChannelId: 30, parentId: 31 };

describe('private channel routes', () => {
  it('offer the regular channel groups, or none while the bot is offline', async () => {
    expect((await get()).json()).toMatchObject({
      settings: { enabled: false, dryRun: true, lobbies: [], cooldownS: 30 },
      channelGroups: [{ id: 5, name: 'Channel Admin' }],
    });
    online = false;
    const offline = await get();
    expect(offline.statusCode).toBe(200);
    expect(offline.json()).toMatchObject({ channelGroups: [] });
  });

  it('save a lobby with its defaults and audit it', async () => {
    const response = await put({ enabled: true, lobbies: [lobby] });
    expect(response.statusCode).toBe(200);
    expect(loadPrivateSettings(database.db).lobbies).toEqual([
      {
        ...lobby,
        nameTemplate: 'Privater Raum von {name}',
        channelGroupId: null,
        kind: 'temporary',
        deleteDelayS: 300,
        description: '',
        maxClients: -1,
        codecQuality: 6,
        password: false,
        allowedGroupIds: [],
      },
    ]);
    expect(response.json()).toMatchObject({ managed: [{ lobbyId: 'main', count: 0 }] });
    expect(database.sqlite.prepare('SELECT action FROM audit_log ORDER BY id DESC').get()).toEqual({
      action: 'automation.private',
    });
  });

  it('refuse lobbies that cannot work', async () => {
    const response = await put({
      lobbies: [
        lobby,
        { id: 'main', lobbyChannelId: 40, parentId: 41 },
        { id: 'b', lobbyChannelId: 50, parentId: 51 },
        { id: 'c', lobbyChannelId: 50, parentId: 52 },
        { id: 'd', lobbyChannelId: 60, parentId: 60 },
      ],
    });
    expect(response.json()).toMatchObject({
      error: {
        code: 'PRIVATE_INVALID_LOBBY',
        details: [
          { index: 0, problem: 'id' },
          { index: 1, problem: 'id' },
          { index: 2, problem: 'lobby' },
          { index: 3, problem: 'lobby' },
          { index: 4, problem: 'parent' },
        ],
      },
    });
    expect((await put({ enabled: true })).json()).toMatchObject({
      error: { code: 'PRIVATE_INCOMPLETE' },
    });
  });

  it('are for admins only', async () => {
    expect((await put({ lobbies: [lobby] }, moderator)).statusCode).toBe(403);
  });
});
