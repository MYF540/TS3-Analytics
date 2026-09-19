import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { upsertUser } from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import { createSilentLogger } from '../logging/logger.js';
import { Ts3Connection } from '../ts3/connection.js';
import { FakeTs3Server } from '../ts3/fake-transport.js';
import { loadGroupWatch, saveGroupWatch } from './group-settings.js';
import { GroupWatch } from './group-watch.js';

let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let watch: GroupWatch;
const notify = vi.fn();

const line = (time: string, text: string) =>
  `2026-09-19 ${time}|INFO    |VirtualServer |1  |${text}`;
const added = (time: string, dbid: number, group: string, gid: number) =>
  line(
    time,
    `client (id:${String(dbid)}) was added to servergroup '${group}'(id:${String(gid)}) by client 'Admin'(id:2)`,
  );

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function rows() {
  return database.sqlite
    .prepare(
      'SELECT action, dbid, user_id AS userId, group_id AS groupId, protected FROM group_changes ORDER BY log_pos',
    )
    .all();
}

beforeEach(async () => {
  notify.mockReset();
  database = createTestDatabase();
  server = new FakeTs3Server();
  server.serverLog.push(
    added('10:00:00.000001', 17, 'Server Admin', 6),
    line('10:00:01.000000', "client connected 'Bob'(id:17) from 203.0.113.9:1234"),
  );
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000, initialBackoffMs: 1, maxBackoffMs: 1, jitter: 0 },
    { logger: createSilentLogger() },
  );
  saveGroupWatch(database.db, { protectedGroupIds: [6] }, 0);
  watch = new GroupWatch({
    database,
    connection,
    notifier: { notify },
    logger: createSilentLogger(),
    intervalS: 30,
  });
  watch.start();
  connection.start();
  await settle();
});

afterEach(async () => {
  watch.stop();
  await connection.stop();
  database.close();
});

describe('GroupWatch', () => {
  it('stores the history on the first run without alerting and caches the group list', () => {
    expect(rows()).toEqual([{ action: 'added', dbid: 17, userId: null, groupId: 6, protected: 1 }]);
    expect(notify).not.toHaveBeenCalled();
    expect(loadGroupWatch(database.db).knownGroups).toEqual([
      { id: 6, name: 'Server Admin' },
      { id: 8, name: 'Guest' },
    ]);
    // Only parsed fields are stored, never raw lines (which contain IPs).
    expect(
      JSON.stringify(database.sqlite.prepare('SELECT * FROM group_changes').all()),
    ).not.toContain('203.0.113');
  });

  it('alerts new changes of protected groups only, once', async () => {
    const userId = upsertUser(database.db, { uid: 'bob=', seenAt: 1, dbid: 21 });
    server.serverLog.push(
      added('10:05:00.000000', 21, 'Server Admin', 6),
      added('10:05:00.000000', 22, 'Guest', 8),
      line(
        '10:06:00.000000',
        "client 'Eve'(id:23) was removed from servergroup 'Server Admin'(id:6) by client 'Admin'(id:2)",
      ),
    );
    expect(await watch.poll()).toEqual({ stored: 3, alerted: 2, gap: false });
    expect(notify.mock.calls).toEqual([
      ['group.protected', expect.stringContaining('wurde zur Gruppe „Server Admin“ hinzugefügt')],
      [
        'group.protected',
        expect.stringContaining('Eve wurde aus der Gruppe „Server Admin“ entfernt'),
      ],
    ]);
    expect(rows()).toContainEqual({ action: 'added', dbid: 21, userId, groupId: 6, protected: 1 });
    // Polling again finds nothing new.
    expect(await watch.poll()).toEqual({ stored: 0, alerted: 0, gap: false });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('warns about a gap when the log moved on by more than a page', async () => {
    for (let i = 0; i < 120; i++) {
      server.serverLog.push(
        line(
          `11:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000000`,
          'client disconnected',
        ),
      );
    }
    expect(await watch.poll()).toMatchObject({ gap: true });
  });

  it('keeps working when the log cannot be read', async () => {
    await connection.stop();
    expect(await watch.poll()).toBeUndefined();
  });
});
