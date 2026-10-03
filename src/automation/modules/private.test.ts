import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import { createSilentLogger } from '../../logging/logger.js';
import { Ts3Connection } from '../../ts3/connection.js';
import { FakeTs3Server } from '../../ts3/fake-transport.js';
import { SessionTracker } from '../../watcher/tracker.js';
import { AutomationHost } from '../host.js';
import { listAutomationLog } from '../log.js';
import { listManaged } from '../managed-channels.js';
import { saveModuleSettings } from '../settings.js';
import { generatePassword, privateChannelName, PrivateModule } from './private.js';

const LOBBY = 30;
const PARENT = 31;

let now: number;
let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let tracker: SessionTracker;
let host: AutomationHost;

const lobby = { id: 'main', lobbyChannelId: LOBBY, parentId: PARENT, channelGroupId: 5 };

function configure(settings: Record<string, unknown> = {}, lobbyChanges = {}): void {
  saveModuleSettings(
    database.db,
    'private',
    { enabled: true, dryRun: false, lobbies: [{ ...lobby, ...lobbyChanges }], ...settings },
    now,
  );
}

async function poll(): Promise<void> {
  tracker.sync(await connection.clientList(), now);
  await host.idle();
}

async function enter(clid: number): Promise<void> {
  server.move(clid, LOBBY);
  await host.idle();
}

const rooms = () => server.channelSnapshot().filter((channel) => channel.pid === PARENT);
const channelOf = (clid: number) => server.clients.get(clid)?.channelId;
const messages = (clid: number) =>
  server.moderation.filter((m) => m.command === 'message' && m.clid === clid).map((m) => m.text);
const log = () =>
  listAutomationLog(database.sqlite, { limit: 30, offset: 0 })
    .items.map((row) => [row.action, row.result, row.detail])
    .reverse();

