import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import { SlidingCounter, spamStep, thresholdsAscend } from '../../domain/spam.js';
import { createSilentLogger } from '../../logging/logger.js';
import { Ts3Connection } from '../../ts3/connection.js';
import { FakeTs3Server } from '../../ts3/fake-transport.js';
import { SessionTracker } from '../../watcher/tracker.js';
import { AutomationHost } from '../host.js';
import { listAutomationLog } from '../log.js';
import { saveModuleSettings } from '../settings.js';
import { SpamModule } from './spam.js';

let now: number;
let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let tracker: SessionTracker;
let host: AutomationHost;

function configure(settings: Record<string, unknown>): void {
  saveModuleSettings(database.db, 'spam', { enabled: true, dryRun: false, ...settings }, now);
}

const switching = { enabled: true, windowS: 10, warnAt: 3, kickAt: 5, banAt: 0 };

async function poll(): Promise<void> {
  tracker.sync(await connection.clientList(), now);
  await host.idle();
}

/** The client hops between two channels `times` times, one second apart. */
async function hop(clid: number, times: number, invoker?: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    now += 1;
    server.move(clid, server.clients.get(clid)?.channelId === 2 ? 1 : 2, invoker);
    await host.idle();
  }
}

const sent = () => server.moderation.map((m) => m.command);
const log = () =>
  listAutomationLog(database.sqlite, { limit: 30, offset: 0 })
    .items.map((row) => [row.action, row.result, row.detail])
    .reverse();

beforeEach(async () => {
  now = 1_789_800_000;
  database = createTestDatabase();
  server = new FakeTs3Server();
  server.addChannel(2, 'Gaming');
  const logger = createSilentLogger();
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000, initialBackoffMs: 1, maxBackoffMs: 1, jitter: 0 },
    { logger },
  );
  tracker = new SessionTracker(database, logger);
  host = new AutomationHost(logger);
  tracker.addListener(host);
  host.register(new SpamModule({ database, commands: connection, logger, now: () => now }));
  connection.on('clientConnect', (client) => tracker.join(client, now));
  connection.on('clientMoved', (event) => {
    tracker.move(event.clid, event.channelId, now, event);
  });
  connection.on('clientDisconnect', (event) => {
    tracker.leave(event.clid, now);
  });
  connection.on('channelCreated', (event) => {
    host.onChannelCreatedEvent(event, now);
  });
  connection.start();
  await vi.waitFor(() => {
    expect(connection.isConnected).toBe(true);
  });
});

afterEach(async () => {
  await connection.stop();
  database.close();
});

describe('channel switching', () => {
  it('warns at the first threshold and kicks at the second', async () => {
    configure({ channelSwitch: switching });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await hop(alice, 2);
    expect(sent()).toEqual([]);
    await hop(alice, 1);
    expect(sent()).toEqual(['poke']);
    await hop(alice, 1);
    expect(sent()).toEqual(['poke']);
    await hop(alice, 1);
    expect(sent()).toEqual(['poke', 'kick.server']);
    expect(server.clients.has(alice)).toBe(false);
    expect(log().at(-1)).toEqual(['kick', 'done', 'Channel-Wechsel: 5 in 10 s']);
  });

  it('forgets switches that are older than the window', async () => {
    configure({ channelSwitch: switching });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await hop(alice, 2);
    now += 20;
    await hop(alice, 2);
    expect(sent()).toEqual([]);
  });

  it('does not count being moved by somebody else', async () => {
    configure({ channelSwitch: switching });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    const admin = server.join({ uid: 'uid-b', nickname: 'Admin' });
    await host.idle();
    await hop(alice, 8, admin);
    expect(sent()).toEqual([]);
  });

  it('leaves exempt groups alone and can warn by message', async () => {
    configure({ exemptGroupIds: [6], channelSwitch: { ...switching, warnBy: 'message' } });
    const admin = server.join({ uid: 'uid-b', nickname: 'Admin', serverGroups: [6] });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await hop(admin, 6);
    await hop(alice, 3);
    expect(server.moderation).toEqual([
      { command: 'message', clid: alice, text: 'Bitte langsamer: Channel-Wechsel.' },
    ]);
  });

  it('bans for a limited time and starts counting afresh', async () => {
    configure({
      channelSwitch: { ...switching, warnAt: 0, kickAt: 0, banAt: 3, banDurationS: 900 },
    });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await hop(alice, 3);
    expect(server.bans).toMatchObject([
      { uid: 'uid-a', durationS: 900, reason: 'Spam: Channel-Wechsel' },
    ]);
    expect(server.clients.has(alice)).toBe(false);
  });
});

