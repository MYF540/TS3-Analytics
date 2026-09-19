import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { createTestDatabase } from '../db/testing.js';
import { DEFAULT_ACTIVITY_SETTINGS } from '../domain/activity.js';
import { createSilentLogger } from '../logging/logger.js';
import { Ts3Connection } from '../ts3/connection.js';
import { FakeTs3Server } from '../ts3/fake-transport.js';
import { loadActivitySettings, saveActivitySettings } from './settings.js';
import { Watcher } from './watcher.js';

const T0 = 1_780_000_020; // minute-aligned
const UID = 'alice-uid-000000000000000000=';
const MIN = 60;

let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let watcher: Watcher;
let now: number;

const rows = (sql: string) => database.sqlite.prepare(sql).all();
const segments = () =>
  rows(
    `SELECT channel_id AS ch, state, start_at - ${String(T0)} AS s, end_at - ${String(T0)} AS e,
            is_open AS open FROM activity_segments ORDER BY start_at, id`,
  );

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** Advances the clock and runs one poll. */
async function pollAt(offset: number): Promise<void> {
  now = T0 + offset;
  await watcher.sync();
}

beforeEach(async () => {
  now = T0;
  database = createTestDatabase();
  saveActivitySettings(
    database.db,
    { ...DEFAULT_ACTIVITY_SETTINGS, idleThresholdS: 600, afkChannelIds: [9] },
    T0,
  );
  server = new FakeTs3Server();
  server.addChannel(2, 'Gaming');
  server.addChannel(9, 'AFK');
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000 },
    { logger: createSilentLogger() },
  );
  watcher = new Watcher({
    database,
    connection,
    logger: createSilentLogger(),
    now: () => now,
    flushIntervalS: 300,
  });
  watcher.start();
  connection.start();
  await settle();
});

afterEach(async () => {
  watcher.stop();
  await connection.stop();
  database.close();
});

