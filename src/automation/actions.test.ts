import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { recordNickname, replaceRanks, upsertUser } from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import { createSilentLogger } from '../logging/logger.js';
import { Ts3Connection } from '../ts3/connection.js';
import { FakeTs3Server } from '../ts3/fake-transport.js';
import {
  ForeignGroupError,
  ModuleActions,
  type ActionScope,
  type ActionTarget,
} from './actions.js';
import { listAutomationLog, pruneAutomationLog, writeAutomationLog } from './log.js';

const NOW = 1_789_800_000;
const DAY = 86_400;

let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let target: ActionTarget;

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function actions(scope: Partial<ActionScope> = {}): ModuleActions {
  return new ModuleActions(
    { database, commands: connection, logger: createSilentLogger(), now: () => NOW },
    { module: 'nickname', dryRun: false, ...scope },
  );
}

const log = () =>
  listAutomationLog(database.sqlite, { limit: 50, offset: 0 }).items.map((row) => ({
    action: row.action,
    userId: row.userId,
    detail: row.detail,
    result: row.result,
  }));

/** Query commands the server received, without the connection set-up. */
const commands = () =>
  server.commandLog.map((entry) => entry.command).filter((c) => c !== 'connect');

beforeEach(async () => {
  database = createTestDatabase();
  server = new FakeTs3Server();
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000, initialBackoffMs: 1, maxBackoffMs: 1, jitter: 0 },
    { logger: createSilentLogger() },
  );
  connection.start();
  await settle();
  const userId = upsertUser(database.db, { uid: 'uid-a', seenAt: NOW, dbid: 101 });
  const clid = server.join({ uid: 'uid-a', nickname: 'Alice', dbid: 101 });
  target = { clid, userId, dbid: 101 };
});

afterEach(async () => {
  await connection.stop();
  database.close();
});

describe('ModuleActions', () => {
  it('sends the command and records it', async () => {
    expect(await actions().kick(target, 'Bitte anderen Namen wählen')).toBe(true);
    expect(server.moderation).toEqual([
      { command: 'kick.server', clid: target.clid, text: 'Bitte anderen Namen wählen' },
    ]);
    expect(log()).toEqual([
      {
        action: 'kick',
        userId: target.userId,
        detail: 'Bitte anderen Namen wählen',
        result: 'done',
      },
    ]);
  });

  it('sends nothing in test mode, but records what would have happened', async () => {
    const dry = actions({ dryRun: true, ownGroupIds: [20] });
    expect(await dry.message(target, 'Hallo')).toBe(false);
    expect(await dry.poke(target, 'Hallo')).toBe(false);
    expect(await dry.kick(target, 'raus')).toBe(false);
    expect(await dry.ban(target, 600, 'Spam')).toBe(false);
    expect(await dry.move(target, 1)).toBe(false);
    expect(await dry.addGroup(target, 20)).toBe(false);

    expect(commands()).toEqual([]);
    expect(server.clients.has(target.clid)).toBe(true);
    expect(log().map((row) => [row.action, row.result])).toEqual([
      ['group.add', 'dry'],
      ['move', 'dry'],
      ['ban', 'dry'],
      ['kick', 'dry'],
      ['poke', 'dry'],
      ['message', 'dry'],
    ]);
  });

  it('cuts texts to what the server accepts', async () => {
    const live = actions();
    await live.poke(target, 'x'.repeat(300));
    await live.message(target, 'y'.repeat(2000));
    await live.kick(target, 'z'.repeat(100));
    expect(server.moderation.map((entry) => entry.text?.length)).toEqual([100, 1024, 40]);
  });

  it('only changes server groups of its own configuration', async () => {
    const live = actions({ ownGroupIds: [20] });
    await live.addGroup(target, 20);
    await live.removeGroup(target, 20);
    expect(server.groupCommands).toEqual([
      { command: 'add', dbid: 101, groupId: 20 },
      { command: 'remove', dbid: 101, groupId: 20 },
    ]);
    expect(() => live.addGroup(target, 6)).toThrow(ForeignGroupError);
    expect(() => actions().addGroup(target, 20)).toThrow(ForeignGroupError);
    expect(server.groupCommands).toHaveLength(2);
  });

  it('never touches a group of the rank ladder, even when configured (rule 6)', () => {
    replaceRanks(database.sqlite, [{ name: 'Neuling', requiredS: 3600, serverGroupId: 20 }], NOW);
    const live = actions({ ownGroupIds: [20] });
    expect(() => live.addGroup(target, 20)).toThrow(ForeignGroupError);
    expect(() => live.removeGroup(target, 20)).toThrow(ForeignGroupError);
    // Test mode is no excuse either: the configuration is wrong.
    expect(() => actions({ dryRun: true, ownGroupIds: [20] }).addGroup(target, 20)).toThrow(
      ForeignGroupError,
    );
    expect(server.groupCommands).toEqual([]);
  });

  it('refuses a ban without an end', () => {
    expect(() => actions().ban(target, 0, 'Spam')).toThrow(RangeError);
    expect(server.bans).toEqual([]);
  });

  it('records a failed command instead of throwing', async () => {
    server.leave(target.clid);
    expect(await actions().kick(target, 'raus')).toBe(false);
    expect(log()).toEqual([
      {
        action: 'kick',
        userId: target.userId,
        detail: 'raus – invalid clientID (fake)',
        result: 'failed',
      },
    ]);
  });

  it('keeps IP addresses out of the log when an error message contains one', async () => {
    const failing = actions().run('custom', target, undefined, () =>
      Promise.reject(new Error('refused by 203.0.113.7')),
    );
    expect(await failing).toBe(false);
    expect(log()[0]?.detail).toBe('refused by [IP]');
  });
});

describe('automation log', () => {
  it('lists the newest entries first, filtered by module, with the nickname', () => {
    recordNickname(database.db, target.userId, 'Alice', NOW);
    const entry = { userId: target.userId, result: 'done' } as const;
    writeAutomationLog(database.db, { ...entry, at: NOW - 20, module: 'nickname', action: 'kick' });
    writeAutomationLog(database.db, { ...entry, at: NOW - 10, module: 'spam', action: 'poke' });
    writeAutomationLog(database.db, { at: NOW, module: 'channels', action: 'x', result: 'dry' });

    const all = listAutomationLog(database.sqlite, { limit: 2, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.items.map((row) => [row.module, row.nickname])).toEqual([
      ['channels', null],
      ['spam', 'Alice'],
    ]);
    const spam = listAutomationLog(database.sqlite, { module: 'spam', limit: 10, offset: 0 });
    expect(spam).toMatchObject({ total: 1, items: [{ action: 'poke' }] });
  });

  it('cuts overlong details and forgets entries after 90 days', () => {
    const base = { module: 'spam', action: 'poke', result: 'done' } as const;
    writeAutomationLog(database.db, { ...base, at: NOW - 91 * DAY });
    writeAutomationLog(database.db, { ...base, at: NOW - 89 * DAY, detail: 'x'.repeat(500) });
    expect(pruneAutomationLog(database.sqlite, NOW)).toBe(1);
    const { items } = listAutomationLog(database.sqlite, { limit: 10, offset: 0 });
    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toHaveLength(300);
  });
});