beforeEach(async () => {
  now = 1_789_800_000;
  database = createTestDatabase();
  server = new FakeTs3Server();
  server.addChannel(LOBBY, 'Aufzug');
  server.addChannel(PARENT, 'Privaträume');
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
    new PrivateModule({
      database,
      commands: connection,
      logger,
      now: () => now,
      channels: () => connection.channelList(),
      password: () => 'geheim42',
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
});

afterEach(async () => {
  await connection.stop();
  database.close();
});

describe('PrivateModule', () => {
  it('creates a channel, moves the player in and makes them its admin', async () => {
    configure();
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice', dbid: 101 });
    await host.idle();
    await enter(alice);

    const [room] = rooms();
    expect(room).toMatchObject({ name: 'Privater Raum von Alice', kind: 'temporary' });
    expect(channelOf(alice)).toBe(room?.cid);
    expect(server.channelGroupAssignments).toEqual([{ dbid: 101, cid: room?.cid, groupId: 5 }]);
    expect(server.channelDetails.get(room?.cid ?? 0)).toEqual({ deleteDelayS: 300 });
    expect(messages(alice)).toEqual(['Dein privater Channel wurde angelegt.']);
    // The bot was pulled into the temporary channel and went back.
    expect(server.botChannelId).toBe(1);
    expect(listManaged(database.db, 'private', 'main')).toMatchObject([
      { channelId: room?.cid, ownerUserId: host.get(alice)?.userId },
    ]);
  });

  it('brings the player back to the channel they already have', async () => {
    configure();
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await enter(alice);
    server.move(alice, 1);
    await host.idle();
    await enter(alice);

    expect(rooms()).toHaveLength(1);
    expect(channelOf(alice)).toBe(rooms()[0]?.cid);
    expect(messages(alice).at(-1)).toBe('Willkommen zurück in deinem privaten Channel.');
  });

  it('creates a new channel when the old one is gone', async () => {
    configure({ cooldownS: 0 }, { deleteDelayS: 0 });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await enter(alice);
    const first = rooms()[0]?.cid;
    server.move(alice, 1);
    await host.idle();
    expect(rooms()).toEqual([]);

    await enter(alice);
    expect(rooms()).toHaveLength(1);
    expect(rooms()[0]?.cid).not.toBe(first);
    expect(listManaged(database.db, 'private')).toHaveLength(1);
  });

  it('forgets vanished channels on the next poll', async () => {
    configure({}, { deleteDelayS: 0 });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await enter(alice);
    server.leave(alice);
    await poll();
    expect(listManaged(database.db, 'private')).toEqual([]);
  });

  it('makes a player wait before another channel is created', async () => {
    configure({ cooldownS: 60 }, { deleteDelayS: 0 });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await enter(alice);
    server.move(alice, 1);
    await host.idle();
    now += 30;
    await enter(alice);
    expect(rooms()).toEqual([]);
    expect(channelOf(alice)).toBe(LOBBY);

    server.move(alice, 1);
    now += 31;
    await enter(alice);
    expect(rooms()).toHaveLength(1);
  });

  it('sends away players without one of the allowed groups', async () => {
    configure({}, { allowedGroupIds: [20] });
    const guest = server.join({ uid: 'uid-g', nickname: 'Gast' });
    const member = server.join({ uid: 'uid-m', nickname: 'Mitglied', serverGroups: [20] });
    await host.idle();
    await enter(guest);
    await enter(member);
    expect(rooms().map((room) => room.name)).toEqual(['Privater Raum von Mitglied']);
    expect(channelOf(guest)).toBe(1);
    expect(messages(guest)).toEqual(['Du kannst hier keinen privaten Channel bekommen.']);
  });

  it('protects the channel with a password and tells only the owner', async () => {
    configure({}, { password: true });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await enter(alice);
    expect(rooms()[0]?.hasPassword).toBe(true);
    expect(messages(alice).at(-1)).toBe('Das Passwort deines Channels lautet: geheim42');
    expect(JSON.stringify(log())).not.toContain('geheim42');
  });

  it('numbers the name when two players share a nickname', async () => {
    configure();
    const one = server.join({ uid: 'uid-1', nickname: 'Alex' });
    const two = server.join({ uid: 'uid-2', nickname: 'Alex' });
    await host.idle();
    await enter(one);
    await enter(two);
    expect(rooms().map((room) => room.name)).toEqual([
      'Privater Raum von Alex',
      'Privater Raum von Alex (2)',
    ]);
  });

  it('keeps permanent channels without moving the bot', async () => {
    configure({}, { kind: 'permanent' });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    const before = server.commandLog.filter((entry) => entry.command === 'whoami').length;
    await enter(alice);
    expect(rooms()[0]?.kind).toBe('permanent');
    expect(server.commandLog.filter((entry) => entry.command === 'whoami')).toHaveLength(before);
  });

  it('only records the request in test mode', async () => {
    configure({ dryRun: true });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await enter(alice);
    expect(rooms()).toEqual([]);
    expect(channelOf(alice)).toBe(LOBBY);
    expect(log()).toEqual([['private.create', 'dry', 'Privater Raum von Alice']]);
  });

  it('ignores exempt groups, other channels and a switched-off module', async () => {
    configure({ exemptGroupIds: [30] });
    const bot = server.join({ uid: 'uid-b', nickname: 'Musik', serverGroups: [30] });
    await host.idle();
    await enter(bot);
    configure({ enabled: false });
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    await enter(alice);
    expect(rooms()).toEqual([]);
  });
});

describe('private channel helpers', () => {
  it('builds a name within the server limit', () => {
    expect(privateChannelName('Raum von {name}', 'Bob', 0)).toBe('Raum von Bob');
    expect(privateChannelName('Raum von {name}', 'x'.repeat(60), 1)).toHaveLength(40);
    expect(privateChannelName('Raum von {name}', 'x'.repeat(60), 1).endsWith(' (2)')).toBe(true);
  });

  it('generates passwords without confusable characters', () => {
    const password = generatePassword(40);
    expect(password).toHaveLength(40);
    expect(password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]+$/);
  });
});
