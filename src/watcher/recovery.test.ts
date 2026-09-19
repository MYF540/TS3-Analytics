import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuildAggregates } from '../db/aggregates.js';
import type { AppDatabase } from '../db/client.js';
import { openSegment, openSession, upsertUser } from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import { createSilentLogger } from '../logging/logger.js';
import { Ts3Connection } from '../ts3/connection.js';
import { FakeTs3Server } from '../ts3/fake-transport.js';
import { readHeartbeat, recoverOpenSessions } from './recovery.js';
import { Watcher } from './watcher.js';

const T0 = 1_780_000_020;
const MIN = 60;
const logger = createSilentLogger();

let database: AppDatabase;
let server: FakeTs3Server;
let connections: Ts3Connection[];
let now: number;

const rows = (sql: string) => database.sqlite.prepare(sql).all();
const openCount = () =>
  rows(
    `SELECT (SELECT count(*) FROM sessions WHERE leave_at IS NULL) AS sessions,
            (SELECT count(*) FROM activity_segments WHERE is_open = 1) AS segments`,
  )[0];

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function startWatcher(): Promise<Watcher> {
  const connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000 },
    { logger },
  );
  connections.push(connection);
  const watcher = new Watcher({ database, connection, logger, now: () => now, autoPoll: false });
  watcher.start();
  connection.start();
  await settle();
  return watcher;
}

function snapshot() {
  return {
    daily: rows('SELECT * FROM user_daily_stats ORDER BY user_id, day'),
    totals: rows('SELECT * FROM user_totals ORDER BY user_id'),
    hourly: rows('SELECT * FROM server_hourly ORDER BY hour'),
  };
}

beforeEach(() => {
  now = T0;
  database = createTestDatabase();
  server = new FakeTs3Server();
  connections = [];
});

afterEach(async () => {
  for (const connection of connections) await connection.stop();
  database.close();
});

describe('crash recovery', () => {
  it('closes sessions and segments left open by a crash at the last heartbeat', async () => {
    const first = await startWatcher();
    const alice = server.join({ uid: 'alice', nickname: 'Alice' });
    server.join({ uid: 'bob', nickname: 'Bob' });
    for (let m = 1; m <= 6; m++) {
      now = T0 + m * MIN;
      await first.sync(); // flushes open segments at 5 min
    }
    expect(openCount()).toEqual({ sessions: 2, segments: 2 });
    expect(readHeartbeat(database.db)).toBe(T0 + 6 * MIN);

    // Crash: the process dies without stop(); the server keeps running.
    server.dropConnection();
    server.leave(alice);
    now = T0 + 60 * MIN;
    await startWatcher();

    expect(
      rows(`SELECT u.uid, s.join_at - ${String(T0)} AS j, s.leave_at - ${String(T0)} AS l
            FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY s.id`),
    ).toEqual([
      { uid: 'alice', j: 0, l: 6 * MIN },
      { uid: 'bob', j: 0, l: 6 * MIN },
      // Bob is still online: a new session starts with the new process.
      { uid: 'bob', j: 60 * MIN, l: null },
    ]);
    expect(
      rows(`SELECT end_at - ${String(T0)} AS e, is_open FROM activity_segments ORDER BY id`),
    ).toEqual([
      { e: 6 * MIN, is_open: 0 },
      { e: 6 * MIN, is_open: 0 },
    ]);
  });

  it('leaves aggregates consistent with a full rebuild', async () => {
    const first = await startWatcher();
    server.join({ uid: 'alice', nickname: 'Alice' });
    for (let m = 1; m <= 7; m++) {
      now = T0 + m * MIN;
      await first.sync();
    }
    server.dropConnection();
    recoverOpenSessions(database, logger);

    const recovered = snapshot();
    database.sqlite.exec(
      'DELETE FROM user_daily_stats; DELETE FROM user_totals; DELETE FROM server_hourly;',
    );
    rebuildAggregates(database);
    expect(snapshot()).toEqual(recovered);
    expect(recovered.totals).toMatchObject([{ online_s: 7 * MIN, active_s: 7 * MIN }]);
  });

  it('uses the last known point in time when there is no heartbeat', () => {
    const userId = upsertUser(database.db, { uid: 'u', seenAt: T0 });
    const withSegment = openSession(database.db, userId, T0);
    const segment = openSegment(database.db, {
      userId,
      sessionId: withSegment,
      channelId: null,
      state: 'active',
      startAt: T0,
    });
    database.sqlite
      .prepare('UPDATE activity_segments SET end_at = ? WHERE id = ?')
      .run(T0 + 300, segment);
    const bare = openSession(database.db, userId, T0 + 50);

    expect(recoverOpenSessions(database, logger)).toEqual({
      sessions: 2,
      segments: 1,
      heartbeat: undefined,
    });
    expect(rows('SELECT id, leave_at FROM sessions ORDER BY id')).toEqual([
      { id: withSegment, leave_at: T0 + 300 },
      { id: bare, leave_at: T0 + 50 },
    ]);
  });

  it('never ends a segment before its last known end', () => {
    const userId = upsertUser(database.db, { uid: 'u', seenAt: T0 });
    const sessionId = openSession(database.db, userId, T0);
    const segment = openSegment(database.db, {
      userId,
      sessionId,
      channelId: null,
      state: 'idle',
      startAt: T0,
    });
    database.sqlite
      .prepare('UPDATE activity_segments SET end_at = ? WHERE id = ?')
      .run(T0 + 900, segment);
    database.sqlite
      .prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('watcher.heartbeat', ?, ?)`)
      .run(String(T0 + 600), T0 + 600);
    recoverOpenSessions(database, logger);
    expect(rows('SELECT end_at FROM activity_segments')).toEqual([{ end_at: T0 + 900 }]);
    expect(rows('SELECT leave_at FROM sessions')).toEqual([{ leave_at: T0 + 900 }]);
  });

  it('does nothing after a clean shutdown', async () => {
    const first = await startWatcher();
    server.join({ uid: 'alice', nickname: 'Alice' });
    now = T0 + MIN;
    await first.sync();
    first.stop();
    expect(openCount()).toEqual({ sessions: 0, segments: 0 });
    expect(recoverOpenSessions(database, logger)).toMatchObject({ sessions: 0, segments: 0 });
  });
});
