import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import { createSilentLogger } from '../../logging/logger.js';
import { saveModerationSettings } from '../../moderation/settings.js';
import { Ts3Connection } from '../../ts3/connection.js';
import { FakeTs3Server } from '../../ts3/fake-transport.js';
import { Watcher } from '../../watcher/watcher.js';
import { listAudit } from '../audit/audit.js';
import type { ApiContext } from '../context.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const UID = 'troll-uid-0000000000000000+/=';

let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let watcher: Watcher;
let context: ApiContext;
let app: FastifyInstance;
let admin: string;
let userId: number;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

beforeEach(async () => {
  database = createTestDatabase();
  server = new FakeTs3Server();
  server.addChannel(2, 'AFK');
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000, initialBackoffMs: 1, maxBackoffMs: 1, jitter: 0 },
    { logger: createSilentLogger() },
  );
  watcher = new Watcher({ database, connection, logger: createSilentLogger() });
  watcher.start();
  connection.start();
  await settle();
  server.join({ uid: UID, nickname: 'Troll' });
  server.join({ uid: UID, nickname: 'Troll2' });
  userId = database.sqlite.prepare('SELECT id FROM users WHERE uid = ?').pluck().get(UID) as number;
  context = createTestContext(database, { live: watcher, moderation: connection });
  admin = sessionCookie(context, 'admin');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  await connection.stop();
  database.close();
});

function act(payload: object, cookie = admin, id = userId) {
  return app.inject({
    method: 'POST',
    url: `/api/users/${String(id)}/moderation`,
    headers: { cookie },
    payload,
  });
}

function enable() {
  saveModerationSettings(database.db, { enabled: true }, 0);
}

describe('moderation API', () => {
  it('is refused while the global switch is off, and audited', async () => {
    const res = await act({ type: 'poke', message: 'Hallo' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'MODERATION_DISABLED' } });
    expect(server.moderation).toEqual([]);
    const [entry] = listAudit(database.sqlite, {}, { limit: 1, offset: 0 }).items;
    expect(entry).toMatchObject({ action: 'moderation.poke', status: 409 });
  });

  it('pokes, messages, moves and kicks every connection of the player', async () => {
    enable();
    expect((await act({ type: 'poke', message: 'Bitte leiser' })).json()).toEqual({ affected: 2 });
    await act({ type: 'message', message: 'Regeln: …' });
    await act({ type: 'move', channelId: 2 });
    await act({ type: 'kick', from: 'channel', reason: 'Channel-Hopping' });
    expect(server.moderation.map((m) => m.command)).toEqual([
      'poke',
      'poke',
      'message',
      'message',
      'move',
      'move',
      'kick.channel',
      'kick.channel',
    ]);
    const kicked = await act({ type: 'kick', from: 'server', reason: 'Tschüss' });
    expect(kicked.json()).toEqual({ affected: 2 });
    await settle();
    expect(watcher.clidsOf(userId)).toEqual([]);
    const offline = await act({ type: 'poke', message: 'x' });
    expect(offline.json()).toMatchObject({ error: { code: 'NOT_ONLINE' } });
  });

  it('bans by UID with a template and kicks online connections', async () => {
    enable();
    const res = await act({ type: 'ban', templateId: 'insult' });
    expect(res.json()).toEqual({ affected: 2 });
    expect(server.moderation[0]).toEqual({
      command: 'ban.uid',
      uid: UID,
      text: 'Beleidigung',
      value: 86_400,
    });
    expect(server.bans).toHaveLength(1);
    expect(server.moderation.filter((m) => m.command === 'kick.server')).toHaveLength(2);
    const [entry] = listAudit(database.sqlite, {}, { limit: 1, offset: 0 }).items;
    expect(entry).toMatchObject({
      action: 'moderation.ban',
      details: { templateId: 'insult', reason: 'Beleidigung', durationS: 86_400, includeIp: false },
    });
  });

  it('bans offline players by UID and IP-bans online ones only on request', async () => {
    enable();
    const ipBan = await act({ type: 'ban', reason: 'Cheats', durationS: 0, includeIp: true });
    expect(ipBan.json()).toEqual({ affected: 2 });
    expect(server.moderation.map((m) => m.command)).toEqual(['ban.client', 'ban.client']);
    await settle();
    const again = await act({ type: 'ban', reason: 'Cheats', includeIp: true });
    expect(again.json()).toEqual({ affected: 1 });
    expect(server.moderation.at(-1)).toMatchObject({ command: 'ban.uid', value: 0 });
  });

  it('validates input and maps server errors', async () => {
    enable();
    expect((await act({ type: 'poke', message: 'x'.repeat(101) })).statusCode).toBe(400);
    expect((await act({ type: 'kick', from: 'server', reason: 'x'.repeat(41) })).statusCode).toBe(
      400,
    );
    expect((await act({ type: 'ban' })).json()).toMatchObject({
      error: { code: 'BAN_REASON_MISSING' },
    });
    expect((await act({ type: 'ban', templateId: 'nope' })).json()).toMatchObject({
      error: { code: 'UNKNOWN_TEMPLATE' },
    });
    const invalidChannel = await act({ type: 'move', channelId: 99 });
    expect(invalidChannel.statusCode).toBe(502);
    expect(invalidChannel.json()).toMatchObject({ error: { code: 'TS3_ERROR' } });
    expect((await act({ type: 'poke', message: 'x' }, admin, 999)).statusCode).toBe(404);
  });

  it('is admin-only and has editable ban templates', async () => {
    const moderator = sessionCookie(context, 'moderator');
    expect((await act({ type: 'poke', message: 'x' }, moderator)).statusCode).toBe(403);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/moderation',
      headers: { cookie: admin },
      payload: {
        enabled: true,
        banTemplates: [{ id: 'afk', label: 'AFK-Farming', reason: 'AFK-Farming', durationS: 600 }],
      },
    });
    expect(put.json()).toEqual({
      enabled: true,
      banTemplates: [{ id: 'afk', label: 'AFK-Farming', reason: 'AFK-Farming', durationS: 600 }],
    });
    const dup = await app.inject({
      method: 'PUT',
      url: '/api/settings/moderation',
      headers: { cookie: admin },
      payload: {
        enabled: true,
        banTemplates: [
          { id: 'a', label: 'A', reason: 'A', durationS: 0 },
          { id: 'a', label: 'B', reason: 'B', durationS: 0 },
        ],
      },
    });
    expect(dup.statusCode).toBe(400);
  });
});
