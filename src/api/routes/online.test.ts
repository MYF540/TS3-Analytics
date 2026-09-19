import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { upsertChannels } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import type { ConnectionState } from '../../ts3/connection.js';
import type { LiveClient } from '../../watcher/watcher.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

let database: AppDatabase;
let app: FastifyInstance;
let cookie: string;
let state: ConnectionState;
let clients: LiveClient[];

beforeEach(async () => {
  database = createTestDatabase();
  upsertChannels(database.db, [
    { id: 1, name: 'Lobby', seenAt: 0 },
    { id: 2, name: 'Gaming', seenAt: 0 },
  ]);
  state = 'connected';
  clients = [
    { userId: 3, nickname: 'zed', channelId: 1, state: 'idle', since: 100 },
    { userId: 1, nickname: 'Alice', channelId: 2, state: 'active', since: 200 },
    { userId: 2, nickname: 'bob', channelId: 1, state: undefined, since: 300 },
    { userId: 4, nickname: 'Temp', channelId: 77, state: 'afk', since: 400 },
  ];
  const context = createTestContext(database, {
    ts3: {
      get state() {
        return state;
      },
    },
    live: { liveClients: () => clients },
  });
  cookie = sessionCookie(context);
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

describe('GET /api/online', () => {
  it('lists online players with channel names, sorted by channel and nickname', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/online', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      connected: true,
      items: [
        { userId: 4, nickname: 'Temp', channelId: 77, channelName: null, state: 'afk', since: 400 },
        {
          userId: 1,
          nickname: 'Alice',
          channelId: 2,
          channelName: 'Gaming',
          state: 'active',
          since: 200,
        },
        { userId: 2, nickname: 'bob', channelId: 1, channelName: 'Lobby', state: null, since: 300 },
        {
          userId: 3,
          nickname: 'zed',
          channelId: 1,
          channelName: 'Lobby',
          state: 'idle',
          since: 100,
        },
      ],
    });
  });

  it('returns no (outdated) list while the query connection is down', async () => {
    state = 'waiting';
    const res = await app.inject({ method: 'GET', url: '/api/online', headers: { cookie } });
    expect(res.json()).toEqual({ connected: false, items: [] });
  });
});
