import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { upsertUser } from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import { createSilentLogger } from '../logging/logger.js';
import { Ts3Connection } from '../ts3/connection.js';
import { FakeTs3Server } from '../ts3/fake-transport.js';
import { Watcher } from '../watcher/watcher.js';
import { JoinSpikeDetector } from './join-spike.js';
import { AlertNotifier } from './notifier.js';
import { saveAlertSettings } from './settings.js';

const T0 = 1_780_000_000;

let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let watcher: Watcher;
let notify: MockInstance<AlertNotifier['notify']>;
let now: number;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

beforeEach(async () => {
  now = T0;
  database = createTestDatabase();
  saveAlertSettings(database.db, { joinSpike: { windowMinutes: 10, threshold: 3 } }, T0);
  server = new FakeTs3Server();
  // Online before the bot starts: found by the first sync, never counted.
  for (let i = 0; i < 5; i++)
    server.join({ uid: `early-${String(i)}=`, nickname: `Early${String(i)}` });
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000, initialBackoffMs: 1, maxBackoffMs: 1, jitter: 0 },
    { logger: createSilentLogger() },
  );
  const notifier = new AlertNotifier({ db: database.db, logger: createSilentLogger() });
  notify = vi.spyOn(notifier, 'notify').mockImplementation(() => undefined);
  watcher = new Watcher({ database, connection, logger: createSilentLogger(), now: () => now });
  watcher.tracker.addListener(new JoinSpikeDetector(database, notifier, createSilentLogger()));
  watcher.start();
  connection.start();
  await settle();
});

afterEach(async () => {
  await connection.stop();
  database.close();
});

describe('JoinSpikeDetector', () => {
  it('alerts once when enough new UIDs join within the window', () => {
    expect(database.sqlite.prepare('SELECT count(*) FROM users').pluck().get()).toBe(5);
    expect(notify).not.toHaveBeenCalled();

    upsertUser(database.db, { uid: 'known=', seenAt: T0 - 86_400 });
    now = T0 + 60;
    server.join({ uid: 'known=', nickname: 'Stammgast' });
    server.join({ uid: 'new-1=', nickname: 'Neu*1' });
    now = T0 + 120;
    server.join({ uid: 'new-2=', nickname: 'Neu2' });
    expect(notify).not.toHaveBeenCalled();
    now = T0 + 180;
    server.join({ uid: 'new-3=', nickname: 'Neu3' });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]).toEqual([
      'join.spike',
      '🚨 **Join-Spike:** 3 neue Accounts in den letzten 10 Minuten: Neu\\*1, Neu2, Neu3',
    ]);

    // Further joins within the same window do not alert again.
    now = T0 + 240;
    server.join({ uid: 'new-4=', nickname: 'Neu4' });
    expect(notify).toHaveBeenCalledOnce();
  });

  it('forgets joins older than the window', () => {
    now = T0 + 60;
    server.join({ uid: 'a=', nickname: 'A' });
    server.join({ uid: 'b=', nickname: 'B' });
    now = T0 + 60 + 600;
    server.join({ uid: 'c=', nickname: 'C' });
    expect(notify).not.toHaveBeenCalled();
  });
});
