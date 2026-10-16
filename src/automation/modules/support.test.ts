import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { getChannelName, upsertChannels } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { availableSupporters, Cooldown, fillTemplate } from '../../domain/support.js';
import { createSilentLogger } from '../../logging/logger.js';
import { Ts3Connection } from '../../ts3/connection.js';
import { FakeTs3Server } from '../../ts3/fake-transport.js';
import { loadActivitySettings, saveActivitySettings } from '../../watcher/settings.js';
import { SessionTracker } from '../../watcher/tracker.js';
import { AutomationHost } from '../host.js';
import { listAutomationLog } from '../log.js';
import { saveModuleSettings } from '../settings.js';
import { SupportModule } from './support.js';

const SUPPORT = 20;
const AFK = 9;
const TEAM = 6;

let now: number;
let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let tracker: SessionTracker;
let host: AutomationHost;
const notify = vi.fn();

function configure(settings: Record<string, unknown> = {}): void {
  saveModuleSettings(
    database.db,
    'support',
    { enabled: true, dryRun: false, channelId: SUPPORT, supporterGroupIds: [TEAM], ...settings },
    now,
  );
}

async function idle(): Promise<void> {
  await host.idle();
}

/** A poll: lets tracker and modules see the current client list. */
async function poll(): Promise<void> {
  const [channels, clients] = await Promise.all([
    connection.channelList(),
    connection.clientList(),
  ]);
  upsertChannels(
    database.db,
    channels.map((c) => ({ id: c.cid, name: c.name, seenAt: now })),
  );
  tracker.sync(clients, now);
  await idle();
}

const supporter = (nickname = 'Mod', channelId = 1) =>
  server.join({ uid: `uid-${nickname}`, nickname, serverGroups: [TEAM], channelId });
const player = (nickname = 'Alice') => server.join({ uid: `uid-${nickname}`, nickname });

const sent = () => server.moderation.map((m) => [m.command, m.clid, m.text]);
const channel = () => server.channelSnapshot().find((c) => c.cid === SUPPORT);
const log = () =>
  listAutomationLog(database.sqlite, { limit: 20, offset: 0 })
    .items.map((row) => [row.action, row.result, row.detail])
    .reverse();

beforeEach(async () => {
  now = 1_789_800_000;
  notify.mockReset();
  database = createTestDatabase();
  server = new FakeTs3Server();
  server.addChannel(SUPPORT, 'Support');
  server.addChannel(AFK, 'AFK');
  const logger = createSilentLogger();
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000, initialBackoffMs: 1, maxBackoffMs: 1, jitter: 0 },
    { logger },
  );
  tracker = new SessionTracker(database, logger);
  host = new AutomationHost(logger);
  tracker.addListener(host);
  host.register(
    new SupportModule({
      database,
      commands: connection,
      logger,
      now: () => now,
      online: () => host.online,
      notifier: { notify },
    }),
  );
  connection.on('clientConnect', (client) => tracker.join(client, now));
  connection.on('clientMoved', (event) => {
    tracker.move(event.clid, event.channelId, now, event);
  });
  connection.on('clientDisconnect', (event) => {
    tracker.leave(event.clid, now);
  });
  connection.start();
  await vi.waitFor(() => {
    expect(connection.isConnected).toBe(true);
  });
  saveActivitySettings(
    database.db,
    { ...loadActivitySettings(database.db), afkChannelIds: [AFK] },
    now,
  );
  await poll();
});

afterEach(async () => {
  await connection.stop();
  database.close();
});