describe('activity tracking', () => {
  it('extends one segment while nothing changes and splits it when the client goes idle', async () => {
    const clid = server.join({ uid: UID, nickname: 'Alice' });
    await pollAt(1 * MIN);
    await pollAt(2 * MIN);
    server.update(clid, { idleMs: 700_000 });
    await pollAt(3 * MIN);
    await pollAt(4 * MIN);
    server.leave(clid);
    now = T0 + 4 * MIN + 30;
    watcher.flush();

    // Idle for 700 s at minute 3 with a 600 s threshold → idle since 100 s before the poll,
    // but not before the previous observation at minute 2.
    expect(segments()).toEqual([
      { ch: 1, state: 'active', s: 0, e: 2 * MIN, open: 0 },
      { ch: 1, state: 'idle', s: 2 * MIN, e: 4 * MIN, open: 0 },
    ]);
    expect(rows('SELECT online_s, active_s, idle_s, afk_s FROM user_daily_stats')).toEqual([
      { online_s: 4 * MIN, active_s: 2 * MIN, idle_s: 2 * MIN, afk_s: 0 },
    ]);
    expect(rows('SELECT active_s FROM user_totals')).toEqual([{ active_s: 2 * MIN }]);
  });

  it('dates idle transitions back to the second (T2.8)', async () => {
    const clid = server.join({ uid: UID, nickname: 'Alice' });
    for (let m = 1; m <= 12; m++) {
      server.update(clid, { idleMs: m * MIN * 1000 }); // no activity since joining
      await pollAt(m * MIN);
    }
    // Crossed the 600 s threshold exactly at minute 10.
    server.update(clid, { idleMs: 25_000 }); // spoke 25 s before the next poll
    await pollAt(15 * MIN);
    now = T0 + 16 * MIN;
    server.leave(clid);
    watcher.flush();
    expect(segments()).toEqual([
      { ch: 1, state: 'active', s: 0, e: 10 * MIN, open: 0 },
      { ch: 1, state: 'idle', s: 10 * MIN, e: 15 * MIN - 25, open: 0 },
      { ch: 1, state: 'active', s: 15 * MIN - 25, e: 16 * MIN, open: 0 },
    ]);
  });

  it('splits segments at channel moves and treats the AFK channel as afk', async () => {
    const clid = server.join({ uid: UID, nickname: 'Alice' });
    now = T0 + 30;
    server.move(clid, 2);
    now = T0 + 90;
    server.move(clid, 9);
    await pollAt(2 * MIN);
    now = T0 + 150;
    server.leave(clid);
    watcher.flush();

    expect(segments()).toEqual([
      { ch: 1, state: 'active', s: 0, e: 30, open: 0 },
      { ch: 2, state: 'active', s: 30, e: 90, open: 0 },
      { ch: 9, state: 'afk', s: 90, e: 150, open: 0 },
    ]);
  });

  it('covers the whole session with segments', async () => {
    const clid = server.join({ uid: UID, nickname: 'Alice' });
    for (let m = 1; m <= 10; m++) {
      if (m === 4) server.update(clid, { away: true });
      if (m === 6) server.update(clid, { away: false, idleMs: 0 });
      if (m === 8) server.move(clid, 2);
      await pollAt(m * MIN);
    }
    now = T0 + 10 * MIN + 20;
    server.leave(clid);
    watcher.flush();

    const [session] = rows('SELECT duration FROM sessions') as { duration: number }[];
    const [covered] = rows(
      'SELECT sum(end_at - start_at) AS total, min(start_at) AS first, max(end_at) AS last FROM activity_segments',
    ) as { total: number; first: number; last: number }[];
    expect(covered?.total).toBe(session?.duration);
    expect(covered?.first).toBe(T0);
    expect(covered?.last).toBe(T0 + 10 * MIN + 20);
  });

  it('keeps segments in memory until the flush interval has passed', async () => {
    const clid = server.join({ uid: UID, nickname: 'Alice' });
    await pollAt(1 * MIN);
    server.move(clid, 2);
    await pollAt(2 * MIN);
    await pollAt(4 * MIN);
    expect(segments()).toEqual([]);
    expect(watcher.activity.pendingClosed).toBe(1);

    await pollAt(5 * MIN); // 300 s since the first poll → flush
    expect(segments()).toEqual([
      { ch: 1, state: 'active', s: 0, e: 1 * MIN, open: 0 },
      { ch: 2, state: 'active', s: 1 * MIN, e: 5 * MIN, open: 1 },
    ]);
    expect(watcher.activity.pendingClosed).toBe(0);
  });

  it('extends open rows on later flushes and closes them when the client leaves', async () => {
    const clid = server.join({ uid: UID, nickname: 'Alice' });
    await pollAt(5 * MIN);
    watcher.flush();
    expect(segments()).toEqual([{ ch: 1, state: 'active', s: 0, e: 5 * MIN, open: 1 }]);

    await pollAt(8 * MIN);
    watcher.flush();
    expect(segments()).toEqual([{ ch: 1, state: 'active', s: 0, e: 8 * MIN, open: 1 }]);

    now = T0 + 9 * MIN;
    server.leave(clid);
    watcher.flush();
    expect(segments()).toEqual([{ ch: 1, state: 'active', s: 0, e: 9 * MIN, open: 0 }]);
    expect(rows('SELECT active_s FROM user_totals')).toEqual([{ active_s: 9 * MIN }]);
  });

  it('writes the online count once per poll', async () => {
    server.join({ uid: UID, nickname: 'Alice' });
    server.join({ uid: 'bob-uid', nickname: 'Bob' });
    await pollAt(1 * MIN);
    await pollAt(2 * MIN);
    expect(
      rows('SELECT ts - ' + String(T0) + ' AS t, online FROM server_minutely ORDER BY ts'),
    ).toEqual([
      { t: 0, online: 0 },
      { t: MIN, online: 2 },
      { t: 2 * MIN, online: 2 },
    ]);
  });

  it('creates placeholder rows for channels not in the channel list yet', () => {
    const clid = server.join({ uid: UID, nickname: 'Alice' });
    now = T0 + 30;
    server.move(clid, 4242); // temporary channel created after the last channel list
    now = T0 + 60;
    server.leave(clid);
    watcher.flush();
    expect(rows('SELECT name FROM channels WHERE id = 4242')).toEqual([{ name: 'Channel 4242' }]);
  });

  it('uses the stored activity settings', () => {
    expect(loadActivitySettings(database.db)).toMatchObject({
      idleThresholdS: 600,
      afkChannelIds: [9],
    });
  });

  it('writes pending segments on stop and keeps them open for a quick restart', async () => {
    server.join({ uid: UID, nickname: 'Alice' });
    await pollAt(2 * MIN);
    now = T0 + 2 * MIN + 10;
    watcher.stop();
    expect(segments()).toEqual([{ ch: 1, state: 'active', s: 0, e: 2 * MIN + 10, open: 1 }]);
  });
});

describe('loadActivitySettings', () => {
  it('falls back to defaults when nothing is stored', () => {
    const db = createTestDatabase();
    try {
      expect(loadActivitySettings(db.db)).toEqual(DEFAULT_ACTIVITY_SETTINGS);
    } finally {
      db.close();
    }
  });
});
