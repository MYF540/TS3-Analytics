import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProxyCheck, loadProxySettings } from '../../automation/modules/proxy.js';
import type { AppDatabase } from '../../db/client.js';
import { recordNickname, replaceRanks, upsertUser } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const NOW = 1_789_800_000;

let database: AppDatabase;
let app: FastifyInstance;
let admin: string;
let moderator: string;
let viewer: string;

beforeEach(async () => {
  database = createTestDatabase();
  const context = createTestContext(database, { proxyKeyConfigured: true });
  admin = sessionCookie(context, 'admin');
  moderator = sessionCookie(context, 'moderator');
  viewer = sessionCookie(context, 'viewer');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

const put = (payload: Record<string, unknown>, cookie = admin) =>
  app.inject({ method: 'PUT', url: '/api/automation/proxy', headers: { cookie }, payload });
const get = (url: string, cookie = admin) =>
  app.inject({ method: 'GET', url, headers: { cookie } });
const post = (url: string, cookie = admin) =>
  app.inject({ method: 'POST', url, headers: { cookie }, payload: {} });

/** A player with a verdict; flagged ones also get an entry on the local list. */
function player(nickname: string, verdict: 'clean' | 'proxy', at = NOW): number {
  const userId = upsertUser(database.db, { uid: `uid-${nickname}`, seenAt: at });
  recordNickname(database.db, userId, nickname, at);
  database.sqlite
    .prepare('INSERT INTO proxy_checks (user_id, verdict, checked_at) VALUES (?, ?, ?)')
    .run(userId, verdict, at);
  if (verdict === 'proxy') {
    database.sqlite
      .prepare('INSERT INTO proxy_ips (ip_hash, kind, user_id, flagged_at) VALUES (?, ?, ?, ?)')
      .run(Buffer.from(`hash-${nickname}`), 'VPN', userId, at);
  }
  return userId;
}

describe('proxy check routes', () => {
  it('report counts, flagged players and whether a key is set – never the key', async () => {
    player('Alice', 'clean');
    const evader = player('Evader', 'proxy', NOW + 5);
    const response = await get('/api/automation/proxy');
    expect(response.json()).toMatchObject({
      settings: { enabled: false, dryRun: true, action: 'none', banDurationS: 3600 },
      keyConfigured: true,
      stats: { listed: 1, clean: 1, proxy: 1 },
      flagged: [{ userId: evader, nickname: 'Evader', checkedAt: NOW + 5 }],
    });
    expect(response.body).not.toMatch(/apiKey|hash-/);
  });

  it('save the settings and audit it', async () => {
    const response = await put({ enabled: true, action: 'group', groupId: 142 });
    expect(response.statusCode).toBe(200);
    expect(loadProxySettings(database.db)).toMatchObject({ action: 'group', groupId: 142 });
    expect(
      database.sqlite.prepare('SELECT action, details FROM audit_log ORDER BY id DESC').get(),
    ).toEqual({
      action: 'automation.proxy',
      details: JSON.stringify({
        enabled: true,
        dryRun: true,
        action: 'group',
        groupId: 142,
        exemptUsers: 0,
      }),
    });
  });

  it('refuse the group action without a group and any rank group', async () => {
    expect((await put({ action: 'group' })).json()).toMatchObject({
      error: { code: 'PROXY_GROUP_MISSING' },
    });
    replaceRanks(database.sqlite, [{ name: 'Neuling', requiredS: 3600, serverGroupId: 20 }], NOW);
    expect((await put({ action: 'group', groupId: 20 })).json()).toMatchObject({
      error: { code: 'RULES_RANK_GROUP' },
    });
  });

  it('undo a false alarm', async () => {
    const evader = player('Evader', 'proxy');
    const response = await post(`/api/automation/proxy/clear/${String(evader)}`);
    expect(response.json()).toEqual({ removed: 1 });
    expect(getProxyCheck(database.db, evader)?.verdict).toBe('clean');
    expect(
      database.sqlite
        .prepare('SELECT action, target_id AS id FROM audit_log ORDER BY id DESC')
        .get(),
    ).toEqual({ action: 'automation.proxy.clear', id: String(evader) });
    expect((await post('/api/automation/proxy/clear/9999')).statusCode).toBe(404);
  });

  it("show moderators a player's result", async () => {
    const evader = player('Evader', 'proxy');
    const fresh = upsertUser(database.db, { uid: 'uid-new', seenAt: NOW });
    const path = (id: number) => `/api/users/${String(id)}/proxy`;
    expect((await get(path(evader), moderator)).json()).toEqual({
      enabled: false,
      verdict: 'proxy',
      checkedAt: NOW,
    });
    expect((await get(path(fresh), moderator)).json()).toMatchObject({ verdict: null });
    expect((await get(path(evader), viewer)).statusCode).toBe(403);
  });

  it('keep settings and false alarms to admins', async () => {
    const evader = player('Evader', 'proxy');
    expect((await put({ enabled: true }, moderator)).statusCode).toBe(403);
    expect((await get('/api/automation/proxy', moderator)).statusCode).toBe(403);
    expect(
      (await post(`/api/automation/proxy/clear/${String(evader)}`, moderator)).statusCode,
    ).toBe(403);
  });
});
