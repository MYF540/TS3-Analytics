import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import { createSilentLogger } from '../../logging/logger.js';
import { Ts3Connection } from '../../ts3/connection.js';
import { FakeTs3Server } from '../../ts3/fake-transport.js';
import { loadGroupWatch, saveGroupWatch } from '../../watcher/group-settings.js';
import { loadActivitySettings, saveActivitySettings } from '../../watcher/settings.js';
import { SessionTracker } from '../../watcher/tracker.js';
import { AutomationHost } from '../host.js';
import { listAutomationLog } from '../log.js';
import { saveModuleSettings } from '../settings.js';
import { StaffModule } from './staff.js';

const BOARD = 20;
const AFK = 9;
const ADMIN = 6;
const MOD = 7;

let now: number;
let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let tracker: SessionTracker;
let host: AutomationHost;
let module: StaffModule;

const plain = {
  enabled: true,
  dryRun: false,
  channelId: BOARD,
  groups: [{ groupId: ADMIN }, { groupId: MOD, title: 'Moderation' }],
  online: 'online',
  away: 'abwesend',
  offline: 'offline',
  empty: 'niemand',
  clickable: false,
};

function configure(settings: Record<string, unknown> = {}): void {
  saveModuleSettings(database.db, 'staff', { ...plain, ...settings }, now);
}

async function poll(): Promise<void> {
  tracker.sync(await connection.clientList(), now);
  await host.idle();
}

const description = () => server.channelDetails.get(BOARD)?.description;
const commands = (name: string) =>
  server.commandLog.filter((entry) => entry.command === name).length;

beforeEach(async () => {
  now = 1_789_800_000;
  database = createTestDatabase();
  server = new FakeTs3Server();
  server.addChannel(BOARD, 'Team');
  server.addChannel(AFK, 'AFK');
  server.groupMembers.set(ADMIN, [
    { dbid: 101, uid: 'uid-bob', nickname: 'Bob' },
    { dbid: 102, uid: 'uid-zoe', nickname: 'Zoe' },
  ]);
  server.groupMembers.set(MOD, [{ dbid: 103, uid: 'uid-cleo', nickname: 'Cleo' }]);
  const logger = createSilentLogger();
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000, initialBackoffMs: 1, maxBackoffMs: 1, jitter: 0 },
    { logger },
  );
  tracker = new SessionTracker(database, logger);
  host = new AutomationHost(logger);
  tracker.addListener(host);
  module = new StaffModule({
    database,
    commands: connection,
    logger,
    now: () => now,
    online: () => host.online,
    members: (groupId) => connection.serverGroupMembers(groupId),
  });
  host.register(module);
  connection.on('clientConnect', (client) => tracker.join(client, now));
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
  saveGroupWatch(
    database.db,
    { ...loadGroupWatch(database.db), knownGroups: [{ id: ADMIN, name: 'Server Admin' }] },
    now,
  );
});

afterEach(async () => {
  await connection.stop();
  database.close();
});

describe('StaffModule', () => {
  it('writes the list with everybody offline', async () => {
    configure();
    await poll();
    expect(description()).toBe(
      [
        '[b]Server Admin[/b]',
        'Bob – offline',
        'Zoe – offline',
        '',
        '[b]Moderation[/b]',
        'Cleo – offline',
      ].join('\n'),
    );
  });

  it('shows who is online and who sits in an AFK channel', async () => {
    configure();
    server.join({ uid: 'uid-zoe', nickname: 'Zoe', serverGroups: [ADMIN] });
    server.join({ uid: 'uid-cleo', nickname: 'Cleo', serverGroups: [MOD], channelId: AFK });
    await poll();
    expect(description()).toContain('Zoe – online\nBob – offline');
    expect(description()).toContain('Cleo – abwesend');
  });

  it('uses the nickname someone is online with, and lists a member the server list lacks', async () => {
    configure();
    server.join({ uid: 'uid-bob', nickname: 'Bobby', serverGroups: [ADMIN] });
    server.join({ uid: 'uid-new', nickname: 'Neu', serverGroups: [MOD] });
    await poll();
    expect(description()).toContain('Bobby – online');
    expect(description()).toContain('Neu – online');
  });

  it('lists a member of two groups only in the first, unless told otherwise', async () => {
    server.groupMembers.set(MOD, [
      { dbid: 101, uid: 'uid-bob', nickname: 'Bob' },
      { dbid: 103, uid: 'uid-cleo', nickname: 'Cleo' },
    ]);
    configure();
    await poll();
    expect(description()?.match(/Bob/g)).toHaveLength(1);

    configure({ showInAll: true });
    now += 60;
    await poll();
    expect(description()?.match(/Bob/g)).toHaveLength(2);
  });

  it('writes nothing while the text stays the same', async () => {
    configure();
    await poll();
    now += 60;
    await poll();
    now += 60;
    await poll();
    expect(commands('channeledit')).toBe(1);
  });

  it('fetches the member lists only every five minutes', async () => {
    configure();
    await poll();
    now += 120;
    await poll();
    expect(commands('servergroupclientlist')).toBe(2);
    now += 200;
    await poll();
    expect(commands('servergroupclientlist')).toBe(4);
  });

  it('waits 30 seconds between two writes', async () => {
    configure();
    await poll();
    const zoe = server.join({ uid: 'uid-zoe', nickname: 'Zoe', serverGroups: [ADMIN] });
    await host.idle();
    expect(description()).toContain('Zoe – offline');
    expect(commands('channeledit')).toBe(1);

    now += 30;
    server.leave(zoe);
    server.join({ uid: 'uid-zoe', nickname: 'Zoe', serverGroups: [ADMIN] });
    await host.idle();
    expect(description()).toContain('Zoe – online');
    expect(commands('channeledit')).toBe(2);
  });

  it('only records the update in test mode, once per change', async () => {
    configure({ dryRun: true });
    await poll();
    now += 60;
    await poll();
    expect(description()).toBeUndefined();
    expect(commands('channeledit')).toBe(0);
    const { items } = listAutomationLog(database.sqlite, { limit: 10, offset: 0 });
    expect(items.map((row) => [row.action, row.result])).toEqual([['staff.update', 'dry']]);
  });

  it('does nothing while switched off or without a channel', async () => {
    configure({ enabled: false });
    await poll();
    configure({ channelId: null });
    await poll();
    expect(commands('channeledit')).toBe(0);
    expect(commands('servergroupclientlist')).toBe(0);
  });
});
