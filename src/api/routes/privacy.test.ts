import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import {
  createNote,
  linkUsers,
  recordNickname,
  setRankOverride,
  upsertIpSeen,
  upsertUser,
} from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { leaderboardAllTime, listUsers, searchUsers } from '../../db/queries/stats.js';
import type { ApiContext } from '../context.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const H = 3600;
const UID = 'privacy-uid+/=';
let database: AppDatabase;
let context: ApiContext;
let app: FastifyInstance;
let admin: string;
let userId: number;
let other: number;
let online: number[] = [];

beforeEach(async () => {
  database = createTestDatabase();
  online = [];
  userId = upsertUser(database.db, { uid: UID, seenAt: 1_700_000_000, dbid: 42, country: 'DE' });
  other = upsertUser(database.db, { uid: 'other=', seenAt: 1_700_000_000 });
  recordNickname(database.db, userId, 'Troll', 1_700_000_000);
  recordNickname(database.db, other, 'Bob', 1_700_000_000);
  upsertIpSeen(database.db, {
    userId,
    ipHash: Buffer.alloc(32, 1),
    subnetHash: Buffer.alloc(32, 2),
    country: 'DE',
    seenAt: 1_700_000_000,
  });
  createNote(
    database.db,
    { userId, authorId: null, authorName: 'mod', body: 'Interne Notiz' },
    1_700_000_100,
  );
  for (const id of [userId, other]) {
    database.sqlite
      .prepare(
        `INSERT INTO user_daily_stats (user_id, day, online_s, active_s, idle_s, afk_s, unknown_s,
           sessions, longest_session_s) VALUES (?, 20260901, ?, 0, 0, 0, 0, 1, 0)`,
      )
      .run(id, 10 * H);
    database.sqlite
      .prepare(
        `INSERT INTO user_totals (user_id, online_s, active_s, sessions, longest_session_s,
           first_seen, last_seen) VALUES (?, ?, 0, 1, 0, 1, 2)`,
      )
      .run(id, 10 * H);
  }
  database.sqlite
    .prepare(
      `INSERT INTO bans (id, uid, user_id, ip_hash, subnet_hash, created_at, duration_s,
         first_synced, last_synced, last_nickname) VALUES (1, ?, ?, x'01', x'02', 1, 0, 1, 1, 'Troll')`,
    )
    .run(UID, userId);
  context = createTestContext(database, { live: { liveClients: () => [], clidsOf: () => online } });
  admin = sessionCookie(context, 'admin');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

function anonymize(confirmUid = UID, cookie = admin, id = userId) {
  return app.inject({
    method: 'POST',
    url: `/api/users/${String(id)}/anonymize`,
    headers: { cookie },
    payload: { confirmUid },
  });
}

describe('GDPR export', () => {
  it('returns everything about the player as a JSON download', async () => {
    const res = await app.inject({
      url: `/api/users/${String(userId)}/export`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="spieler-${String(userId)}.json"`,
    );
    const data = res.json<Record<string, unknown>>();
    expect(data).toMatchObject({
      user: { uid: UID, dbid: 42 },
      nicknames: [{ nick: 'Troll' }],
      notes: [{ body: 'Interne Notiz', author: 'mod' }],
      connections: { addresses: 1, byCountry: [{ country: 'DE', connections: 1 }] },
      bans: [{ id: 1, ipRule: 1 }],
    });
    // Hashes are never handed out.
    expect(res.body).not.toContain('ipHash');
    expect(
      (await app.inject({ url: '/api/users/999/export', headers: { cookie: admin } })).statusCode,
    ).toBe(404);
    const moderator = sessionCookie(context, 'moderator');
    expect(
      (
        await app.inject({
          url: `/api/users/${String(userId)}/export`,
          headers: { cookie: moderator },
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('GDPR anonymization', () => {
  it('removes personal data, keeps the playtime and hides the player', async () => {
    linkUsers(database.sqlite, other, userId, 'mod', 5);
    setRankOverride(
      database.sqlite,
      { userId, frozenRankId: null, bonusS: 3600, excluded: false, note: 'x' },
      'admin',
      5,
    );
    const res = await anonymize();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nicknames: 1, ipSeen: 1, notes: 1, flags: 0 });

    const row = database.sqlite
      .prepare('SELECT uid, dbid, country, anonymized_at AS anonymizedAt FROM users WHERE id = ?')
      .get(userId) as {
      uid: string;
      dbid: number | null;
      country: string | null;
      anonymizedAt: number;
    };
    expect(row.uid).toMatch(/^anonymized:/);
    expect(row).toMatchObject({ dbid: null, country: null });
    expect(row.anonymizedAt).toBeGreaterThan(0);
    const counts = (sql: string) => database.sqlite.prepare(sql).pluck().get(userId) as number;
    expect(counts('SELECT count(*) FROM nicknames WHERE user_id = ?')).toBe(0);
    expect(counts('SELECT count(*) FROM ip_seen WHERE user_id = ?')).toBe(0);
    expect(counts('SELECT count(*) FROM player_notes WHERE user_id = ?')).toBe(0);
    expect(counts('SELECT count(*) FROM rank_overrides WHERE user_id = ?')).toBe(0);
    expect(counts('SELECT count(*) FROM person_members WHERE user_id = ?')).toBe(0);
    expect(
      database.sqlite.prepare('SELECT uid, user_id AS userId, ip_hash AS ipHash FROM bans').get(),
    ).toEqual({
      uid: null,
      userId: null,
      ipHash: null,
    });
    // Playtime stays, but anonymized players are hidden from lists and leaderboards.
    expect(counts('SELECT count(*) FROM user_daily_stats WHERE user_id = ?')).toBe(1);
    expect(
      leaderboardAllTime(database.sqlite, 'online', { limit: 10, offset: 0 }).map((e) => e.userId),
    ).toEqual([other]);
    expect(
      listUsers(database.sqlite, {
        limit: 10,
        offset: 0,
        minOnlineS: 0,
        sort: 'online',
        order: 'desc',
      }).total,
    ).toBe(1);
    expect(searchUsers(database.sqlite, 'Troll')).toEqual([]);
    const detail = await app.inject({
      url: `/api/users/${String(userId)}`,
      headers: { cookie: admin },
    });
    expect(detail.statusCode).toBe(410);
    expect(detail.json()).toMatchObject({ error: { code: 'USER_ANONYMIZED' } });
  });

  it('needs the right UID, refuses twice and refuses online players', async () => {
    expect((await anonymize('wrong')).json()).toMatchObject({ error: { code: 'UID_MISMATCH' } });
    online = [7];
    expect((await anonymize()).json()).toMatchObject({ error: { code: 'USER_ONLINE' } });
    online = [];
    expect((await anonymize()).statusCode).toBe(200);
    expect((await anonymize()).json()).toMatchObject({ error: { code: 'UID_MISMATCH' } });
    const moderator = sessionCookie(context, 'moderator');
    expect((await anonymize(UID, moderator, other)).statusCode).toBe(403);
    const entries = database.sqlite
      .prepare(`SELECT action, target_id AS targetId FROM audit_log WHERE action LIKE 'privacy.%'`)
      .all();
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain(UID);
  });
});
