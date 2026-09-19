import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { recordNickname, replaceRanks, upsertUser, type Rank } from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import { createSilentLogger } from '../logging/logger.js';
import { Ts3Connection } from '../ts3/connection.js';
import { FakeTs3Server } from '../ts3/fake-transport.js';
import type { Ts3Client } from '../ts3/types.js';
import { RankJob } from './job.js';
import { saveRankSettings } from './settings.js';

const H = 3600;
const NOW = 1_789_800_000;

let database: AppDatabase;
let server: FakeTs3Server;
let connection: Ts3Connection;
let job: RankJob;
let ladder: Rank[];
const notify = vi.fn();

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** A known player with ranking time; `online` connects them with the given groups. */
function player(uid: string, dbid: number, hours: number, groups?: number[]): number {
  const id = upsertUser(database.db, { uid, seenAt: NOW - 86_400, dbid, serverGroups: groups });
  recordNickname(database.db, id, uid.replace('=', ''), NOW - 86_400);
  database.sqlite
    .prepare(
      `INSERT INTO user_daily_stats (user_id, day, online_s, active_s, idle_s, afk_s, unknown_s,
         sessions, longest_session_s) VALUES (?, 20260901, ?, 0, 0, 0, 0, 1, 0)`,
    )
    .run(id, hours * H);
  return id;
}

function online(uid: string, dbid: number, groups: number[]): number {
  return server.join({ uid, nickname: uid.replace('=', ''), dbid, serverGroups: groups });
}

function history() {
  return database.sqlite
    .prepare(
      'SELECT user_id AS userId, from_rank_id AS fromRankId, to_rank_id AS toRankId, outcome FROM rank_history ORDER BY id',
    )
    .all();
}

beforeEach(async () => {
  notify.mockReset();
  database = createTestDatabase();
  ladder = replaceRanks(
    database.sqlite,
    [
      { name: 'Neuling', requiredS: H, serverGroupId: 10 },
      { name: 'Stammgast', requiredS: 50 * H, serverGroupId: 11 },
    ],
    1,
  );
  server = new FakeTs3Server();
  connection = new Ts3Connection(
    server.createTransport,
    { commandsPerSecond: 1000, initialBackoffMs: 1, maxBackoffMs: 1, jitter: 0 },
    { logger: createSilentLogger() },
  );
  connection.start();
  await settle();
  job = new RankJob({
    database,
    connection,
    notifier: { notify },
    logger: createSilentLogger(),
    now: () => NOW,
  });
});

afterEach(async () => {
  job.stop();
  await connection.stop();
  database.close();
});

describe('RankJob', () => {
  it('only records decisions in dry-run mode (the default)', async () => {
    const alice = player('alice=', 101, 60, [8, 10]);
    online('alice=', 101, [8, 10]);
    const result = await job.run();
    expect(result).toMatchObject({ dryRun: true, full: true, checked: 1, changed: 1, commands: 0 });
    expect(server.groupCommands).toEqual([]);
    expect(history()).toEqual([
      { userId: alice, fromRankId: null, toRankId: ladder[1]?.id, outcome: 'dry_run' },
    ]);
  });

  it('changes only rank groups of online players and congratulates on promotion', async () => {
    saveRankSettings(database.db, { dryRun: false }, 1);
    const alice = player('alice=', 101, 60, [8, 10]);
    const clid = online('alice=', 101, [6, 8, 10, 99]);
    const result = await job.run();
    expect(result).toMatchObject({ dryRun: false, commands: 2, changed: 1, pending: 0 });
    expect(server.groupCommands).toEqual([
      { command: 'remove', dbid: 101, groupId: 10 },
      { command: 'add', dbid: 101, groupId: 11 },
    ]);
    expect(server.clients.get(clid)?.serverGroups).toEqual([6, 8, 99, 11]);
    expect(history()).toEqual([
      { userId: alice, fromRankId: null, toRankId: ladder[1]?.id, outcome: 'applied' },
    ]);
    expect(server.moderation).toEqual([
      { command: 'message', clid, text: 'Glückwunsch! Du hast den Rang „Stammgast“ erreicht.' },
    ]);
    expect(notify).toHaveBeenCalledWith('rank.promoted', expect.stringContaining('Stammgast'));
  });

  it('never touches groups that are not in the ladder', async () => {
    saveRankSettings(database.db, { dryRun: false }, 1);
    player('bob=', 102, 0.5, [6, 8]);
    player('carol=', 103, 10, [6, 11, 12, 13]);
    online('bob=', 102, [6, 8, 10, 11]);
    online('carol=', 103, [6, 11, 12, 13]);
    await job.run();
    for (const cmd of server.groupCommands) expect([10, 11]).toContain(cmd.groupId);
    expect(server.groupCommands).toEqual([
      // bob is below the lowest rank: both rank groups go, 6 and 8 stay.
      { command: 'remove', dbid: 102, groupId: 10 },
      { command: 'remove', dbid: 102, groupId: 11 },
      // carol has 10 h: rank 1; groups 6, 12 and 13 stay.
      { command: 'remove', dbid: 103, groupId: 11 },
      { command: 'add', dbid: 103, groupId: 10 },
    ]);
  });

  it('marks offline players pending and applies the rank on their next join', async () => {
    saveRankSettings(database.db, { dryRun: false }, 1);
    const dave = player('dave=', 104, 60, [8]);
    expect(await job.run()).toMatchObject({ pending: 1, commands: 0 });
    expect(history()).toEqual([
      { userId: dave, fromRankId: null, toRankId: ladder[1]?.id, outcome: 'pending' },
    ]);
    // Next join (the watcher calls the listener with the join event).
    const clid = online('dave=', 104, [8, 10]);
    job.onJoined(
      {
        clid,
        uid: 'dave=',
        userId: dave,
        sessionId: 1,
        nickname: 'dave',
        channelId: 1,
        joinedAt: NOW,
      },
      { ...(server.clients.get(clid) as Ts3Client), serverGroups: [8, 10] },
    );
    await job.idle();
    expect(server.groupCommands).toEqual([
      { command: 'remove', dbid: 104, groupId: 10 },
      { command: 'add', dbid: 104, groupId: 11 },
    ]);
    expect(
      database.sqlite.prepare('SELECT pending FROM rank_state WHERE user_id = ?').pluck().get(dave),
    ).toBe(0);
  });

  it('skips excluded groups and runs incrementally without config changes', async () => {
    saveRankSettings(database.db, { dryRun: false, excludedGroupIds: [6] }, 1);
    player('admin=', 105, 500, [6]);
    online('admin=', 105, [6]);
    const first = await job.run();
    expect(first).toMatchObject({ full: true, checked: 0, commands: 0 });
    const second = await job.run();
    expect(second.full).toBe(false);
    saveRankSettings(database.db, { dryRun: false, excludedGroupIds: [] }, 1);
    expect((await job.run()).full).toBe(true);
    expect(server.groupCommands).toEqual([{ command: 'add', dbid: 105, groupId: 11 }]);
  });

  it('does nothing without ranks or connection', async () => {
    replaceRanks(database.sqlite, [], 1);
    expect(await job.run()).toMatchObject({ skipped: 'no_ranks' });
    replaceRanks(database.sqlite, [{ name: 'A', requiredS: 0, serverGroupId: 10 }], 1);
    await connection.stop();
    expect(await job.run()).toMatchObject({ skipped: 'not_connected' });
  });
});
