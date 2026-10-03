import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { replaceRanks } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { createSilentLogger } from '../../logging/logger.js';
import { Ts3Connection } from '../../ts3/connection.js';
import { FakeTs3Server } from '../../ts3/fake-transport.js';
import { SessionTracker } from '../../watcher/tracker.js';
import { AutomationHost } from '../host.js';
import { listAutomationLog } from '../log.js';
import { saveModuleSettings } from '../settings.js';
import { getRuleState, RulesModule } from './rules.js';

const RULES = 40;
const ACCEPT = 41;
const MEMBER = 20;

let now: number;
let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let tracker: SessionTracker;
let host: AutomationHost;

function configure(settings: Record<string, unknown> = {}): void {
  saveModuleSettings(
    database.db,
    'rules',
    { enabled: true, dryRun: false, rules: ['Seid freundlich.', 'Kein Spam.'], ...settings },
    now,
  );
}

async function poll(): Promise<void> {
  tracker.sync(await connection.clientList(), now);
  await host.idle();
}

async function join(nickname = 'Alice', extra: Record<string, unknown> = {}): Promise<number> {
  const clid = server.join({ uid: `uid-${nickname}`, nickname, ...extra });
  await host.idle();
  return clid;
}

async function say(clid: number, message: string): Promise<void> {
  server.privateMessage(clid, message);
  await host.idle();
}

const messages = (clid: number) =>
  server.moderation.filter((m) => m.command === 'message' && m.clid === clid).map((m) => m.text);
const state = (clid: number) => {
  const userId = host.get(clid)?.userId;
  return userId === undefined ? undefined : getRuleState(database.db, userId);
};
const logged = () =>
  listAutomationLog(database.sqlite, { limit: 30, offset: 0 })
    .items.map((row) => [row.action, row.result])
    .reverse();

