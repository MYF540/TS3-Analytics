import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalizeSession } from '../../db/aggregates.js';
import type { AppDatabase } from '../../db/client.js';
import { openSession, recordNickname, upsertUser } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { berlinDayStart } from '../../domain/time.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const H = 3600;
const DAY1 = berlinDayStart(20260914);
const NOW = DAY1 + 3 * 86_400;

const BOM = String.fromCharCode(0xfeff);
const CRLF = String.fromCharCode(13, 10);

let database: AppDatabase;
let app: FastifyInstance;
let cookie: string;

function player(uid: string, nick: string, seconds: number): void {
  const id = upsertUser(database.db, { uid, seenAt: DAY1 });
  recordNickname(database.db, id, nick, DAY1);
  finalizeSession(database, openSession(database.db, id, DAY1 + 10 * H), DAY1 + 10 * H + seconds);
}

async function csv(url: string) {
  const res = await app.inject({ method: 'GET', url, headers: { cookie } });
  const lines = res.body.replace(BOM, '').split(CRLF);
  return { res, lines };
}

beforeEach(async () => {
  database = createTestDatabase();
  player('uid-a', 'Alice', 5400);
  player('uid-b', '=cmd|"/c calc"!A1', 7200);
  player('uid-c', 'Carol; the "Great"', 600);
  const context = createTestContext(database, { now: () => NOW });
  cookie = sessionCookie(context);
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

describe('GET /api/users/export.csv', () => {
  it('exports the filtered player list for German Excel', async () => {
    const { res, lines } = await csv('/api/users/export.csv?sort=nickname&order=asc');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="spieler.csv"');
    expect(res.body.startsWith(BOM)).toBe(true);
    expect(lines[0]).toBe(
      'Spieler-ID;UID;Nickname;Spielzeit (h);Spielzeit (s);Aktivzeit (h);Aktivzeit (s);Sessions;Erstmals gesehen;Zuletzt gesehen;Land;Online',
    );
    // Casual players (< 1 h) are hidden by default, like in the UI.
    expect(lines).toHaveLength(4); // header + 2 rows + trailing empty line
    expect(lines[1]).toBe(
      `2;uid-b;"'=cmd|""/c calc""!A1";2;7200;0;0;1;2026-09-14 00:00;2026-09-14 00:00;;nein`,
    );
    expect(lines[2]).toMatch(/^1;uid-a;Alice;1,5;5400;/);
  });

  it('includes casual players and escapes separators on request', async () => {
    const { lines } = await csv('/api/users/export.csv?includeCasual=true&sort=online&order=asc');
    expect(lines[1]).toMatch(/^3;uid-c;"Carol; the ""Great""";0,17;600;/);
  });
});

describe('GET /api/leaderboards/export.csv', () => {
  it('exports the complete ranking of the selection', async () => {
    const { res, lines } = await csv('/api/leaderboards/export.csv?period=week');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="leaderboard-online-20260911-20260917.csv"',
    );
    expect(lines.slice(0, 4)).toEqual([
      'Platz;Spieler-ID;UID;Nickname;Spielzeit (h);Spielzeit (s);Verknüpfte Accounts',
      `1;2;uid-b;"'=cmd|""/c calc""!A1";2;7200;1`,
      '2;1;uid-a;Alice;1,5;5400;1',
      '3;3;uid-c;"Carol; the ""Great""";0,17;600;1',
    ]);
  });

  it('validates the selection like the leaderboard endpoint', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/leaderboards/export.csv?period=custom',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_RANGE' } });
  });
});