describe('other kinds of spam', () => {
  it('counts each kind on its own', async () => {
    configure({
      channelSwitch: switching,
      channelCreate: { enabled: true, windowS: 60, warnAt: 2, kickAt: 0, banAt: 0 },
    });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    server.createChannelAs(alice, 'Raum 1', 0, 'semi');
    await host.idle();
    await hop(alice, 2);
    expect(sent()).toEqual([]);
    server.createChannelAs(alice, 'Raum 2', 0, 'semi');
    await host.idle();
    expect(server.moderation).toEqual([
      { command: 'poke', clid: alice, text: 'Bitte langsamer: Channels anlegen.' },
    ]);
  });

  it('counts renames seen by the poll', async () => {
    configure({ nickname: { enabled: true, windowS: 600, warnAt: 2, kickAt: 3, banAt: 0 } });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    for (const nickname of ['A1', 'A2', 'A3']) {
      now += 60;
      server.update(alice, { nickname });
      await poll();
    }
    expect(sent()).toEqual(['poke', 'kick.server']);
  });

  it('keeps counting reconnects across connections', async () => {
    configure({ reconnect: { enabled: true, windowS: 300, warnAt: 0, kickAt: 0, banAt: 3 } });
    for (let i = 0; i < 2; i++) {
      now += 5;
      const clid = server.join({ uid: 'uid-a', nickname: 'Alice' });
      await host.idle();
      server.leave(clid);
    }
    expect(server.bans).toEqual([]);
    now += 5;
    server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    expect(server.bans).toMatchObject([{ uid: 'uid-a', durationS: 600 }]);
  });

  it('counts visits of a private-channel lobby', async () => {
    saveModuleSettings(
      database.db,
      'private',
      { lobbies: [{ id: 'main', lobbyChannelId: 2, parentId: 1 }] },
      now,
    );
    configure({ lobby: { enabled: true, windowS: 60, warnAt: 2, kickAt: 0, banAt: 0 } });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await hop(alice, 3);
    expect(sent()).toEqual(['poke']);
    expect(log()).toEqual([['poke', 'done', 'Lobby-Besuche: 2 in 60 s']]);
  });
});

describe('switches', () => {
  it('does nothing for a kind that is off or while the module is off', async () => {
    configure({ channelSwitch: { ...switching, enabled: false } });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await hop(alice, 8);
    configure({ enabled: false, channelSwitch: switching });
    await hop(alice, 8);
    expect(sent()).toEqual([]);
  });

  it('only records in test mode', async () => {
    configure({ dryRun: true, channelSwitch: switching });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await hop(alice, 5);
    expect(sent()).toEqual([]);
    expect(server.clients.has(alice)).toBe(true);
    expect(log().map(([action, result]) => [action, result])).toEqual([
      ['poke', 'dry'],
      ['kick', 'dry'],
    ]);
  });
});

describe('spam rules', () => {
  it('counts within a sliding window per key', () => {
    const counter = new SlidingCounter();
    expect(counter.hit('a', 100, 10)).toBe(1);
    expect(counter.hit('a', 105, 10)).toBe(2);
    expect(counter.hit('b', 105, 10)).toBe(1);
    expect(counter.hit('a', 110, 10)).toBe(2);
    counter.reset('a');
    expect(counter.hit('a', 111, 10)).toBe(1);
  });

  it('stays within its memory bound', () => {
    const counter = new SlidingCounter(3);
    for (const key of ['a', 'b', 'c']) counter.hit(key, 100, 10);
    expect(counter.hit('d', 200, 10)).toBe(1);
    expect(counter.hit('a', 201, 10)).toBe(1);
  });

  it('fires warning and kick once and the ban from its threshold on', () => {
    const thresholds = { warnAt: 3, kickAt: 5, banAt: 7 };
    expect([2, 3, 4, 5, 6, 7, 9].map((count) => spamStep(count, thresholds))).toEqual([
      undefined,
      'warn',
      undefined,
      'kick',
      undefined,
      'ban',
      'ban',
    ]);
    expect(spamStep(50, { warnAt: 0, kickAt: 0, banAt: 0 })).toBeUndefined();
  });

  it('wants rising thresholds, ignoring steps that are off', () => {
    expect(thresholdsAscend({ warnAt: 3, kickAt: 5, banAt: 8 })).toBe(true);
    expect(thresholdsAscend({ warnAt: 0, kickAt: 5, banAt: 0 })).toBe(true);
    expect(thresholdsAscend({ warnAt: 5, kickAt: 5, banAt: 0 })).toBe(false);
    expect(thresholdsAscend({ warnAt: 3, kickAt: 0, banAt: 2 })).toBe(false);
  });
});

describe('English texts (T12.1)', () => {
  const english = {
    enabled: true,
    channelSwitch: { warnMessage: 'Slow down!', reason: 'Spam: hopping' },
  };
  const texts = () => server.moderation.map((m) => [m.command, m.text]);

  it('warns and kicks players by their country', async () => {
    configure({ channelSwitch: switching, english });
    const john = server.join({ uid: 'uid-j', nickname: 'John', country: 'US' });
    const anna = server.join({ uid: 'uid-a', nickname: 'Anna', country: 'AT' });
    await host.idle();
    await hop(john, 5);
    await hop(anna, 3);
    expect(texts()).toEqual([
      ['poke', 'Slow down!'],
      ['kick.server', 'Spam: hopping'],
      ['poke', 'Bitte langsamer: Channel-Wechsel.'],
    ]);
  });

  it('has English defaults for every kind', async () => {
    configure({
      nickname: { enabled: true, windowS: 600, warnAt: 1, kickAt: 0, banAt: 0 },
      english: { enabled: true },
    });
    const john = server.join({ uid: 'uid-j', nickname: 'John', country: 'GB' });
    await host.idle();
    now += 60;
    server.update(john, { nickname: 'Johnny' });
    await poll();
    expect(texts()).toEqual([['poke', 'Please slow down: changing your nickname.']]);
  });

  it('stays German for an unknown country and while English is off', async () => {
    configure({ channelSwitch: switching, english: { ...english, enabled: false } });
    const john = server.join({ uid: 'uid-j', nickname: 'John', country: 'US' });
    await host.idle();
    await hop(john, 3);
    configure({ channelSwitch: switching, english });
    const unknown = server.join({ uid: 'uid-u', nickname: 'Unbekannt', country: undefined });
    await host.idle();
    await hop(unknown, 3);
    expect(texts()).toEqual([
      ['poke', 'Bitte langsamer: Channel-Wechsel.'],
      ['poke', 'Bitte langsamer: Channel-Wechsel.'],
    ]);
  });
});
