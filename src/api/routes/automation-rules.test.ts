import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRulesSettings } from '../../automation/modules/rules.js';
import type { AppDatabase } from '../../db/client.js';
import { replaceRanks, upsertUser } from '../../db/repositories/index.js';
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
  const context = createTestContext(database);
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
  app.inject({ method: 'PUT', url: '/api/automation/rules', headers: { cookie }, payload });
const get = (url: string, cookie = admin) =>
  app.inject({ method: 'GET', url, headers: { cookie } });
const code = async (payload: Record<string, unknown>) =>
  (await put(payload)).json<{ error?: { code: string } }>().error?.code;

const valid = { enabled: true, rules: ['Seid freundlich.'] };

function decide(uid: string, version: number, decision: string): number {
  const userId = upsertUser(database.db, { uid, seenAt: NOW });
  database.sqlite
    .prepare('INSERT INTO rule_acceptances (user_id, version, decision, at) VALUES (?, ?, ?, ?)')
    .run(userId, version, decision, NOW);
  return userId;
}

describe('rule confirmation routes', () => {
  it('save the rules and audit it without their text', async () => {
    expect((await put(valid)).statusCode).toBe(200);
    expect(loadRulesSettings(database.db)).toMatchObject({
      ...valid,
      dryRun: true,
      version: 1,
      viaChat: true,
      acceptCommand: 'akzeptieren',
    });
    expect(
      database.sqlite.prepare('SELECT action, details FROM audit_log ORDER BY id DESC').get(),
    ).toEqual({
      action: 'automation.rules',
      details: JSON.stringify({
        enabled: true,
        dryRun: true,
        version: 1,
        rules: 1,
        acceptedGroupId: null,
        kickOnDecline: false,
        deadlineS: 0,
      }),
    });
  });

  it('count the decisions about the current version only', async () => {
    decide('a', 2, 'accepted');
    decide('b', 2, 'declined');
    decide('c', 1, 'accepted');
    await put({ ...valid, version: 2 });
    expect((await get('/api/automation/rules')).json()).toMatchObject({
      stats: { accepted: 1, declined: 1 },
    });
  });

  it('refuse settings that cannot work', async () => {
    expect(await code({ enabled: true })).toBe('RULES_INCOMPLETE');
    expect(await code({ ...valid, viaChat: false })).toBe('RULES_INCOMPLETE');
    expect(await code({ ...valid, viaChannel: true })).toBe('RULES_INCOMPLETE');
    expect(await code({ ...valid, trigger: 'channel' })).toBe('RULES_INCOMPLETE');
    expect(await code({ ...valid, acceptCommand: 'Ja', declineCommand: 'ja' })).toBe(
      'RULES_SAME_COMMAND',
    );
    // Switched off, an unfinished draft may be saved.
    expect((await put({ enabled: false, viaChat: false })).statusCode).toBe(200);
  });

  it('save the English texts with defaults for what was left out', async () => {
    await put({ ...valid, english: { enabled: true, rules: ['Be kind.'] } });
    expect(loadRulesSettings(database.db).english).toEqual({
      enabled: true,
      rules: ['Be kind.'],
      acceptCommand: 'accept',
      declineCommand: 'decline',
      prompt: 'Reply with "{accept}" to confirm the rules, or with "{decline}" to decline them.',
      acceptedMessage: 'Thank you, you have confirmed the rules.',
      declinedMessage: 'You have declined the rules.',
      kickReason: 'Rules not confirmed',
    });
  });

  it('refuse English without rules and words that mean both things', async () => {
    expect(await code({ ...valid, english: { enabled: true } })).toBe('RULES_INCOMPLETE');
    const english = { enabled: true, rules: ['Be kind.'] };
    expect(await code({ ...valid, english: { ...english, declineCommand: 'Akzeptieren' } })).toBe(
      'RULES_SAME_COMMAND',
    );
    // Switched off, the English words are not looked at.
    expect(
      (await put({ ...valid, english: { enabled: false, declineCommand: 'akzeptieren' } }))
        .statusCode,
    ).toBe(200);
  });

  it('refuse a group of the rank ladder (rule 6)', async () => {
    replaceRanks(database.sqlite, [{ name: 'Neuling', requiredS: 3600, serverGroupId: 20 }], NOW);
    expect(await code({ ...valid, acceptedGroupId: 20 })).toBe('RULES_RANK_GROUP');
    expect((await put({ ...valid, acceptedGroupId: 21 })).statusCode).toBe(200);
  });

  it('are for admins only', async () => {
    expect((await put(valid, moderator)).statusCode).toBe(403);
    expect((await get('/api/automation/rules', moderator)).statusCode).toBe(403);
  });

  it("show moderators a player's decision", async () => {
    await put({ ...valid, version: 2 });
    const userId = decide('a', 1, 'accepted');
    const other = upsertUser(database.db, { uid: 'b', seenAt: NOW });

    const path = (id: number) => `/api/users/${String(id)}/rules`;
    expect((await get(path(userId), moderator)).json()).toEqual({
      enabled: true,
      currentVersion: 2,
      state: { version: 1, decision: 'accepted', at: NOW },
    });
    expect((await get(path(other), moderator)).json()).toMatchObject({ state: null });
    expect((await get(path(userId), viewer)).statusCode).toBe(403);
    expect((await get(path(9999), moderator)).statusCode).toBe(404);
  });
});
