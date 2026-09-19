import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { openSession, upsertUser } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { writeHeartbeat } from '../../watcher/recovery.js';
import type { ApiContext } from '../context.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

let database: AppDatabase;
let app: FastifyInstance;
let context: ApiContext;
let logDir: string;

async function start(overrides: Partial<ApiContext> = {}) {
  context = createTestContext(database, overrides);
  app = await buildServer(context);
}

beforeEach(() => {
  database = createTestDatabase();
  logDir = mkdtempSync(join(tmpdir(), 'ts3a-status-'));
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(logDir, { recursive: true, force: true });
});

describe('GET /api/status', () => {
  it('combines process, connection, watcher, database, jobs and log problems', async () => {
    const userId = upsertUser(database.db, { uid: 'u1=', seenAt: 1_789_700_000 });
    openSession(database.db, userId, 1_789_790_000);
    writeHeartbeat(database.db, 1_789_799_950);
    writeFileSync(
      join(logDir, 'ts3-analytics.2026-09-19.1.log'),
      `${JSON.stringify({ level: 50, time: '2026-09-19T08:00:00.000Z', msg: 'Job failed', job: 'retention' })}\n`,
    );
    await start({
      live: { liveClients: () => [] },
      bot: {
        connection: () => ({
          state: 'waiting',
          since: 1_789_799_000,
          failedAttempts: 3,
          lastConnectedAt: undefined,
          lastError: { at: 1_789_799_000, message: 'refused' },
          queuedCommands: 0,
        }),
        jobs: () => [
          {
            name: 'retention',
            intervalS: 86_400,
            lastRun: 1_789_700_000,
            nextRun: 1_789_786_400,
            lastError: undefined,
          },
        ],
        logDir,
      },
    });
    const res = await app.inject({
      url: '/api/status',
      headers: { cookie: sessionCookie(context, 'admin') },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, Record<string, unknown>>>();
    expect(body.process).toMatchObject({ uptimeS: 1000, nodeVersion: process.version });
    expect(body.process?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.ts3).toMatchObject({ state: 'waiting', failedAttempts: 3, lastConnectedAt: null });
    expect(body.watcher).toEqual({
      lastHeartbeat: 1_789_799_950,
      onlineClients: 0,
      openSessions: 1,
    });
    expect(body.database).toMatchObject({ users: 1, sessions: 1, segments: 0, walBytes: null });
    expect(body.database?.sizeBytes).toBeGreaterThan(0);
    expect(body.jobs).toEqual([
      {
        name: 'retention',
        intervalS: 86_400,
        lastRun: 1_789_700_000,
        nextRun: 1_789_786_400,
        lastError: null,
      },
    ]);
    expect(body.problems).toEqual([
      expect.objectContaining({ level: 'error', message: 'Job failed', detail: 'Job retention' }),
    ]);
  });

  it('works without a running bot', async () => {
    await start();
    const res = await app.inject({
      url: '/api/status',
      headers: { cookie: sessionCookie(context, 'admin') },
    });
    expect(res.json()).toMatchObject({
      ts3: null,
      jobs: [],
      problems: [],
      watcher: { onlineClients: null, lastHeartbeat: null },
    });
  });

  it('is admin-only', async () => {
    await start();
    const res = await app.inject({
      url: '/api/status',
      headers: { cookie: sessionCookie(context, 'moderator') },
    });
    expect(res.statusCode).toBe(403);
  });
});
