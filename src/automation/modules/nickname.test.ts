import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import { createSilentLogger } from '../../logging/logger.js';
import { Ts3Connection } from '../../ts3/connection.js';
import { FakeTs3Server } from '../../ts3/fake-transport.js';
import { SessionTracker } from '../../watcher/tracker.js';
import { AutomationHost } from '../host.js';
import { listAutomationLog } from '../log.js';
import { saveModuleSettings } from '../settings.js';
import { NicknameModule } from './nickname.js';

const NOW = 1_789_800_000;

let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let tracker: SessionTracker;
let host: AutomationHost;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function configure(settings: Record<string, unknown>): void {
  saveModuleSettings(
    database.db,
    'nickname',
    { enabled: true, dryRun: false, patterns: [{ pattern: 'admin' }], ...settings },
    NOW,
  );
}

/** Lets the tracker see the server's client list, like a poll does. */
async function poll(): Promise<void> {
  tracker.sync(await connection.clientList(), NOW);
  await host.idle();
  await settle();
}

const log = () =>
  listAutomationLog(database.sqlite, { limit: 20, offset: 0 }).items.map((row) => [
    row.action,
    row.result,
    row.detail,
  ]);

beforeEach(async () => {
  database = createTestDatabase();
  server = new FakeTs3Server();
  const logger = createSilentLogger();
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000, initialBackoffMs: 1, maxBackoffMs: 1, jitter: 0 },
    { logger },
  );
  tracker = new SessionTracker(database, logger);
  host = new AutomationHost(logger);
  tracker.addListener(host);
  host.register(new NicknameModule({ database, commands: connection, logger, now: () => NOW }));
  connection.on('clientConnect', (client) => tracker.join(client, NOW));
  connection.start();
  await vi.waitFor(() => {
    expect(connection.isConnected).toBe(true);
  });
});

afterEach(async () => {
  await connection.stop();
  database.close();
});

describe('NicknameModule', () => {
  it('kicks a client that joins with a forbidden nickname', async () => {
    configure({});
    const bad = server.join({ uid: 'uid-a', nickname: 'Server-Admin' });
    const good = server.join({ uid: 'uid-b', nickname: 'Alice' });
    await host.idle();
    await settle();
    expect(server.clients.has(bad)).toBe(false);
    expect(server.clients.has(good)).toBe(true);
    expect(server.moderation).toEqual([
      { command: 'kick.server', clid: bad, text: 'Dieser Nickname ist hier nicht erlaubt.' },
    ]);
    expect(log()).toEqual([['kick', 'done', 'Nickname „Server-Admin“, Muster „admin“']]);
  });

  it('does nothing while it is switched off', async () => {
    configure({ enabled: false });
    const clid = server.join({ uid: 'uid-a', nickname: 'Admin' });
    await host.idle();
    await settle();
    expect(server.clients.has(clid)).toBe(true);
    expect(log()).toEqual([]);
  });

  it('only records the hit in test mode', async () => {
    configure({ dryRun: true });
    const clid = server.join({ uid: 'uid-a', nickname: 'Admin' });
    await host.idle();
    await settle();
    expect(server.clients.has(clid)).toBe(true);
    expect(server.moderation).toEqual([]);
    expect(log()).toEqual([['kick', 'dry', 'Nickname „Admin“, Muster „admin“']]);
  });

  it('leaves members of an exempt group alone', async () => {
    configure({ exemptGroupIds: [6] });
    const clid = server.join({ uid: 'uid-a', nickname: 'Admin', serverGroups: [6] });
    await host.idle();
    await settle();
    expect(server.clients.has(clid)).toBe(true);
    expect(log()).toEqual([]);
  });

  it('notices a rename on the next poll', async () => {
    configure({ action: 'poke', message: 'Bitte ändere deinen Namen.' });
    const clid = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    server.update(clid, { nickname: 'Аdm1n' });
    await poll();
    expect(server.moderation).toEqual([
      { command: 'poke', clid, text: 'Bitte ändere deinen Namen.' },
    ]);
    // No rename, no second poke.
    await poll();
    expect(server.moderation).toHaveLength(1);
  });

  it('uses the text of the pattern when it has one', async () => {
    configure({
      action: 'message',
      patterns: [{ pattern: '^mod', regex: true, message: 'Du bist kein Moderator.' }],
    });
    const clid = server.join({ uid: 'uid-a', nickname: 'Moderator' });
    await host.idle();
    await settle();
    expect(server.moderation).toEqual([
      { command: 'message', clid, text: 'Du bist kein Moderator.' },
    ]);
  });

  it('checks who is already online when the service starts', async () => {
    configure({});
    await connection.stop();
    const fresh = new FakeTs3Server();
    const clid = fresh.join({ uid: 'uid-a', nickname: 'Admin' });
    connection = new Ts3Connection(
      fresh.createTransport,
      { commandsPerSecond: 1000, initialBackoffMs: 1, maxBackoffMs: 1, jitter: 0 },
      { logger: createSilentLogger() },
    );
    const logger = createSilentLogger();
    tracker = new SessionTracker(database, logger);
    host = new AutomationHost(logger);
    tracker.addListener(host);
    host.register(new NicknameModule({ database, commands: connection, logger, now: () => NOW }));
    connection.start();
    await vi.waitFor(() => {
      expect(connection.isConnected).toBe(true);
    });
    await poll();
    expect(fresh.clients.has(clid)).toBe(false);
  });
});
