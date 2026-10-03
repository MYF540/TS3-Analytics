import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { createTestDatabase } from '../db/testing.js';
import { createSilentLogger } from '../logging/logger.js';
import { CLIENT_TYPE_REGULAR, MOVE_REASON_MOVED, type Ts3Client } from '../ts3/types.js';
import { SessionTracker } from '../watcher/tracker.js';
import { AutomationHost, type BotModule } from './host.js';

const NOW = 1_789_800_000;

let database: AppDatabase;
let tracker: SessionTracker;
let host: AutomationHost;
let events: unknown[];

function client(clid: number, changes: Partial<Ts3Client> = {}): Ts3Client {
  return {
    clid,
    dbid: clid + 100,
    uid: `uid-${String(clid)}`,
    nickname: `Player${String(clid)}`,
    type: CLIENT_TYPE_REGULAR,
    channelId: 1,
    idleMs: 0,
    away: false,
    inputMuted: false,
    outputMuted: false,
    serverGroups: [8],
    platform: 'Windows',
    version: '3.6.2',
    country: 'DE',
    ...changes,
  };
}

const recorder: BotModule = {
  id: 'nickname',
  onJoin: (c, info) => {
    events.push(['join', c.nickname, c.dbid, [...c.serverGroups], info.discovered]);
  },
  onNickname: (c, previous) => {
    events.push(['nickname', previous, c.nickname]);
  },
  onMoved: (c, previous, cause) => {
    events.push(['moved', previous, c.channelId, cause?.reasonId, cause?.invokerClid]);
  },
  onLeft: (c) => {
    events.push(['left', c.nickname]);
  },
};

beforeEach(() => {
  database = createTestDatabase();
  tracker = new SessionTracker(database, createSilentLogger());
  host = new AutomationHost(createSilentLogger());
  tracker.addListener(host);
  host.register(recorder);
  events = [];
});

afterEach(() => {
  database.close();
});

describe('AutomationHost', () => {
  it('reports joins, moves with their cause and leaves', () => {
    tracker.join(client(1), NOW);
    tracker.move(1, 5, NOW + 1, { reasonId: MOVE_REASON_MOVED, invokerClid: 7 });
    tracker.leave(1, NOW + 2);
    expect(events).toEqual([
      ['join', 'Player1', 101, [8], false],
      ['moved', 1, 5, MOVE_REASON_MOVED, 7],
      ['left', 'Player1'],
    ]);
    expect(host.online).toEqual([]);
  });

  it('marks clients found by a sync as discovered', () => {
    tracker.sync([client(1)], NOW);
    expect(events).toEqual([['join', 'Player1', 101, [8], true]]);
  });

  it('notices a new nickname, a move and new server groups on the next sync', () => {
    tracker.join(client(1), NOW);
    events = [];
    tracker.sync([client(1, { nickname: 'Admin', channelId: 3, serverGroups: [8, 20] })], NOW + 60);
    expect(events).toEqual([
      ['nickname', 'Player1', 'Admin'],
      ['moved', 1, 3, undefined, undefined],
    ]);
    expect(host.get(1)).toMatchObject({ nickname: 'Admin', channelId: 3, serverGroups: [8, 20] });
  });

  it('keeps going when a module throws or rejects', async () => {
    const error = vi.fn();
    host = new AutomationHost({ ...createSilentLogger(), error } as never);
    tracker = new SessionTracker(database, createSilentLogger());
    tracker.addListener(host);
    host.register({
      id: 'spam',
      onJoin: () => {
        throw new Error('kaputt');
      },
      onLeft: () => Promise.reject(new Error('auch kaputt')),
    });
    host.register(recorder);

    tracker.join(client(1), NOW);
    tracker.leave(1, NOW + 1);
    await host.idle();

    expect(events).toEqual([
      ['join', 'Player1', 101, [8], false],
      ['left', 'Player1'],
    ]);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('waits for asynchronous hooks in idle()', async () => {
    let done = false;
    host.register({
      id: 'rules',
      onJoin: async () => {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        done = true;
      },
    });
    tracker.join(client(1), NOW);
    expect(done).toBe(false);
    await host.idle();
    expect(done).toBe(true);
  });
});