describe('support request', () => {
  it('greets the player and pokes every available supporter', async () => {
    configure();
    const mod = supporter('Mod');
    const away = supporter('Schläfer', AFK);
    const alice = player('Alice');
    await idle();
    server.move(alice, SUPPORT);
    await idle();

    expect(sent()).toEqual([
      ['message', alice, 'Hallo Alice, das Team wurde informiert und kümmert sich gleich um dich.'],
      ['poke', mod, 'Alice wartet im Support.'],
    ]);
    expect(sent().some(([, clid]) => clid === away)).toBe(false);
    expect(notify).toHaveBeenCalledWith('support.request', expect.stringContaining('Alice'));
  });

  it('tells the player when nobody is there', async () => {
    configure({ nobodyMessage: 'Sorry {name}, keiner da.' });
    const alice = player('Alice');
    await idle();
    server.move(alice, SUPPORT);
    await idle();
    expect(sent()).toEqual([['message', alice, 'Sorry Alice, keiner da.']]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('can message the team instead of poking', async () => {
    configure({ notify: 'message', supporterMessage: 'Hilfe für {name}' });
    const mod = supporter();
    const alice = player();
    await idle();
    server.move(alice, SUPPORT);
    await idle();
    expect(sent()[1]).toEqual(['message', mod, 'Hilfe für Alice']);
  });

  it('ignores team members, exempt groups and other channels', async () => {
    configure({ exemptGroupIds: [30] });
    const mod = supporter();
    const bot = server.join({ uid: 'uid-bot', nickname: 'Musik', serverGroups: [30] });
    const alice = player();
    await idle();
    server.move(mod, SUPPORT);
    server.move(bot, SUPPORT);
    server.move(alice, AFK);
    await idle();
    expect(sent()).toEqual([]);
  });

  it('does not notify again while the player is cooling down', async () => {
    configure({ cooldownS: 60 });
    supporter();
    const alice = player();
    await idle();
    server.move(alice, SUPPORT);
    await idle();
    server.move(alice, 1);
    now += 30;
    server.move(alice, SUPPORT);
    await idle();
    expect(sent()).toHaveLength(2);

    server.move(alice, 1);
    now += 31;
    server.move(alice, SUPPORT);
    await idle();
    expect(sent()).toHaveLength(4);
  });

  it('handles someone who connects straight into the channel', async () => {
    configure();
    const mod = supporter();
    await idle();
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice', channelId: SUPPORT });
    await idle();
    expect(sent().map(([command, clid]) => [command, clid])).toEqual([
      ['message', alice],
      ['poke', mod],
    ]);
  });

  it('only records the request in test mode', async () => {
    configure({ dryRun: true });
    supporter();
    const alice = player();
    await idle();
    server.move(alice, SUPPORT);
    await idle();
    expect(sent()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(log()).toEqual([
      ['message', 'dry', null],
      ['poke', 'dry', 'Anfrage von „Alice“'],
    ]);
  });

  it('defuses BBCode in the nickname', async () => {
    configure();
    const mod = supporter();
    const alice = player('[url=x]Klick');
    await idle();
    server.move(alice, SUPPORT);
    await idle();
    expect(sent()[1]).toEqual(['poke', mod, '\\[url=x]Klick wartet im Support.']);
  });
});

describe('opening and closing the channel', () => {
  const autoOpen = { enabled: true, openName: 'Support [offen]', closedName: 'Support [zu]' };
  const edits = () => server.commandLog.filter((entry) => entry.command === 'channeledit').length;

  it('closes the channel while nobody is available and opens it again', async () => {
    configure({ autoOpen });
    await poll();
    expect(channel()).toMatchObject({ name: 'Support [zu]', maxClients: 0 });

    const mod = supporter();
    await idle();
    expect(channel()).toMatchObject({ name: 'Support [offen]', maxClients: -1 });
    expect(getChannelName(database.db, SUPPORT)).toBe('Support [offen]');

    server.move(mod, AFK);
    await idle();
    expect(channel()).toMatchObject({ name: 'Support [zu]', maxClients: 0 });

    server.move(mod, 1);
    await idle();
    server.leave(mod);
    await idle();
    expect(channel()).toMatchObject({ name: 'Support [zu]', maxClients: 0 });
    expect(log().map(([action]) => action)).toEqual([
      'support.close',
      'support.open',
      'support.close',
      'support.open',
      'support.close',
    ]);
  });

  it('sends nothing while the state stays the same', async () => {
    configure({ autoOpen });
    supporter('Mod');
    await poll();
    const before = edits();
    supporter('Admin');
    player('Alice');
    await poll();
    await poll();
    expect(edits()).toBe(before);
  });

  it('notices a supporter who got the group while online', async () => {
    configure({ autoOpen });
    const clid = player('Neu');
    await poll();
    expect(channel()?.name).toBe('Support [zu]');
    server.update(clid, { serverGroups: [TEAM] });
    await poll();
    expect(channel()?.name).toBe('Support [offen]');
  });

  it('does not rename a channel that already has the right name', async () => {
    server.addChannel(SUPPORT, 'Support [zu]');
    configure({ autoOpen });
    await poll();
    expect(log()).toEqual([['support.close', 'done', 'Support [zu]']]);
    expect(channel()).toMatchObject({ name: 'Support [zu]', maxClients: 0 });
  });

  it('leaves the channel alone in test mode and when the option is off', async () => {
    configure({ autoOpen, dryRun: true });
    await poll();
    expect(channel()).toMatchObject({ name: 'Support', maxClients: -1 });
    expect(log()).toEqual([['support.close', 'dry', 'Support [zu]']]);

    configure({ autoOpen: { ...autoOpen, enabled: false } });
    await poll();
    expect(edits()).toBe(0);
  });
});

describe('support rules', () => {
  it('counts supporters outside AFK channels', () => {
    const clients = [
      { clid: 1, channelId: 1, serverGroups: [TEAM] },
      { clid: 2, channelId: AFK, serverGroups: [TEAM] },
      { clid: 3, channelId: 1, serverGroups: [8] },
    ];
    const options = { supporterGroupIds: [TEAM], afkChannelIds: [AFK] };
    expect(availableSupporters(clients, options).map((c) => c.clid)).toEqual([1]);
  });

  it('fills every placeholder', () => {
    expect(fillTemplate('{name}, hallo {name}!', { name: 'Bob' })).toBe('Bob, hallo Bob!');
  });

  it('lets a key act again once the cooldown is over', () => {
    const cooldown = new Cooldown();
    expect(cooldown.allow(1, 100, 60)).toBe(true);
    expect(cooldown.allow(1, 159, 60)).toBe(false);
    expect(cooldown.allow(2, 159, 60)).toBe(true);
    expect(cooldown.allow(1, 160, 60)).toBe(true);
  });
});

describe('English texts (T12.1)', () => {
  const english = { enabled: true, userMessage: 'Hi {name}, help is on the way.' };
  const visitor = (nickname: string, country: string | undefined) =>
    server.join({ uid: `uid-${nickname}`, nickname, country });

  it('greets players from outside the German-speaking countries in English', async () => {
    configure({ english });
    const mod = supporter('Mod');
    const john = visitor('John', 'US');
    const anna = visitor('Anna', 'AT');
    await idle();
    server.move(john, SUPPORT);
    await idle();
    server.move(anna, SUPPORT);
    await idle();
    expect(sent()).toEqual([
      ['message', john, 'Hi John, help is on the way.'],
      // The team is always told in German.
      ['poke', mod, 'John wartet im Support.'],
      ['message', anna, 'Hallo Anna, das Team wurde informiert und kümmert sich gleich um dich.'],
      ['poke', mod, 'Anna wartet im Support.'],
    ]);
  });

  it('uses the English default when nobody is there', async () => {
    configure({ english });
    const john = visitor('John', 'GB');
    await idle();
    server.move(john, SUPPORT);
    await idle();
    expect(sent()).toEqual([
      ['message', john, 'Hello John, unfortunately nobody from the team is available right now.'],
    ]);
  });

  it('stays German for an unknown country and while English is off', async () => {
    configure({ english });
    const unknown = visitor('Unbekannt', undefined);
    await idle();
    server.move(unknown, SUPPORT);
    await idle();
    configure();
    const john = visitor('John', 'US');
    await idle();
    server.move(john, SUPPORT);
    await idle();
    expect(sent().map(([, , text]) => text)).toEqual([
      'Hallo Unbekannt, im Moment ist leider niemand vom Team erreichbar.',
      'Hallo John, im Moment ist leider niemand vom Team erreichbar.',
    ]);
  });
});
