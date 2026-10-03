import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import { createSilentLogger } from '../../logging/logger.js';
import { Ts3Connection } from '../../ts3/connection.js';
import { FakeTs3Server } from '../../ts3/fake-transport.js';
import { SessionTracker } from '../../watcher/tracker.js';
import { AutomationHost } from '../host.js';
import { listAutomationLog } from '../log.js';
import { addManaged, listManaged } from '../managed-channels.js';
import { saveModuleSettings } from '../settings.js';
import { ChannelsModule } from './channels.js';

const NOW = 1_789_800_000;
const AREA = 50;

let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let tracker: SessionTracker;
let host: AutomationHost;

const area = { id: 'talk', parentId: AREA, prefix: 'Talk' };

function configure(settings: Record<string, unknown> = {}, areas: unknown[] = [area]): void {
  saveModuleSettings(
    database.db,
    'channels',
    { enabled: true, dryRun: false, areas, ...settings },
    NOW,
  );
}

async function poll(): Promise<void> {
  tracker.sync(await connection.clientList(), NOW);
  await host.idle();
}

/** Names of the channels below the area, in creation order. */
const names = (parent = AREA) =>
  server
    .channelSnapshot()
    .filter((channel) => channel.pid === parent)
    .map((channel) => channel.name);
const cidOf = (name: string) =>
  server.channelSnapshot().find((channel) => channel.name === name)?.cid ?? 0;
const count = (command: string) =>
  server.commandLog.filter((entry) => entry.command === command).length;
const log = () =>
  listAutomationLog(database.sqlite, { limit: 30, offset: 0 })
    .items.map((row) => [row.action, row.result, row.detail])
    .reverse();

beforeEach(async () => {
  database = createTestDatabase();
  server = new FakeTs3Server();
  server.addChannel(AREA, 'Gespräche');
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
    new ChannelsModule({
      database,
      commands: connection,
      logger,
      now: () => NOW,
      online: () => host.online,
      channels: () => connection.channelList(),
    }),
  );
  connection.on('clientConnect', (client) => tracker.join(client, NOW));
  connection.on('clientMoved', (event) => {
    tracker.move(event.clid, event.channelId, NOW, event);
  });
  connection.on('clientDisconnect', (event) => {
    tracker.leave(event.clid, NOW);
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

describe('ChannelsModule', () => {
  it('creates the first free channel and records it as its own', async () => {
    configure();
    await poll();
    expect(names()).toEqual(['Talk 1']);
    expect(listManaged(database.db, 'channels', 'talk').map((e) => e.channelId)).toEqual([
      cidOf('Talk 1'),
    ]);
    expect(log()).toEqual([['channel.create', 'done', 'Talk 1']]);
  });

  it('adds a channel as soon as the free one is entered, without waiting for the poll', async () => {
    configure();
    await poll();
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    await host.idle();
    const before = count('channellist');
    server.move(alice, cidOf('Talk 1'));
    await host.idle();
    expect(names()).toEqual(['Talk 1', 'Talk 2']);
    expect(count('channellist')).toBe(before);
  });

  it('removes the surplus channel when one is left again', async () => {
    configure();
    await poll();
    const alice = server.join({ uid: 'uid-a', nickname: 'Alice' });
    const bob = server.join({ uid: 'uid-b', nickname: 'Bob' });
    await host.idle();
    server.move(alice, cidOf('Talk 1'));
    await host.idle();
    server.move(bob, cidOf('Talk 2'));
    await host.idle();
    expect(names()).toEqual(['Talk 1', 'Talk 2', 'Talk 3']);

    server.move(bob, 1);
    await host.idle();
    expect(names()).toEqual(['Talk 1', 'Talk 2']);
    server.leave(alice);
    await host.idle();
    expect(names()).toEqual(['Talk 1']);
  });

  it('never deletes a channel it did not create', async () => {
    server.addChannel(60, 'Talk 1', AREA);
    server.addChannel(61, 'Besprechung', AREA);
    configure();
    await poll();
    await poll();
    expect(names()).toEqual(['Talk 1', 'Besprechung', 'Talk 2']);
    expect(count('channeldelete')).toBe(0);
  });

  it('takes over adopted channels and tidies them up', async () => {
    server.addChannel(60, 'Talk 1', AREA);
    server.addChannel(61, 'Talk 2', AREA);
    for (const channelId of [60, 61]) {
      addManaged(database.db, { channelId, module: 'channels', scope: 'talk', createdAt: NOW });
    }
    configure();
    await poll();
    expect(names()).toEqual(['Talk 1']);
  });

  it('applies limit, quality, description and powers to new channels', async () => {
    configure({}, [
      { ...area, maxClients: 5, codecQuality: 8, description: 'Hallo', joinPower: 10 },
    ]);
    await poll();
    const cid = cidOf('Talk 1');
    expect(server.channelSnapshot().find((c) => c.cid === cid)).toMatchObject({
      maxClients: 5,
      kind: 'permanent',
    });
    expect(server.channelDetails.get(cid)).toEqual({ description: 'Hallo' });
    expect(server.channelPermissions.get(cid)).toEqual({ i_channel_needed_join_power: 10 });
  });

  it('serves several areas with their own naming', async () => {
    server.addChannel(70, 'Farben');
    configure({}, [area, { id: 'farben', parentId: 70, naming: 'list', names: ['Rot', 'Blau'] }]);
    await poll();
    expect(names()).toEqual(['Talk 1']);
    expect(names(70)).toEqual(['Rot']);
  });

  it('forgets a managed channel somebody deleted and replaces it', async () => {
    configure();
    await poll();
    const first = cidOf('Talk 1');
    server.removeChannel(first);
    await poll();
    expect(names()).toEqual(['Talk 1']);
    expect(listManaged(database.db, 'channels').map((e) => e.channelId)).toEqual([cidOf('Talk 1')]);
    expect(cidOf('Talk 1')).not.toBe(first);
  });

  it('only records its plan in test mode, once per change', async () => {
    configure({ dryRun: true });
    await poll();
    await poll();
    expect(names()).toEqual([]);
    expect(count('channelcreate')).toBe(0);
    expect(log()).toEqual([['channel.create', 'dry', 'Talk 1']]);
  });

  it('skips an area whose parent is gone or whose naming is incomplete', async () => {
    configure({}, [
      { id: 'weg', parentId: 999, prefix: 'Talk' },
      { id: 'leer', parentId: AREA, prefix: '' },
    ]);
    await poll();
    expect(names()).toEqual([]);
    expect(log()).toEqual([]);
  });

  it('reads the channel list once per poll and not at all while switched off', async () => {
    configure({ enabled: false });
    await poll();
    expect(count('channellist')).toBe(0);
    configure();
    await poll();
    await poll();
    expect(count('channellist')).toBe(2);
    expect(count('channelcreate')).toBe(1);
  });
});