beforeEach(async () => {
  now = 1_789_800_000;
  database = createTestDatabase();
  server = new FakeTs3Server();
  server.addChannel(RULES, 'Regeln');
  server.addChannel(ACCEPT, 'Regeln akzeptieren');
  const logger = createSilentLogger();
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000, initialBackoffMs: 1, maxBackoffMs: 1, jitter: 0 },
    { logger },
  );
  tracker = new SessionTracker(database, logger);
  host = new AutomationHost(logger);
  tracker.addListener(host);
  host.register(new RulesModule({ database, commands: connection, logger, now: () => now }));
  connection.on('clientConnect', (client) => tracker.join(client, now));
  connection.on('clientMoved', (event) => {
    tracker.move(event.clid, event.channelId, now, event);
  });
  connection.on('clientDisconnect', (event) => {
    tracker.leave(event.clid, now);
  });
  connection.on('textMessage', (event) => {
    host.onTextMessage(event, now);
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

describe('sending the rules', () => {
  it('sends every rule and the prompt to who connects', async () => {
    configure();
    const alice = await join();
    expect(messages(alice)).toEqual([
      'Seid freundlich.',
      'Kein Spam.',
      'Antworte mir mit „akzeptieren“, um die Regeln zu bestätigen, oder mit „ablehnen“, um sie abzulehnen.',
    ]);
  });

  it('does not ask again who confirmed the current version', async () => {
    configure();
    const alice = await join();
    await say(alice, 'akzeptieren');
    server.leave(alice);
    now += 3600;
    const again = await join();
    expect(messages(again)).toEqual([]);
  });

  it('asks again after a new version of the rules', async () => {
    configure();
    const alice = await join();
    await say(alice, 'akzeptieren');
    server.leave(alice);
    configure({ version: 2 });
    now += 3600;
    const again = await join();
    expect(messages(again)).toHaveLength(3);
  });

  it('only sends in the rule channel when told so', async () => {
    configure({ trigger: 'channel', ruleChannelId: RULES });
    const alice = await join();
    expect(messages(alice)).toEqual([]);
    server.move(alice, RULES);
    await host.idle();
    expect(messages(alice)).toHaveLength(3);
  });

  it('does not repeat the rules to someone who reconnects within a minute', async () => {
    configure();
    const alice = await join();
    server.leave(alice);
    now += 30;
    const again = await join();
    expect(messages(again)).toEqual([]);
  });

  it('leaves exempt groups and everybody found online at start-up alone', async () => {
    configure({ exemptGroupIds: [6] });
    const admin = await join('Admin', { serverGroups: [6] });
    // Without the join event the next poll finds this client, like after a restart.
    connection.removeAllListeners('clientConnect');
    server.join({ uid: 'uid-late', nickname: 'Schon da' });
    await poll();
    expect(host.online).toHaveLength(2);
    expect(messages(admin)).toEqual([]);
    expect(server.moderation).toEqual([]);
  });

  it('does nothing without rules or while switched off', async () => {
    configure({ rules: [] });
    const alice = await join();
    configure({ enabled: false });
    const bob = await join('Bob');
    expect([...messages(alice), ...messages(bob)]).toEqual([]);
  });
});

describe('deciding by chat', () => {
  it('records the confirmation and gives the group', async () => {
    configure({ acceptedGroupId: MEMBER });
    const alice = await join('Alice', { dbid: 101 });
    await say(alice, '  AKZEPTIEREN ');
    expect(state(alice)).toEqual({ version: 1, decision: 'accepted', at: now });
    expect(server.groupCommands).toEqual([{ command: 'add', dbid: 101, groupId: MEMBER }]);
    expect(messages(alice).at(-1)).toBe(
      'Danke, du hast the Regeln bestätigt.'.replace('the', 'die'),
    );
    expect(logged()).toContainEqual(['rules.accepted', 'done']);
  });

  it('takes the group away from someone who declines later, and kicks if told so', async () => {
    configure({ acceptedGroupId: MEMBER, kickOnDecline: true });
    const alice = await join('Alice', { dbid: 101 });
    await say(alice, 'akzeptieren');
    await poll();
    await say(alice, 'ablehnen');
    expect(server.groupCommands.at(-1)).toEqual({ command: 'remove', dbid: 101, groupId: MEMBER });
    expect(server.clients.has(alice)).toBe(false);
    expect(server.moderation.at(-1)).toMatchObject({
      command: 'kick.server',
      text: 'Regeln nicht bestätigt',
    });
  });

  it('keeps a declining player when kicking is off', async () => {
    configure();
    const alice = await join();
    await say(alice, 'ablehnen');
    expect(state(alice)).toMatchObject({ decision: 'declined' });
    expect(server.clients.has(alice)).toBe(true);
    expect(messages(alice).at(-1)).toBe('Du hast die Regeln abgelehnt.');
  });

  it('ignores other messages and custom commands of other spelling', async () => {
    configure({ acceptCommand: '!ja' });
    const alice = await join();
    await say(alice, 'hallo');
    await say(alice, 'akzeptieren');
    expect(state(alice)).toBeUndefined();
    await say(alice, '!JA');
    expect(state(alice)).toMatchObject({ decision: 'accepted' });
  });

  it('ignores chat commands when only the channel counts', async () => {
    configure({ viaChat: false, viaChannel: true, acceptChannelId: ACCEPT });
    const alice = await join();
    expect(messages(alice)).toEqual(['Seid freundlich.', 'Kein Spam.']);
    await say(alice, 'akzeptieren');
    expect(state(alice)).toBeUndefined();
  });

  it('gives the group to someone who confirmed earlier but lacks it', async () => {
    configure();
    const alice = await join('Alice', { dbid: 101 });
    await say(alice, 'akzeptieren');
    server.leave(alice);
    configure({ acceptedGroupId: MEMBER });
    now += 3600;
    await join('Alice', { dbid: 101 });
    expect(server.groupCommands).toEqual([{ command: 'add', dbid: 101, groupId: MEMBER }]);
  });

  it('refuses a group that belongs to the rank ladder', async () => {
    replaceRanks(
      database.sqlite,
      [{ name: 'Neuling', requiredS: 3600, serverGroupId: MEMBER }],
      now,
    );
    configure({ acceptedGroupId: MEMBER });
    const alice = await join();
    await say(alice, 'akzeptieren');
    expect(server.groupCommands).toEqual([]);
  });
});

describe('deciding by channel', () => {
  it('counts entering the channel as confirmation and sends the player back', async () => {
    configure({ viaChannel: true, acceptChannelId: ACCEPT });
    const alice = await join();
    server.move(alice, RULES);
    await host.idle();
    server.move(alice, ACCEPT);
    await host.idle();
    expect(state(alice)).toMatchObject({ decision: 'accepted' });
    expect(server.clients.get(alice)?.channelId).toBe(RULES);
  });

  it('can send the player to a fixed channel instead', async () => {
    configure({ viaChannel: true, acceptChannelId: ACCEPT, returnChannelId: 1 });
    const alice = await join();
    server.move(alice, RULES);
    await host.idle();
    server.move(alice, ACCEPT);
    await host.idle();
    expect(server.clients.get(alice)?.channelId).toBe(1);
  });
});

describe('deadline and test mode', () => {
  it('kicks who has not decided when the deadline is over', async () => {
    configure({ deadlineS: 120 });
    const slow = await join('Langsam');
    const quick = await join('Schnell');
    await say(quick, 'akzeptieren');
    now += 119;
    await poll();
    expect(server.clients.has(slow)).toBe(true);
    now += 1;
    await poll();
    expect(server.clients.has(slow)).toBe(false);
    expect(server.clients.has(quick)).toBe(true);
  });

  it('sends and records nothing for real in test mode', async () => {
    configure({ dryRun: true, viaChannel: true, acceptChannelId: ACCEPT });
    const alice = await join();
    await say(alice, 'akzeptieren');
    server.move(alice, ACCEPT);
    await host.idle();
    expect(server.moderation).toEqual([]);
    expect(state(alice)).toBeUndefined();
    expect(logged()).toEqual([
      ['rules.send', 'dry'],
      ['rules.accepted', 'dry'],
      ['move', 'dry'],
    ]);
  });
});
