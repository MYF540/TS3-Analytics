import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { createTestDatabase } from '../db/testing.js';
import { createSilentLogger } from '../logging/logger.js';
import { Ts3Connection } from '../ts3/connection.js';
import { FakeTs3Server } from '../ts3/fake-transport.js';
import { CLIENT_TYPE_QUERY } from '../ts3/types.js';
import { Watcher } from './watcher.js';

const T0 = 1_780_000_000;
const UID_A = 'alice-uid-000000000000000000=';
const UID_B = 'bob-uid-00000000000000000000=';

let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let watcher: Watcher;
let now: number;

/** Lets pending promise callbacks (queue, sync) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

const rows = (sql: string) => database.sqlite.prepare(sql).all();

beforeEach(async () => {
  now = T0;
  database = createTestDatabase();
  server = new FakeTs3Server();
  server.addChannel(2, 'Gaming');
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000, initialBackoffMs: 1, maxBackoffMs: 1, jitter: 0 },
    { logger: createSilentLogger() },
  );
  watcher = new Watcher({ database, connection, logger: createSilentLogger(), now: () => now });
  watcher.start();
  connection.start();
  await settle();
});

afterEach(async () => {
  await connection.stop();
  database.close();
});

describe('Watcher', () => {
  it('records join → move → nick change → leave', async () => {
    now = T0 + 10;
    const clid = server.join({ uid: UID_A, nickname: 'Alice', dbid: 77, platform: 'Linux' });

    now = T0 + 70;
    server.move(clid, 2);
    expect(watcher.tracker.get(clid)?.channelId).toBe(2);

    // TS3 does not notify queries about nick changes; the next client-list sync picks it up.
    now = T0 + 130;
    server.update(clid, { nickname: 'AliceTheGreat' });
    await watcher.sync();

    now = T0 + 610;
    server.leave(clid);

    expect(rows('SELECT uid, dbid, platform, first_seen, last_seen FROM users')).toEqual([
      { uid: UID_A, dbid: 77, platform: 'Linux', first_seen: T0 + 10, last_seen: T0 + 10 },
    ]);
    expect(rows('SELECT nick, first_seen, last_seen FROM nicknames ORDER BY first_seen')).toEqual([
      { nick: 'Alice', first_seen: T0 + 10, last_seen: T0 + 10 },
      { nick: 'AliceTheGreat', first_seen: T0 + 130, last_seen: T0 + 130 },
    ]);
    expect(rows('SELECT join_at, leave_at, duration, source FROM sessions')).toEqual([
      { join_at: T0 + 10, leave_at: T0 + 610, duration: 600, source: 'live' },
    ]);
    expect(rows('SELECT online_s, sessions FROM user_totals')).toEqual([
      { online_s: 600, sessions: 1 },
    ]);
    expect(watcher.tracker.onlineClients).toEqual([]);
  });

  it('stores channel names on connect', () => {
    expect(rows('SELECT id, name FROM channels ORDER BY id')).toEqual([
      { id: 1, name: 'Lobby' },
      { id: 2, name: 'Gaming' },
    ]);
  });

  it('picks up clients that were already online at startup', async () => {
    await connection.stop();
    const clid = server.join({ uid: UID_B, nickname: 'Bob' });
    connection = new Ts3Connection(
      server.createTransport,
      { commandsPerSecond: 1000 },
      { logger: createSilentLogger() },
    );
    watcher = new Watcher({ database, connection, logger: createSilentLogger(), now: () => now });
    watcher.start();
    connection.start();
    await settle();
    expect(watcher.tracker.get(clid)?.uid).toBe(UID_B);
    expect(rows('SELECT count(*) AS n FROM sessions WHERE leave_at IS NULL')).toEqual([{ n: 1 }]);
  });

  it('ignores query clients entirely', () => {
    const clid = server.join({ uid: 'serveradmin', nickname: 'Query', type: CLIENT_TYPE_QUERY });
    server.move(clid, 2);
    server.leave(clid);
    expect(rows('SELECT count(*) AS n FROM users')).toEqual([{ n: 0 }]);
  });

  it('identifies users by UID, not by nickname', () => {
    const a = server.join({ uid: UID_A, nickname: 'SameName' });
    const b = server.join({ uid: UID_B, nickname: 'SameName' });
    server.leave(a);
    server.leave(b);
    expect(rows('SELECT count(*) AS n FROM users')).toEqual([{ n: 2 }]);
    const again = server.join({ uid: UID_A, nickname: 'OtherName' });
    server.leave(again);
    expect(rows('SELECT count(*) AS n FROM users')).toEqual([{ n: 2 }]);
  });

  it('closes sessions of clients that left during a connection outage at the time of the loss', async () => {
    now = T0 + 100;
    const stays = server.join({ uid: UID_A, nickname: 'Alice' });
    const goes = server.join({ uid: UID_B, nickname: 'Bob' });

    now = T0 + 500;
    server.dropConnection();
    server.leave(goes); // not observed: connection is down
    now = T0 + 900;
    // Wait for reconnect (1 ms backoff) and the following client-list sync.
    await vi.waitFor(() => {
      expect(server.connectAttempts).toBe(2);
      expect(watcher.tracker.get(goes)).toBeUndefined();
    });

    expect(watcher.tracker.get(stays)).toBeDefined();
    expect(watcher.tracker.get(goes)).toBeUndefined();
    expect(
      rows(
        `SELECT u.uid, s.leave_at FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY u.uid`,
      ),
    ).toEqual([
      { uid: UID_A, leave_at: null },
      { uid: UID_B, leave_at: T0 + 500 },
    ]);
  });

  it('does not reopen a client that left while the client list was being fetched', async () => {
    const clid = server.join({ uid: UID_A, nickname: 'Alice' });
    // Alice leaves right after the server took the client-list snapshot that still contains her.
    server.afterSnapshot = (command) => {
      if (command === 'clientlist') server.leave(clid);
    };
    await watcher.sync();
    server.afterSnapshot = undefined;
    expect(watcher.tracker.get(clid)).toBeUndefined();
    expect(rows('SELECT count(*) AS n FROM sessions WHERE leave_at IS NULL')).toEqual([{ n: 0 }]);
  });

  it('handles a reused clid as a new client', () => {
    const clid = server.join({ uid: UID_A, nickname: 'Alice' });
    server.clients.delete(clid); // left without an event
    now = T0 + 50;
    server.join({ uid: UID_B, nickname: 'Bob', clid });
    expect(watcher.tracker.get(clid)?.uid).toBe(UID_B);
    expect(rows('SELECT leave_at FROM sessions ORDER BY id')).toEqual([
      { leave_at: T0 + 50 },
      { leave_at: null },
    ]);
  });

  it('closes all sessions on stop', () => {
    server.join({ uid: UID_A, nickname: 'Alice' });
    now = T0 + 300;
    watcher.stop();
    expect(rows('SELECT leave_at FROM sessions')).toEqual([{ leave_at: T0 + 300 }]);
  });
});
